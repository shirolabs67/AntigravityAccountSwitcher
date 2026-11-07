import type { JsonObject, WorkerStream } from './router-types.js';

export type RpcId = string | number;

export function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

export function rpcId(value: unknown): RpcId | undefined {
  return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))
    ? value
    : undefined;
}

export class RpcFault extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }

  frame(id: RpcId | null): JsonObject {
    const error: JsonObject = { code: this.code, message: this.message };
    if (this.data !== undefined) error.data = this.data;
    return { jsonrpc: '2.0', id, error };
  }
}

export class WorkerDisconnected extends Error {}
export class WorkerRequestTimeout extends Error {}

const MAX_LATE_REPLIES = 64;

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  signal?: AbortSignal;
  timer?: ReturnType<typeof setTimeout>;
  onAbort(): void;
}

/** One native ACP endpoint, with independent outgoing request numbers. */
export class AcpBackend {
  #sequence = 0;
  #closed = false;
  #pending = new Map<number, Pending>();
  #lateResults = new Map<number, (result: unknown) => void>();

  constructor(
    private readonly stream: WorkerStream,
    onFrame: (frame: JsonObject) => void,
    private readonly onExit: () => void,
  ) {
    stream.onFrame(frame => {
      if (this.#closed || frame.jsonrpc !== '2.0') return;
      if (typeof frame.method === 'string') {
        onFrame(frame);
        return;
      }
      if (typeof frame.id !== 'number') return;
      const pending = this.#pending.get(frame.id);
      if (!pending) {
        const onLateResult = this.#lateResults.get(frame.id);
        this.#lateResults.delete(frame.id);
        if (onLateResult && !Object.hasOwn(frame, 'error') && Object.hasOwn(frame, 'result')) {
          onLateResult(frame.result);
        }
        return;
      }
      this.#remove(frame.id, pending);
      const error = object(frame.error);
      if (error && typeof error.code === 'number' && typeof error.message === 'string') {
        pending.reject(new RpcFault(error.code, error.message, error.data));
      } else if (Object.hasOwn(frame, 'result')) {
        pending.resolve(frame.result);
      } else {
        pending.reject(new RpcFault(-32603, 'Invalid ACP worker response'));
      }
    });
    stream.onClose(() => this.#end());
  }

  get closed(): boolean {
    return this.#closed;
  }

  request(
    method: string, params: JsonObject, signal?: AbortSignal, timeoutMs?: number,
    onLateResult?: (result: unknown) => void,
  ): Promise<unknown> {
    if (this.#closed) return Promise.reject(new WorkerDisconnected());
    if (signal?.aborted) return Promise.reject(new RpcFault(-32800, 'Request cancelled'));
    return new Promise((resolve, reject) => {
      const id = ++this.#sequence;
      const onAbort = () => this.notify('$/cancel_request', { requestId: id });
      const pending: Pending = { resolve, reject, onAbort, ...(signal ? { signal } : {}) };
      this.#pending.set(id, pending);
      if (timeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          this.#remove(id, pending);
          if (onLateResult) {
            const oldest = this.#lateResults.keys().next().value;
            if (this.#lateResults.size >= MAX_LATE_REPLIES && oldest !== undefined) this.#lateResults.delete(oldest);
            this.#lateResults.set(id, onLateResult);
          }
          this.notify('$/cancel_request', { requestId: id });
          reject(new WorkerRequestTimeout());
        }, timeoutMs);
        pending.timer.unref();
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#send({ jsonrpc: '2.0', method, id, params });
    });
  }

  notify(method: string, params: JsonObject): void {
    this.#send({ jsonrpc: '2.0', method, params });
  }

  respond(id: RpcId, frame: JsonObject): void {
    this.#send({ ...frame, jsonrpc: '2.0', id });
  }

  close(): void {
    if (this.#closed) return;
    this.#end();
    try { this.stream.close(); } catch { /* local routing state is already closed */ }
  }

  #send(frame: JsonObject): void {
    if (this.#closed) return;
    try {
      this.stream.send(frame);
    } catch {
      this.close();
    }
  }

  #remove(id: number, pending: Pending): void {
    this.#pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.signal?.removeEventListener('abort', pending.onAbort);
  }

  #end(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#lateResults.clear();
    for (const [id, pending] of this.#pending) {
      this.#remove(id, pending);
      pending.reject(new WorkerDisconnected());
    }
    this.onExit();
  }
}
