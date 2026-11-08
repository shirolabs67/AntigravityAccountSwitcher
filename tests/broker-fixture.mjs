import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { connect } from 'node:tls';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const binary = resolve(process.env.AAS_BIN ?? join(root, 'target', 'debug', process.platform === 'win32' ? 'aas.exe' : 'aas'));

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
  return port;
}

async function link(socket, handle) {
  let nextId = 0;
  const pending = new Map();
  socket.on('error', () => {});
  socket.once('close', () => {
    for (const request of pending.values()) request.reject(new Error('disconnected'));
    pending.clear();
  });
  const send = frame => socket.write(JSON.stringify(frame) + '\n');
  const lines = createInterface({ input: socket });
  lines.on('line', async line => {
    const { id, method, params, result, error } = JSON.parse(line);
    if (method) {
      try {
        const reply = await handle(method, params);
        if (id !== undefined) send({ id, result: reply ?? null });
      } catch (error) {
        if (id !== undefined) send({ id, error: 'fixture_failed' });
        socket.destroy(error);
      }
    } else if (pending.has(id)) {
      const request = pending.get(id);
      pending.delete(id);
      if (error) request.reject(new Error(error));
      else request.resolve(result);
    }
  });
  await once(socket, 'secureConnect');
  return {
    notify: (method, params) => send({ method, params }),
    async request(method, params) {
      if (socket.destroyed) throw new Error('disconnected');
      const id = ++nextId;
      const reply = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      send({ id, method, params });
      return await reply;
    },
    close: () => socket.destroy(),
  };
}

export async function startBroker(t, { accounts, instances, modelGroups, extraAccounts = [], accountSwitchInstances = [] }) {
  const directory = await mkdtemp(join(tmpdir(), 'aas-test-tls-'));
  const pki = join(directory, 'bundles');
  const port = await availablePort();
  const sockets = new Set();
  const processes = new Map();
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    for (const child of processes.keys()) {
      child.stdin.end();
      child.kill();
    }
    await Promise.all(processes.values());
    await rm(directory, { recursive: true, force: true });
  });
  const args = [
    join(root, 'tools', 'new-local-certificates.mjs'), '--output', pki,
    '--openssl', process.env.AAS_OPENSSL || 'openssl',
    ...[...accounts, ...extraAccounts].flatMap(id => ['--account', id]),
    ...Object.keys(instances).flatMap(id => ['--instance', id]),
  ];
  const issued = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30_000 });
  assert.equal(issued.status, 0, issued.stderr || String(issued.error));
  const pins = JSON.parse(await readFile(join(pki, 'fingerprints.json'), 'utf8'));
  const certFiles = role => ({ key: 'pki/' + role + '.key.pem', cert: 'pki/' + role + '.cert.pem', ca: 'pki/ca.cert.pem' });
  async function config(role, alias, contents) {
    const file = join(pki, alias, 'config.json');
    await writeFile(file, JSON.stringify({ port, tls: certFiles(role), ...contents }));
    return file;
  }
  const routerConfig = await config('router', 'router', {
    accounts: accounts.map(id => ({ id, fingerprint256: pins.workers[id] })),
    instances: Object.fromEntries(Object.entries(instances).map(([id, mcpPort]) => [id, {
      mcpPort,
      fingerprint256: pins.ingress[id],
      ...(accountSwitchInstances.includes(id) ? { allowAccountSwitch: true } : {}),
    }])),
    modelGroups,
  });
  function launch(mode, path) {
    const child = spawn(binary, [mode, path], { windowsHide: true, stdio: 'pipe' });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', data => { stderr = (stderr + data).slice(-2048); });
    // The error listener is also needed if the binary fails before spawning.
    child.on('error', error => { stderr += String(error); });
    const exited = new Promise(done => child.once('close', (code, signal) => {
      processes.delete(child);
      done({ code, signal });
    }));
    processes.set(child, exited);
    return { child, exited, stderrTail: () => stderr };
  }
  const router = launch('serve', routerConfig);
  const ready = createInterface({ input: router.child.stderr });
  const status = await Promise.race([
    once(ready, 'line').then(([line]) => line),
    router.exited.then(() => router.stderrTail()),
  ]);
  ready.close();
  assert.match(status, /^Router listening on loopback\./);

  return {
    async link(role, id, handle = () => null) {
      const base = join(pki, role + '-' + id);
      const tls = Object.fromEntries(await Promise.all(Object.entries(certFiles(role)).map(async ([key, path]) => [
        key, await readFile(join(base, path)),
      ])));
      const socket = connect({ ...tls, host: '127.0.0.1', port, servername: pins.serverName, minVersion: 'TLSv1.3' });
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      return link(socket, handle);
    },
    async ingress(id, serverFingerprint256 = pins.router) {
      const file = await config('ingress', 'ingress-' + id, {
        tls: { ...certFiles('ingress'), serverName: pins.serverName, serverFingerprint256 },
      });
      return () => {
        const { child, exited, stderrTail } = launch('ingress', file);
        return { stdin: child.stdin, stdout: child.stdout, exited, terminate: () => child.stdin.end(), stderrTail };
      };
    },
  };
}
