import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import test from 'node:test';
import { runBroker } from '../dist/broker.js';
import { fingerprint } from '../dist/config.js';
import { Peer } from '../dist/wire.js';

const openssl = process.env.AAS_OPENSSL || 'openssl';
const canRun = spawnSync(openssl, ['version'], { stdio: 'ignore' }).status === 0;

test('broker binds identity to the client certificate and forwards ACP over authenticated loopback', {
  skip: !canRun && 'Set AAS_OPENSSL to an OpenSSL executable for this test',
  timeout: 30_000,
}, async t => {
  const home = await mkdtemp(join(tmpdir(), 'aas-test-tls-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const issue = (...args) => {
    const result = spawnSync(openssl, args, { cwd: home, stdio: 'ignore', timeout: 8_000 });
    assert.equal(result.status, 0, 'Failed to create temporary TLS fixture');
  };
  issue('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '2', '-subj', '/CN=Local Integration CA');
  async function leaf(name, isServer = false) {
    issue('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
      '-keyout', name + '.key', '-out', name + '.csr', '-subj', '/CN=' + name);
    await writeFile(join(home, name + '.ext'), isServer
      ? 'extendedKeyUsage=serverAuth\nsubjectAltName=DNS:' + name + '\n'
      : 'extendedKeyUsage=clientAuth\n');
    issue('x509', '-req', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '2',
      '-in', name + '.csr', '-out', name + '.crt', '-extfile', name + '.ext');
    const cert = await readFile(join(home, name + '.crt'));
    return { key: await readFile(join(home, name + '.key')), cert, pin: fingerprint(new X509Certificate(cert).fingerprint256) };
  }
  const serverName = 'aas-test.local';
  const serverTls = await leaf(serverName, true);
  const workerTls = await leaf('worker-fixture');
  const ingressTls = await leaf('ingress-fixture');
  const unknownTls = await leaf('unknown-fixture');
  const ca = await readFile(join(home, 'ca.crt'));
  const { server, stop } = runBroker({
    port: 0,
    tls: { ...serverTls, ca, minVersion: 'TLSv1.3', requestCert: true, rejectUnauthorized: true },
    fingerprints: new Map([
      [workerTls.pin, { role: 'worker', id: 'a' }],
      [ingressTls.pin, { role: 'ingress', id: 'dsh-a' }],
    ]),
    routing: { accounts: ['a'], instances: { 'dsh-a': { mcpPort: 43101 } }, modelGroups: { model: 'group' } },
  });
  t.after(stop);
  await once(server, 'listening');
  assert.equal(server.address().address, '127.0.0.1');
  const link = async (credentials, handle = () => null) => {
    const socket = connect({
      ...credentials, ca, host: '127.0.0.1', port: server.address().port, servername: serverName,
      rejectUnauthorized: true, minVersion: 'TLSv1.3',
    });
    const peer = new Peer(socket, handle, () => {});
    t.after(() => peer.close());
    await once(socket, 'secureConnect');
    return peer;
  };
  const rogue = await link(unknownTls);
  await assert.rejects(rogue.request('broker/ready', { id: 'dsh-a' }, 1000), /disconnected/);

  let probes = 0;
  const worker = await link(workerTls, (method, args) => {
    assert.equal(method, 'worker/probe');
    assert.equal(args.groupId, 'group');
    probes++;
    return { weekly: 0.55, fiveHour: 0.05 };
  });
  assert.equal(await worker.request('broker/ready', {}), true);
  const frames = new Map();
  const clients = await link(ingressTls, (method, args) => {
    assert.equal(method, 'acp/frame');
    const pending = frames.get(args.frame.id);
    assert.ok(pending);
    frames.delete(args.frame.id);
    pending(args.frame);
  });
  assert.equal(await clients.request('broker/ready', { id: 'forged-client-id' }), true);
  await assert.rejects(clients.request('worker/probe', { groupId: 'group' }), /unknown_operation/);

  const request = (id, method, params) => new Promise(resolve => {
    frames.set(id, resolve);
    clients.notify('acp/frame', { frame: { jsonrpc: '2.0', id, method, params } });
  });
  const hello = await request(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.equal(hello.result._meta.antigravityAccountSwitcher.version, 1);
  const acquire = await request(2, '_antigravityAccountSwitcher/acquireTurn', { chatKey: '测试', model: 'model' });
  assert.equal(acquire.result.status, 'selected');
  assert.equal(acquire.result.accountId, 'a');
  assert.equal(probes, 1);
  const release = await request(3, '_antigravityAccountSwitcher/releaseTurn', { leaseId: acquire.result.leaseId });
  assert.ok('result' in release);
});
