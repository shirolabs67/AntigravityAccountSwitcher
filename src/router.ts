import { randomUUID } from 'node:crypto';
import { AcpBackend, object, rpcId, RpcFault, WorkerDisconnected } from './acp-backend.js';
import type { RpcId } from './acp-backend.js';
import type { JsonObject, RouterConfig, RouterConnection, WorkerDirectory } from './router-types.js';

const EXTENSION = 'antigravityAccountSwitcher';
const ACQUIRE = '_' + EXTENSION + '/acquireTurn';
const RELEASE = '_' + EXTENSION + '/releaseTurn';
const ACQUIRE_DEADLINE_MS = 110_000;
const INITIALIZE_DEADLINE_MS = 10_000;
const DISCONNECT_GRACE_MS = 30_000;
const CANCELLED_PERMISSION = { result: { outcome: { outcome: 'cancelled' } } };

type Generation = {
  id: string;
  accountId: string;
  leases: Set<Lease>;
  backends: Set<AcpBackend>;
  draining: boolean;
};

type Lease = {
  id: string;
  model: string;
  chatKey: string;
  generation: Generation | undefined;
  unlock: () => void;
  session: Session | undefined;
  opening: boolean;
  releasing: boolean;
  operations: number;
  permissions: number;
};

type BackendSlot = {
  promise: Promise<AcpBackend>;
  backend?: AcpBackend;
  sessions: Map<string, Session>;
  permissions: Map<RpcId, string>;
};

type Session = {
  id: string;
  nativeId: string;
  slot: BackendSlot | undefined;
  chatKey: string;
  generation: Generation | undefined;
  lease: Lease | undefined;
  modelId: string | undefined;
  modelConfigId: string | undefined;
  prompting: boolean;
  closing: boolean;
};

type Permission = {
  nativeId: RpcId;
  slot: BackendSlot;
  session: Session;
  lease: Lease;
};

function invalid(message: string): RpcFault {
  return new RpcFault(-32602, message);
}

function stale(message: string): RpcFault {
  return new RpcFault(-32042, message, { kind: 'stale_route' });
}

function cancelled(): RpcFault {
  return new RpcFault(-32800, 'Request cancelled');
}

function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled();
}

async function withCancellation<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  checkCancelled(signal);
  let onAbort: (() => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, abort]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function extensionMeta(params: JsonObject): JsonObject | undefined {
  return object(object(params._meta)?.[EXTENSION]);
}

function withoutExtension(params: JsonObject): JsonObject {
  const meta = object(params._meta);
  if (!meta || !Object.hasOwn(meta, EXTENSION)) return params;
  const { [EXTENSION]: _extension, ...remaining } = meta;
  const { _meta: _old, ...rest } = params;
  return Object.keys(remaining).length ? { ...rest, _meta: remaining } : rest;
}

function mcpServers(raw: unknown, port: number): JsonObject[] {
  if (!Array.isArray(raw) || raw.length > 1) throw invalid('Expected zero or one DSH MCP bridge');
  if (!raw.length) return [];
  const bridge = object(raw[0]);
  if (!bridge || bridge.type !== 'http' || bridge.name !== 'dsh' || typeof bridge.url !== 'string') {
    throw invalid('Only the DSH HTTP MCP bridge is supported');
  }
  // Match the pinned plugin's explicit local authority and per-session tenant path.
  const url = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})(\/mcp\/[\da-f]{32})$/.exec(bridge.url);
  const headers = bridge.headers;
  const authorization = Array.isArray(headers) && headers.length === 1 ? object(headers[0]) : undefined;
  if (!url || Number(url[1]) > 65535 || !authorization ||
      typeof authorization.name !== 'string' || authorization.name.toLowerCase() !== 'authorization' ||
      typeof authorization.value !== 'string' || !/^Bearer [\da-f]{48}$/.test(authorization.value)) {
    throw invalid('Invalid DSH MCP bridge address or authorization format');
  }
  return [{ type: 'http', name: 'dsh', url: 'http://127.0.0.1:' + port + url[2], headers }];
}

