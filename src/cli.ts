import { userInfo } from 'node:os';
import { connect, type ConnectionOptions, type TLSSocket } from 'node:tls';
import { runBroker } from './broker.js';
import { brokerConfig, ingressConfig, workerConfig } from './config.js';
import { AccountWorker, validateWorkerWorkspace, WorkerError } from './worker.js';
import { Lines, object, Peer, PeerError } from './wire.js';

function tlsConnect(options: ConnectionOptions): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = connect(options);
    const timeout = setTimeout(() => socket.destroy(new PeerError('broker_timeout')), 8_000);
    socket.on('error', () => {
      clearTimeout(timeout);
      reject(new PeerError('broker_connection_failed'));
    });
    socket.once('secureConnect', () => {
      clearTimeout(timeout);
      socket.setKeepAlive(true, 15_000);
      resolve(socket);
    });
    socket.once('close', () => {
      clearTimeout(timeout);
      reject(new PeerError('broker_connection_failed'));
    });
  });
}

function terminate(stop: () => void): void {
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

async function worker(configPath: string): Promise<void> {
  const config = await workerConfig(configPath);
  const actual = userInfo().username;
  const sameUser = process.platform === 'win32'
    ? actual.toLowerCase() === config.runAsUser.toLowerCase()
    : actual === config.runAsUser;
  if (!sameUser || process.getuid?.() === 0) throw new PeerError('wrong_worker_user');
  try { await validateWorkerWorkspace(config.cwd); }
  catch { throw new PeerError('agent_missing'); }
  const runtime = new AccountWorker(config);
  let stopping = false;
  const socket = await tlsConnect(config.tls);
  const peer = new Peer(socket, async (method, params) => {
    try {
      if (method === 'worker/probe' && typeof params.groupId === 'string') return await runtime.probe(params.groupId);
      const id = params.streamId;
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new PeerError('invalid_stream_id');
      if (method === 'worker/open') {
        await runtime.open(id, frame => {
          try { peer.notify('worker/frame', { streamId: id, frame }); } catch { peer.close(); }
        }, () => {
          try { peer.notify('worker/closed', { streamId: id }); } catch { peer.close(); }
        });
      } else if (method === 'worker/send') {
        const frame = object(params.frame);
        if (!frame) throw new PeerError('invalid_frame');
        try { runtime.send(id, frame); } catch {
          runtime.close(id);
          peer.notify('worker/closed', { streamId: id });
        }
      } else if (method === 'worker/close') runtime.close(id);
      else throw new PeerError('unknown_operation');
    } catch (error) {
      if (error instanceof WorkerError) throw new PeerError(error.code.replaceAll('-', '_'));
      throw error;
    }
  }, () => {
    runtime.closeAll();
    if (!stopping) process.exitCode = 1;
  });
  terminate(() => { stopping = true; peer.close(); });
  try {
    await peer.request('broker/ready', {}, 5_000);
    process.stderr.write('Account worker connected.\n');
  } catch (error) {
    peer.close();
    throw error;
  }
}

async function ingress(configPath: string): Promise<void> {
  const config = await ingressConfig(configPath);
  const socket = await tlsConnect(config.tls);
  let stdio: Lines | undefined;
  const peer = new Peer(socket, (method, params) => {
    const frame = object(params.frame);
    if (method !== 'acp/frame' || !frame || !stdio) throw new PeerError('invalid_frame');
    stdio.send(frame);
  }, () => {
    stdio?.close();
  });
  try {
    await peer.request('broker/ready', {}, 5_000);
    stdio = new Lines(process.stdin, process.stdout, frame => {
      peer.notify('acp/frame', { frame });
    }, () => peer.close(), () => { process.stdin.pause(); });
    terminate(() => stdio?.close());
  } catch (error) {
    peer.close();
    throw error;
  }
}

async function main(): Promise<void> {
  const [mode, file, ...extra] = process.argv.slice(2);
  if (!file || extra.length || !['serve', 'worker', 'ingress'].includes(mode ?? '')) {
    process.stderr.write('Usage: node dist/cli.js <serve|worker|ingress> <local-config.json>\n');
    process.exitCode = 2;
    return;
  }
  if (mode === 'serve') {
    const { server, stop } = runBroker(await brokerConfig(file));
    server.on('error', () => {
      process.stderr.write('Router listen failed.\n');
      process.exitCode = 1;
      stop();
    });
    server.once('listening', () => process.stderr.write('Router listening on loopback.\n'));
    terminate(stop);
  } else if (mode === 'worker') await worker(file);
  else await ingress(file);
}

void main().catch((error: unknown) => {
  const category = error instanceof PeerError ? error.category : 'startup_failed';
  process.stderr.write('Antigravity Account Switcher: ' + category + '\n');
  process.exitCode = 1;
});
