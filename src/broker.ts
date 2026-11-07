import { randomUUID } from 'node:crypto';
import { createServer, type TLSSocket } from 'node:tls';
import { Router } from './router.js';
import type { JsonObject, WorkerDirectory, WorkerStream } from './router-types.js';
import { fingerprint, type BrokerConfig } from './config.js';
import { object, Peer, PeerError } from './wire.js';

type AttachedWorker = { peer: Peer; streams: Map<string, RemoteStream> };
const MAX_STREAMS_PER_WORKER = 100;

class RemoteStream implements WorkerStream {
  private ended = false;
  private pending: JsonObject[] = [];
  private receiveFrame?: (frame: JsonObject) => void;
  private receiveClose?: () => void;

  constructor(
    private readonly worker: AttachedWorker,
    private readonly id: string,
  ) {}

  send(frame: JsonObject): void {
    if (this.ended) throw new PeerError('stream_disconnected');
    this.worker.peer.notify('worker/send', { streamId: this.id, frame });
  }

  frame(frame: JsonObject): void {
    if (this.ended) return;
    if (this.receiveFrame) this.receiveFrame(frame);
    else if (this.pending.length < 4) this.pending.push(frame);
    else this.close();
  }

  onFrame(listener: (frame: JsonObject) => void): void {
    this.receiveFrame = listener;
    for (const frame of this.pending) listener(frame);
    this.pending = [];
  }

  onClose(listener: () => void): void {
    this.receiveClose = listener;
    if (this.ended) listener();
  }

  close(): void {
    if (this.ended) return;
    try { this.worker.peer.notify('worker/close', { streamId: this.id }); } catch { /* already offline */ }
    this.disconnect();
  }

  disconnect(): void {
    if (this.ended) return;
    this.ended = true;
    this.pending = [];
    this.worker.streams.delete(this.id);
    this.receiveClose?.();
  }
}

class Workers implements WorkerDirectory {
  private readonly attached = new Map<string, AttachedWorker>();

  attach(id: string, worker: AttachedWorker): void {
    if (this.attached.has(id)) throw new PeerError('duplicate_worker');
    this.attached.set(id, worker);
  }

  detach(id: string, worker: AttachedWorker): void {
    if (this.attached.get(id) === worker) this.attached.delete(id);
    for (const stream of worker.streams.values()) stream.disconnect();
  }

  async probe(accountId: string, groupId: string): Promise<{ weekly: number; fiveHour: number }> {
    const worker = this.attached.get(accountId);
    if (!worker) throw new PeerError('worker_offline');
    const reply = object(await worker.peer.request('worker/probe', { groupId }, 32_000));
    if (typeof reply?.weekly !== 'number' || typeof reply.fiveHour !== 'number') {
      throw new PeerError('invalid_quota');
    }
    return { weekly: reply.weekly, fiveHour: reply.fiveHour };
  }

  async open(accountId: string): Promise<WorkerStream> {
    const worker = this.attached.get(accountId);
    if (!worker) throw new PeerError('worker_offline');
    if (worker.streams.size >= MAX_STREAMS_PER_WORKER) throw new PeerError('worker_busy');
    const id = randomUUID();
    const stream = new RemoteStream(worker, id);
    worker.streams.set(id, stream);
    try {
      await worker.peer.request('worker/open', { streamId: id }, 10_000);
      if (!worker.streams.has(id)) throw new PeerError('stream_disconnected');
      return stream;
    } catch (error) {
      stream.close();
      throw error;
    }
  }
}

export function runBroker(config: BrokerConfig) {
  const workers = new Workers();
  const router = new Router(config.routing, workers);
  const ingress = new Map<string, Peer>();
  const sockets = new Set<TLSSocket>();
  const server = createServer({ ...config.tls, handshakeTimeout: 8_000 }, socket => {
    const pin = fingerprint(socket.getPeerCertificate().fingerprint256);
    const identity = socket.authorized && pin ? config.fingerprints.get(pin) : undefined;
    if (!identity) { socket.destroy(); return; }
    sockets.add(socket);
    socket.setKeepAlive(true, 15_000);
    let attachment: AttachedWorker | undefined;
    let client: ReturnType<Router['connect']> | undefined;
    const readyTimeout = setTimeout(() => socket.destroy(), 5_000);
    readyTimeout.unref();
    const peer = new Peer(socket, async (method, params) => {
      if (method === 'broker/ready') {
        if (attachment || client) throw new PeerError('already_ready');
        if (identity.role === 'worker') {
          const worker: AttachedWorker = { peer, streams: new Map() };
          workers.attach(identity.id, worker);
          attachment = worker;
        } else {
          if (ingress.has(identity.id)) throw new PeerError('duplicate_instance');
          client = router.connect(identity.id, frame => {
            try { peer.notify('acp/frame', { frame }); } catch { peer.close(); }
          });
          ingress.set(identity.id, peer);
        }
        clearTimeout(readyTimeout);
        return true;
      }
      if (client && method === 'acp/frame') {
        const frame = object(params.frame);
        if (!frame) throw new PeerError('invalid_frame');
        await client.receive(frame);
        return;
      }
      if (attachment && typeof params.streamId === 'string') {
        const stream = attachment.streams.get(params.streamId);
        if (method === 'worker/frame') {
          const frame = object(params.frame);
          if (!frame) throw new PeerError('invalid_frame');
          stream?.frame(frame);
          return;
        }
        if (method === 'worker/closed') {
          stream?.disconnect();
          return;
        }
      }
      throw new PeerError('unknown_operation');
    }, () => {
      clearTimeout(readyTimeout);
      sockets.delete(socket);
      if (attachment) workers.detach(identity.id, attachment);
      if (client) {
        if (ingress.get(identity.id) === peer) ingress.delete(identity.id);
        client.close();
      }
    });
  });
  server.on('tlsClientError', () => {}); // No remote-controlled diagnostics.
  server.maxConnections = 128;
  server.listen(config.port, '127.0.0.1');
  const stop = () => {
    for (const socket of sockets) socket.destroy();
    server.close();
  };
  return { server, stop };
}