function quotaFraction(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function quotaFailure(error: unknown): string {
  const details = object(error);
  switch (details?.kind ?? details?.category ?? details?.code) {
    case 'login_required':
    case 'quota_auth':
      return 'login_required';
    case 'timeout':
    case 'quota_timeout':
      return 'timeout';
    case 'invalid_quota':
    case 'quota_invalid':
      return 'invalid_quota';
    case 'worker_unavailable':
    case 'worker_offline':
    case 'disconnected':
      return 'worker_unavailable';
    default:
      return 'probe_failed';
  }
}

export class Router {
  readonly #instances: Map<string, number>;
  readonly #accounts: readonly string[];
  readonly #groups: Map<string, string>;
  readonly #threshold: number;
  readonly #exhaustedMessage: string;
  readonly #chats = new Map<string, Promise<void>>();
  #selectionTail = Promise.resolve();
  #current: Generation | undefined;
  #start = 0;

  constructor(config: RouterConfig, private readonly workers: WorkerDirectory) {
    this.#accounts = [...config.accounts];
    if (this.#accounts.length === 0 || this.#accounts.some(account => !account.trim()) ||
        new Set(this.#accounts).size !== this.#accounts.length) {
      throw new Error('Account order must contain unique account IDs');
    }
    this.#instances = new Map(Object.entries(config.instances).map(([id, item]) => [id, item.mcpPort]));
    const ports = [...this.#instances.values()];
    if (ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535) ||
        ports.length !== new Set(ports).size) {
      throw new Error('Each DSH instance must have a distinct valid MCP port');
    }
    this.#groups = new Map(Object.entries(config.modelGroups));
    this.#threshold = config.threshold ?? 0.05;
    if (!quotaFraction(this.#threshold)) throw new Error('Quota threshold must be between zero and one');
    this.#exhaustedMessage = config.exhaustedMessage ?? '余额不足';
  }

  connect(instanceId: string, emit: (frame: JsonObject) => void): RouterConnection {
    const port = this.#instances.get(instanceId);
    if (port === undefined) throw new Error('Unknown DSH instance');
    return new Connection(
      port, this.workers, this.#exhaustedMessage, emit,
      (chatKey, model, signal) => this.#acquire(instanceId, chatKey, model, signal),
      lease => this.#release(lease),
    );
  }

  async #acquire(instance: string, chatKey: string, model: string, signal: AbortSignal): Promise<Lease> {
    const group = this.#groups.get(model);
    if (!group) throw invalid('No quota group is configured for the requested model');
    const unlock = await this.#lockChat(instance, chatKey, signal);
    try {
      const preceding = this.#selectionTail;
      let advance!: () => void;
      this.#selectionTail = new Promise(resolve => { advance = resolve; });
      await preceding;
      try {
        checkCancelled(signal);
        const generation = await this.#select(group, signal);
        const lease: Lease = {
          id: randomUUID(), model, chatKey, generation, unlock, session: undefined,
          opening: false, releasing: false, operations: 0, permissions: 0,
        };
        // Add the lease before the next selection can switch and drain this generation.
        generation?.leases.add(lease);
        return lease;
      } finally {
        advance();
      }
    } catch (error) {
      unlock();
      throw error;
    }
  }

  async #lockChat(instance: string, chatKey: string, signal: AbortSignal): Promise<() => void> {
    const key = JSON.stringify([instance, chatKey]);
    for (;;) {
      checkCancelled(signal);
      const active = this.#chats.get(key);
      if (!active) {
        let unlock!: () => void;
        const hold = new Promise<void>(resolve => { unlock = resolve; });
        this.#chats.set(key, hold);
        return () => {
          if (this.#chats.get(key) === hold) this.#chats.delete(key);
          unlock();
        };
      }
      await withCancellation(active, signal);
    }
  }

  async #select(group: string, signal: AbortSignal): Promise<Generation | undefined> {
    const unknown: { accountId: string; reason: string }[] = [];
    for (let offset = 0; offset < this.#accounts.length; offset++) {
      checkCancelled(signal);
      const index = (this.#start + offset) % this.#accounts.length;
      const accountId = this.#accounts[index]!;
      let quota: Awaited<ReturnType<WorkerDirectory['probe']>>;
      try {
        quota = await this.workers.probe(accountId, group);
      } catch (error) {
        unknown.push({ accountId, reason: quotaFailure(error) });
        continue;
      }
      checkCancelled(signal);
      if (!quota || !quotaFraction(quota.weekly) || !quotaFraction(quota.fiveHour)) {
        unknown.push({ accountId, reason: 'invalid_quota' });
        continue;
      }
      if (Math.min(quota.weekly, quota.fiveHour) < this.#threshold) continue;
      this.#start = index;
      if (this.#current?.accountId === accountId) return this.#current;
      this.#retireCurrent();
      return this.#current = { id: randomUUID(), accountId, leases: new Set(), backends: new Set(), draining: false };
    }
    checkCancelled(signal);
    if (unknown.length) {
      throw new RpcFault(-32040, 'No eligible account could be confirmed', { kind: 'quota_unknown', accounts: unknown });
    }
    this.#retireCurrent();
    return undefined;
  }

  #retireCurrent(): void {
    const previous = this.#current;
    this.#current = undefined;
    if (!previous) return;
    previous.draining = true;
    this.#drain(previous);
  }

  #release(lease: Lease): void {
    const generation = lease.generation;
    generation?.leases.delete(lease);
    lease.unlock();
    if (generation) this.#drain(generation);
  }

  #drain(generation: Generation): void {
    if (!generation.draining || generation.leases.size) return;
    for (const backend of generation.backends) backend.close();
  }
}

class Connection implements RouterConnection {
  #closed = false;
  #initialized: JsonObject | undefined;
  #leases = new Map<string, Lease>();
  #sessions = new Map<string, Session>();
  #backends = new Map<Generation, BackendSlot>();
  #revisions = new WeakMap<Generation, string>();
  #incoming = new Map<RpcId, AbortController>();
  #permissions = new Map<string, Permission>();
  #closeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly port: number,
    private readonly workers: WorkerDirectory,
    private readonly exhaustedMessage: string,
    private readonly emit: (frame: JsonObject) => void,
    private readonly acquire: (chatKey: string, model: string, signal: AbortSignal) => Promise<Lease>,
    private readonly release: (lease: Lease) => void,
  ) {}

  async receive(frame: JsonObject): Promise<void> {
    if (this.#closed || frame.jsonrpc !== '2.0') return;
    const id = rpcId(frame.id);
    if (typeof frame.method !== 'string') {
      if (typeof id === 'string' && this.#permissions.has(id)) this.#answerPermission(id, frame);
      return;
    }
    const params = object(frame.params) ?? {};
    if (id === undefined) {
      if (!Object.hasOwn(frame, 'id')) this.#notification(frame.method, params);
      else this.#send(new RpcFault(-32600, 'Invalid request ID').frame(null));
      return;
    }
    // A duplicate reply with the same ID would resolve the original request at the client.
    if (this.#incoming.has(id)) return;
    const controller = new AbortController();
    this.#incoming.set(id, controller);
    try {
      const result = await this.#request(frame.method, params, controller.signal);
      this.#send({ jsonrpc: '2.0', id, result });
    } catch (error) {
      const fault = error instanceof RpcFault ? error : new RpcFault(-32603, 'ACP router request failed');
      this.#send(fault.frame(id));
    } finally {
      this.#incoming.delete(id);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#incoming.values()) controller.abort();
    for (const lease of this.#leases.values()) this.#beginRelease(lease);
    for (const id of this.#permissions.keys()) this.#answerPermission(id, CANCELLED_PERMISSION);
    this.#closeIdleBackends();
    if (this.#leases.size) {
      // A vanished client cannot consume callbacks. Cancel and allow ACP to
      // acknowledge before forcing cleanup of an unresponsive worker.
      this.#closeTimer = setTimeout(() => {
        for (const slot of this.#backends.values()) slot.backend?.close();
      }, DISCONNECT_GRACE_MS);
      this.#closeTimer.unref();
    }
  }

  async #request(method: string, params: JsonObject, signal: AbortSignal): Promise<unknown> {
    if (method === 'initialize') return this.#initialize(params);
    if (!this.#initialized) throw new RpcFault(-32002, 'Initialize the ACP connection first');
    switch (method) {
      case ACQUIRE: return this.#acquireTurn(params, signal);
      case RELEASE: {
        if (typeof params.leaseId !== 'string') throw invalid('leaseId is required');
        const lease = this.#leases.get(params.leaseId);
        if (lease) this.#beginRelease(lease);
        return {};
      }
      case 'session/new': return this.#openSession(params, signal);
      case 'session/close': return this.#closeSession(params, signal);
      case 'session/prompt':
      case 'session/set_config_option':
        return this.#sessionRequest(method, params, signal);
      default:
        // Session discovery, arbitrary extensions and authentication belong to
        // the worker host. No ACP access to another tenant or local client FS.
        throw new RpcFault(-32601, 'ACP method is not supported by this router');
    }
  }

  #initialize(params: JsonObject): JsonObject {
    if (params.protocolVersion !== 1) throw invalid('ACP protocol version 1 is required');
    if (this.#initialized) throw invalid('ACP connection is already initialized');
    this.#initialized = { protocolVersion: 1, clientCapabilities: {}, clientInfo: params.clientInfo };
    const capability = { [EXTENSION]: { version: 1 } };
    return {
      protocolVersion: 1,
      agentInfo: { name: 'Antigravity Account Switcher', version: '0.1.0' },
      authMethods: [],
      agentCapabilities: {
        loadSession: false, mcpCapabilities: { http: true },
        sessionCapabilities: { close: {} }, promptCapabilities: { image: true }, _meta: capability,
      },
      _meta: capability,
    };
  }

  async #acquireTurn(params: JsonObject, signal: AbortSignal): Promise<JsonObject> {
    const { chatKey, model } = params;
    if (typeof chatKey !== 'string' || !chatKey.trim() || chatKey.length > 1024 ||
        typeof model !== 'string' || !model.trim()) {
      throw invalid('chatKey and model are required');
    }
    const deadline = AbortSignal.timeout(ACQUIRE_DEADLINE_MS);
    const acquiring = AbortSignal.any([signal, deadline]);
    const pending = this.acquire(chatKey, model, acquiring);
    let lease: Lease;
    try {
      lease = await withCancellation(pending, acquiring);
    } catch (error) {
      if (acquiring.aborted) void pending.then(this.release, () => {});
      if (deadline.aborted && !signal.aborted) {
        throw new RpcFault(-32040, 'Account selection timed out', { kind: 'quota_unknown', reason: 'timeout' });
      }
      throw error;
    }
    if (this.#closed || acquiring.aborted) {
      this.release(lease);
      throw cancelled();
    }
    this.#leases.set(lease.id, lease);
    const generation = lease.generation;
    if (!generation) return { status: 'exhausted', leaseId: lease.id, generationId: 'exhausted' };
    return {
      status: 'selected', leaseId: lease.id, accountId: generation.accountId,
      generationId: this.#revisions.get(generation) ?? generation.id,
    };
  }

  #requireLease(params: JsonObject): Lease {
    const id = extensionMeta(params)?.leaseId;
    const lease = typeof id === 'string' ? this.#leases.get(id) : undefined;
    if (!lease || lease.releasing) throw stale('Turn lease is missing or expired');
    return lease;
  }

  async #openSession(params: JsonObject, signal: AbortSignal): Promise<JsonObject> {
    const lease = this.#requireLease(params);
    if (lease.opening || lease.session) throw stale('Turn lease already has a session');
    if (Object.hasOwn(params, 'additionalDirectories')) throw invalid('Client directories are not supported');
    const servers = mcpServers(params.mcpServers, this.port);
    lease.opening = true;
    lease.operations++;
    try {
      if (!lease.generation) {
        const session = this.#attach(lease, undefined, randomUUID());
        return { sessionId: session.id, configOptions: [] };
      }
      const slot = this.#backend(lease.generation);
      const backend = await slot.promise;
      checkCancelled(signal);
      if (lease.releasing) throw stale('Turn lease is no longer active');
      const result = object(await backend.request('session/new', { ...withoutExtension(params), mcpServers: servers }, signal));
      const nativeId = result?.sessionId;
      if (!result || typeof nativeId !== 'string' || !nativeId || slot.sessions.has(nativeId)) {
        throw new RpcFault(-32603, 'Invalid native ACP session ID');
      }
      if (backend.closed) throw new WorkerDisconnected();
      const session = this.#attach(lease, slot, nativeId);
      this.#observeModel(session, result);
      if (this.#closed || signal.aborted || lease.releasing) {
        this.#detach(session);
        // New session reached the worker after local cancellation. Request its
        // cleanup on the same stream without exposing its ID.
        void backend.request('session/close', { sessionId: nativeId }).catch(() => {});
        throw cancelled();
      }
      return {
        ...result, sessionId: session.id,
        _meta: { ...object(result._meta), [EXTENSION]: { nativeSessionId: nativeId } },
      };
    } catch (error) {
      if (error instanceof WorkerDisconnected) throw stale('Account worker disconnected before session setup finished');
      throw error;
    } finally {
      lease.opening = false;
      lease.operations--;
      this.#finishRelease(lease);
    }
  }

  #attach(lease: Lease, slot: BackendSlot | undefined, nativeId: string): Session {
    const session: Session = {
      id: randomUUID(), nativeId, slot, generation: lease.generation, chatKey: lease.chatKey, lease,
      modelId: undefined, modelConfigId: undefined, prompting: false, closing: false,
    };
    this.#sessions.set(session.id, session);
    slot?.sessions.set(nativeId, session);
    lease.session = session;
    return session;
  }

  #detach(session: Session): void {
    this.#sessions.delete(session.id);
    session.slot?.sessions.delete(session.nativeId);
    if (session.lease?.session === session) session.lease.session = undefined;
    session.lease = undefined;
  }

  #session(id: unknown): Session {
    const session = typeof id === 'string' ? this.#sessions.get(id) : undefined;
    if (!session || session.closing) throw stale('Unknown or expired ACP session');
    return session;
  }

  #bindSession(params: JsonObject): { session: Session; lease: Lease } {
    const session = this.#session(params.sessionId);
    const lease = this.#requireLease(params);
    if (session.chatKey !== lease.chatKey || session.generation !== lease.generation ||
        (lease.session && lease.session !== session) || (session.lease && session.lease !== lease)) {
      throw stale('ACP session does not belong to this turn lease');
    }
    lease.session = session;
    session.lease = lease;
    return { session, lease };
  }

  async #closeSession(params: JsonObject, signal: AbortSignal): Promise<JsonObject> {
    if (typeof params.sessionId !== 'string') throw invalid('sessionId is required');
    const session = this.#sessions.get(params.sessionId);
    if (!session || session.closing) return {};
    const lease = session.lease;
    if (lease && (lease.operations || lease.permissions || extensionMeta(params)?.leaseId !== lease.id)) {
      throw stale('ACP session has an active turn');
    }
    session.closing = true;
    this.#detach(session);
    if (!session.slot?.backend || session.slot.backend.closed) return {};
    try {
      await session.slot.backend.request('session/close', { sessionId: session.nativeId }, signal);
    } catch (error) {
      // Local state is detached even when the installed agy lacks session/close.
      if (!(error instanceof WorkerDisconnected) && !(error instanceof RpcFault && error.code === -32601)) throw error;
    }
    return {};
  }

  async #sessionRequest(method: string, params: JsonObject, signal: AbortSignal): Promise<unknown> {
    const { session, lease } = this.#bindSession(params);
    if (lease.operations !== 0) throw invalid('An ACP operation is already active for this turn');
    const prompting = method === 'session/prompt';
    if (!prompting) {
      if (typeof params.configId !== 'string' || typeof params.value !== 'string') {
        throw invalid('configId and value are required');
      }
      const choosingModel = params.configId === 'model' || params.configId === session.modelConfigId;
      if (choosingModel && params.value !== lease.model) throw invalid('Model selection differs from the quota-checked model');
    } else {
      if (!Array.isArray(params.prompt)) throw invalid('Prompt content must be an array');
      if (session.modelId && session.modelId !== lease.model) throw invalid('Select the quota-checked model before prompting');
    }
    if (!session.slot) {
      if (!prompting) return { configOptions: [] };
      this.#send({
        jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: session.id,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: this.exhaustedMessage } },
        },
      });
      return { stopReason: 'end_turn' };
    }
    const backend = session.slot.backend;
    if (!backend || backend.closed) throw stale('Account worker is unavailable');
    lease.operations++;
    session.prompting = prompting;
    try {
      const result = await backend.request(method, { ...withoutExtension(params), sessionId: session.nativeId }, signal);
      if (!prompting) this.#observeModel(session, object(result) ?? {});
      return result;
    } catch (error) {
      if (prompting && (error instanceof WorkerDisconnected ||
          (error instanceof RpcFault && error.code === -32603 && backend.closed))) {
        throw new RpcFault(-32041, 'Account worker disconnected after prompt submission', { kind: 'submission_unknown' });
      }
      if (error instanceof WorkerDisconnected) throw stale('Account worker is unavailable');
      throw error;
    } finally {
      session.prompting = false;
      lease.operations--;
      this.#finishRelease(lease);
    }
  }

  #observeModel(session: Session, value: JsonObject): void {
    const options = Array.isArray(value.configOptions) ? value.configOptions : [];
    const model = options.map(object).find(option => option?.id === 'model' || option?.category === 'model');
    if (typeof model?.id === 'string') session.modelConfigId = model.id;
    const modelId = model?.currentValue ?? object(value.models)?.currentModelId;
    if (typeof modelId === 'string') session.modelId = modelId;
  }

  #notification(method: string, params: JsonObject): void {
    if (method === '$/cancel_request') {
      const id = rpcId(params.requestId);
      if (id !== undefined) this.#incoming.get(id)?.abort();
      return;
    }
    if (method !== 'session/cancel' || typeof params.sessionId !== 'string') return;
    const session = this.#sessions.get(params.sessionId);
    // session/cancel only targets a currently running prompt on this connection.
    // The pinned plugin can also cancel during disposal, before adding extension metadata.
    if (!session?.prompting) return;
    const suppliedLease = extensionMeta(params)?.leaseId;
    if (suppliedLease !== undefined && suppliedLease !== session.lease?.id) return;
    this.#cancelSession(session);
  }

  #cancelSession(session: Session): void {
    session.slot?.backend?.notify('session/cancel', { sessionId: session.nativeId });
    for (const [id, permission] of this.#permissions) {
      if (permission.session === session) this.#answerPermission(id, CANCELLED_PERMISSION);
    }
  }

  #beginRelease(lease: Lease): void {
    if (lease.releasing) return;
    lease.releasing = true;
    if (lease.session?.prompting) this.#cancelSession(lease.session);
    this.#finishRelease(lease);
  }

  #finishRelease(lease: Lease): void {
    if (!lease.releasing || lease.operations || lease.permissions || !this.#leases.delete(lease.id)) return;
    if (lease.session?.lease === lease) lease.session.lease = undefined;
    this.release(lease);
    if (this.#closed) this.#closeIdleBackends();
  }

  #backend(generation: Generation): BackendSlot {
    const existing = this.#backends.get(generation);
    if (existing) return existing;
    const slot: BackendSlot = {
      sessions: new Map(), permissions: new Map(),
      promise: Promise.resolve().then(async () => {
        if (this.#closed) throw cancelled();
        let stream;
        try { stream = await this.workers.open(generation.accountId); }
        catch { throw stale('Account worker could not be started'); }
        if (this.#closed) {
          stream.close();
          throw cancelled();
        }
        const backend = new AcpBackend(
          stream, frame => this.#workerFrame(slot, frame), () => this.#workerExit(generation, slot),
        );
        slot.backend = backend;
        if (backend.closed) throw stale('Account worker could not be initialized');
        generation.backends.add(backend);
        try {
          const initialized = object(await backend.request('initialize', this.#initialized ?? {}, undefined, INITIALIZE_DEADLINE_MS));
          if (initialized?.protocolVersion !== 1) throw stale('Account worker did not negotiate ACP v1');
          return backend;
        } catch (error) {
          backend.close();
          throw error;
        }
      }).catch(error => {
        if (this.#backends.get(generation) === slot) this.#backends.delete(generation);
        throw error;
      }),
    };
    this.#backends.set(generation, slot);
    return slot;
  }

  #workerExit(generation: Generation, slot: BackendSlot): void {
    if (slot.backend) generation.backends.delete(slot.backend);
    if (this.#backends.get(generation) === slot) {
      this.#backends.delete(generation);
      if (!generation.draining) this.#revisions.set(generation, randomUUID());
    }
    for (const [id, permission] of this.#permissions) {
      if (permission.slot === slot) this.#answerPermission(id, {});
    }
    for (const session of slot.sessions.values()) this.#detach(session);
  }

  #workerFrame(slot: BackendSlot, frame: JsonObject): void {
    const params = object(frame.params) ?? {};
    const id = rpcId(frame.id);
    if (frame.method === '$/cancel_request' && id === undefined) {
      const requestId = rpcId(params.requestId);
      const external = requestId === undefined ? undefined : slot.permissions.get(requestId);
      if (external) {
        this.#send({ jsonrpc: '2.0', method: frame.method, params: { requestId: external } });
      }
      return;
    }
    const session = typeof params.sessionId === 'string' ? slot.sessions.get(params.sessionId) : undefined;
    if (frame.method === 'session/update' && id === undefined && session?.lease) {
      const update = object(params.update);
      if (update) this.#observeModel(session, update);
      this.#send({ jsonrpc: '2.0', method: frame.method, params: { ...params, sessionId: session.id } });
      return;
    }
    if (id === undefined) return;
    if (frame.method !== 'session/request_permission') {
      slot.backend?.respond(id, { error: { code: -32601, message: 'Client ACP method is unavailable' } });
      return;
    }
    const lease = session?.lease;
    if (!session?.prompting || !lease || lease.releasing || this.#closed) {
      slot.backend?.respond(id, CANCELLED_PERMISSION);
      return;
    }
    if (slot.permissions.has(id)) return;
    const external = 'aas-permission:' + randomUUID();
    this.#permissions.set(external, { nativeId: id, slot, session, lease });
    slot.permissions.set(id, external);
    lease.permissions++;
    this.#send({
      jsonrpc: '2.0', id: external, method: frame.method,
      params: { ...params, sessionId: session.id },
    });
  }

  #answerPermission(id: string, frame: JsonObject): void {
    const permission = this.#permissions.get(id);
    if (!permission) return;
    this.#permissions.delete(id);
    permission.slot.permissions.delete(permission.nativeId);
    permission.lease.permissions--;
    const result = object(frame.result);
    const error = object(frame.error);
    permission.slot.backend?.respond(
      permission.nativeId, result ? { result } : error ? { error } : CANCELLED_PERMISSION,
    );
    this.#finishRelease(permission.lease);
  }

  #closeIdleBackends(): void {
    for (const [generation, slot] of this.#backends) {
      if (![...this.#leases.values()].some(lease => lease.generation === generation)) slot.backend?.close();
    }
    if (this.#leases.size === 0 && this.#closeTimer !== undefined) {
      clearTimeout(this.#closeTimer);
      this.#closeTimer = undefined;
    }
  }

  #send(frame: JsonObject): void {
    if (this.#closed) return;
    try { this.emit(frame); }
    catch { this.close(); }
  }
}
