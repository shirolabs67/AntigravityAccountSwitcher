import { Buffer } from 'node:buffer';
import type { Readable, Writable } from 'node:stream';
import type { JsonObject } from './router-types.js';

export const MAX_FRAME = 8 * 1024 * 1024;
const MAX_PENDING = 512;
const decoder = new TextDecoder('utf-8', { fatal: true });

export function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : undefined;
}

/** One bounded, strict UTF-8 JSON object per line. Never logs its contents. */
export class Lines {
  private stopped = false;
  private size = 0;
  private parts: Buffer[] = [];

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly onFrame: (frame: JsonObject) => void,
    private readonly onClose: () => void,
    private readonly teardown: () => void,
  ) {
    input.on('data', this.data);
    input.once('end', this.close);
    input.once('close', this.close);
    input.on('error', this.close);
    if (output !== input as unknown) {
      output.once('close', this.close);
      output.on('error', this.close);
    }
  }

  private data = (chunk: Buffer): void => {
    try {
      if (!Buffer.isBuffer(chunk)) throw new Error('Expected raw input bytes');
      for (let start = 0; start < chunk.length && !this.stopped;) {
        const newline = chunk.indexOf(10, start);
        const end = newline === -1 ? chunk.length : newline;
        const length = end - start;
        if (length) {
          this.size += length;
          if (this.size > MAX_FRAME) throw new Error('Frame exceeds limit');
          this.parts.push(chunk.subarray(start, end));
        }
        if (newline === -1) break;
        const bytes = this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts, this.size);
        this.parts = [];
        this.size = 0;
        const frame = object(JSON.parse(decoder.decode(bytes)));
        if (!frame) throw new Error('Expected a JSON object');
        this.onFrame(frame);
        start = end + 1;
      }
    } catch {
      this.close();
    }
  };

  send(frame: JsonObject): void {
    if (this.stopped) throw new Error('Channel closed');
    const line = Buffer.from(JSON.stringify(frame) + '\n', 'utf8');
    if (line.length > MAX_FRAME + 1 || this.output.writableLength + line.length > MAX_FRAME * 2) {
      this.close();
      throw new Error('Outgoing frames exceed limit');
    }
    try {
      this.output.write(line);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close = (): void => {
    if (this.stopped) return;
    this.stopped = true;
    this.parts = [];
    this.input.off('data', this.data);
    try {
      this.teardown();
    } finally {
      this.onClose();
    }
  };
}

type Pending = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type Handler = (method: string, params: JsonObject) => unknown | Promise<unknown>;

export class PeerError extends Error {
  constructor(readonly category: string) {
    super(category);
  }
}

function safeCategory(error: unknown): string {
  if (error instanceof PeerError && /^[a-z][a-z0-9_]{0,47}$/.test(error.category)) return error.category;
  return 'operation_failed';
}

/** Host-internal request/response framing; ACP frames are carried as opaque objects. */
export class Peer {
  private readonly lines: Lines;
  private readonly pending = new Map<number, Pending>();
  private sequence = 0;
  private active = 0;

  constructor(
    socket: Readable & Writable & { destroy(): void },
    private readonly handle: Handler,
    onClose: () => void,
  ) {
    this.lines = new Lines(socket, socket, frame => { void this.receive(frame); }, () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new PeerError('disconnected'));
      }
      this.pending.clear();
      onClose();
    }, () => { socket.destroy(); });
  }

  private async receive(frame: JsonObject): Promise<void> {
    try {
      if (typeof frame.method === 'string') {
        const params = object(frame.params);
        if (!params || this.active >= MAX_PENDING) { this.close(); return; }
        if (frame.id !== undefined && (!Number.isSafeInteger(frame.id) || Number(frame.id) < 1)) {
          this.close();
          return;
        }
        this.active++;
        try {
          const result = await this.handle(frame.method, params);
          if (frame.id !== undefined) this.lines.send({ id: frame.id, result: result ?? null });
        } catch (error) {
          if (frame.id === undefined) { this.close(); return; }
          this.lines.send({ id: frame.id, error: safeCategory(error) });
        } finally {
          this.active--;
        }
        return;
      }
      if (typeof frame.id !== 'number' || !Number.isSafeInteger(frame.id)) { this.close(); return; }
      const pending = this.pending.get(frame.id);
      if (!pending) return; // A bounded request may have timed out.
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (typeof frame.error === 'string' && /^[a-z][a-z0-9_]{0,47}$/.test(frame.error)) {
        pending.reject(new PeerError(frame.error));
      } else if ('result' in frame) {
        pending.resolve(frame.result);
      } else {
        pending.reject(new PeerError('invalid_response'));
        this.close();
      }
    } catch {
      this.close();
    }
  }

  request(method: string, params: JsonObject, timeoutMs = 30_000): Promise<unknown> {
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new PeerError('too_many_requests'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PeerError('timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.lines.send({ id, method, params });
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new PeerError('disconnected'));
      }
    });
  }

  notify(method: string, params: JsonObject): void {
    this.lines.send({ method, params });
  }

  close(): void { this.lines.close(); }
}
