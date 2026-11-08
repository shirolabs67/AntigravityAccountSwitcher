import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { startBroker } from './broker-fixture.mjs';

test('Rust broker binds identity to the client certificate and forwards ACP over loopback', { timeout: 30_000 }, async t => {
  const broker = await startBroker(t, {
    accounts: ['a'], extraAccounts: ['rogue'], instances: { 'dsh-a': 43101 }, modelGroups: { model: 'group' },
  });
  await assert.rejects(async () => {
    const rogue = await broker.link('worker', 'rogue');
    await rogue.request('broker/ready', { id: 'dsh-a' });
  }, /disconnected|ECONNRESET/);

  let probes = 0;
  const worker = await broker.link('worker', 'a', (method, args) => {
    assert.equal(method, 'worker/probe');
    assert.equal(args.groupId, 'group');
    probes++;
    return { weekly: 0.55, fiveHour: 0.05 };
  });
  assert.equal(await worker.request('broker/ready', {}), true);
  const duplicate = await broker.link('worker', 'a');
  await assert.rejects(duplicate.request('broker/ready', {}), /duplicate_worker/);
  duplicate.close();

  const launch = await broker.ingress('dsh-a');
  const ingress = launch();
  const responses = createInterface({ input: ingress.stdout })[Symbol.asyncIterator]();
  const request = async (id, method, params) => {
    ingress.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const line = await responses.next();
    assert.equal(line.done, false, ingress.stderrTail());
    const frame = JSON.parse(line.value);
    assert.equal(frame.id, id);
    return frame;
  };
  const hello = await request(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.equal(hello.result._meta.antigravityAccountSwitcher.version, 1);
  assert.notEqual(hello.result._meta.antigravityAccountSwitcher.switchAccount, true);
  const acquire = await request(2, '_antigravityAccountSwitcher/acquireTurn', { chatKey: '测试', model: 'model' });
  assert.equal(acquire.result.status, 'selected');
  assert.equal(acquire.result.accountId, 'a');
  assert.equal(probes, 1);
  const release = await request(3, '_antigravityAccountSwitcher/releaseTurn', { leaseId: acquire.result.leaseId });
  assert.ok('result' in release);
  const denied = await request(4, '_antigravityAccountSwitcher/acquireTurn', {
    chatKey: '测试', model: 'model', _meta: { antigravityAccountSwitcher: { switchAccount: true } },
  });
  assert.equal(denied.error?.data?.kind, 'account_switch_disabled');
  assert.equal(probes, 1);
  ingress.terminate();
  assert.equal((await ingress.exited).code, 0);
});

test('Rust ingress rejects an otherwise trusted server with a mismatched fingerprint', { timeout: 30_000 }, async t => {
  const broker = await startBroker(t, {
    accounts: ['a'], instances: { 'dsh-a': 43101 }, modelGroups: { model: 'group' },
  });
  const launch = await broker.ingress('dsh-a', '0'.repeat(64));
  const ingress = launch();
  let stdout = '';
  ingress.stdout.on('data', data => { stdout += data; });
  assert.equal((await ingress.exited).code, 1);
  assert.match(ingress.stderrTail(), /invalid_server_fingerprint/);
  assert.equal(stdout, '');
});
