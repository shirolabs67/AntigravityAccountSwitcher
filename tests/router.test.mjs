import assert from 'node:assert/strict';
import test from 'node:test';
import { Router } from '../dist/router.js';

const EXT = 'antigravityAccountSwitcher';
const ACQUIRE = '_' + EXT + '/acquireTurn';
const RELEASE = '_' + EXT + '/releaseTurn';
const NATIVE_SESSION = 'same-native-session-id';
const MODEL = 'test-model';
const authorization = [{ name: 'Authorization', value: 'Bearer ' + 'b'.repeat(48) }];
const tenant = '/mcp/' + 'a'.repeat(32);
const META = { antigravity: { systemPrompt: { append: 'test prompt' } } };
const rpc = (frame) => ({ jsonrpc: '2.0', ...frame });
const leaseMeta = (lease, rest = {}) => ({ ...rest, [EXT]: { leaseId: lease.leaseId } });
const quota = (weekly, fiveHour = weekly) => ({ weekly, fiveHour });
const tick = () => new Promise(resolve => setImmediate(resolve));

class FakeWorker {
  closed = false;
  frames = [];
  receive = () => {};
  exit = () => {};

  constructor(accountId) {
    this.accountId = accountId;
  }

  onFrame(listener) { this.receive = listener; }
  onClose(listener) { this.exit = listener; }

  send(frame) {
    assert.equal(this.closed, false, 'do not send after worker teardown');
    this.frames.push(frame);
    if (frame.method === 'initialize') {
      this.reply(frame.id, { protocolVersion: 1 });
    } else if (frame.method === 'session/new') {
      this.reply(frame.id, { sessionId: NATIVE_SESSION, configOptions: [], _meta: { example: true } });
    } else if (frame.method === 'session/close') {
      this.reply(frame.id, {});
    }
  }

  reply(id, result) { this.receive(rpc({ id, result })); }
  inject(method, params, id) {
    this.receive(rpc({ method, params, ...(id === undefined ? {} : { id }) }));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.exit();
  }

  last(method) { return this.frames.findLast(frame => frame.method === method); }
}

function harness(options = {}) {
  const probes = [];
  const streams = [];
  const quotas = { a: quota(0.75), b: quota(0.80) };
  const router = new Router({
    accounts: ['a', 'b'],
    modelGroups: { [MODEL]: 'exact-model-group' },
    instances: { dshA: { mcpPort: 43101 }, dshB: { mcpPort: 43102 } },
    ...options,
  }, {
    async probe(accountId, groupId) {
      probes.push([accountId, groupId]);
      const state = quotas[accountId];
      if (state instanceof Error) throw state;
      return state;
    },
    async open(accountId) {
      const stream = new FakeWorker(accountId);
      streams.push(stream);
      return stream;
    },
  });
  return { quotas, probes, streams, router };
}

function client(router, instanceId) {
  const events = [];
  const connection = router.connect(instanceId, frame => events.push(frame));
  let sequence = 100;
  const request = async (method, params, id = ++sequence) => {
    await connection.receive(rpc({ method, params, id }));
    const at = events.findIndex(frame => frame.id === id && !frame.method);
    assert.notEqual(at, -1, 'missing JSON-RPC response for ' + method);
    return events.splice(at, 1)[0];
  };
  const result = async (...args) => {
    const frame = await request(...args);
    assert.equal(frame.error, undefined, JSON.stringify(frame.error));
    return frame.result;
  };
  const notify = (method, params) => connection.receive(rpc({ method, params }));
  return {
    connection, events, request, result, notify,
    initialize: () => result('initialize', { protocolVersion: 1 }),
    acquire: (chatKey = 'same-chat') => result(ACQUIRE, { chatKey, model: MODEL }),
    release: (lease) => result(RELEASE, { leaseId: lease.leaseId }),
    async open(lease, servers = []) {
      return result('session/new', { cwd: '/original', mcpServers: servers, _meta: leaseMeta(lease, META) });
    },
    prompt: (lease, sessionId, id) => result(
      'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'test' }], _meta: leaseMeta(lease) }, id,
    ),
  };
}

function bridge(port) {
  return [{ type: 'http', name: 'dsh', url: 'http://127.0.0.1:' + port + tenant, headers: authorization }];
}

test('uses the lower quota, includes 5%, searches at most one circle, and recovers the old account', async () => {
  const h = harness({ exhaustedMessage: '额度测试' });
  const dsh = client(h.router, 'dshA');
  const init = await dsh.initialize();
  assert.equal(init._meta[EXT].version, 1);
  h.quotas.a = quota(0.20, 0.0499);
  h.quotas.b = quota(0.05, 0.40);
  const first = await dsh.acquire();
  assert.equal(first.accountId, 'b');
  assert.deepEqual(h.probes.splice(0), [['a', 'exact-model-group'], ['b', 'exact-model-group']]);
  await dsh.release(first);

  h.quotas.b = quota(0.0499, 0.80);
  h.quotas.a = quota(0.50, 0.05);
  const recovered = await dsh.acquire();
  assert.equal(recovered.accountId, 'a');
  assert.notEqual(recovered.generationId, first.generationId);
  assert.deepEqual(h.probes.splice(0).map(([account]) => account), ['b', 'a']);
  await dsh.release(recovered);

  h.quotas.a = quota(0.04);
  h.quotas.b = Object.assign(new Error('sensitive upstream detail'), { category: 'quota_auth' });
  const unknown = await dsh.request(ACQUIRE, { model: MODEL, chatKey: 'same-chat' });
  assert.equal(unknown.error.code, -32040);
  assert.deepEqual(unknown.error.data.accounts, [{ accountId: 'b', reason: 'login_required' }]);
  assert.doesNotMatch(JSON.stringify(unknown), /sensitive/);
  assert.deepEqual(h.probes.splice(0).map(([account]) => account), ['a', 'b']);

  h.quotas.b = { weekly: 0.02 };
  const malformed = await dsh.request(ACQUIRE, { model: MODEL, chatKey: 'same-chat' });
  assert.equal(malformed.error.data.accounts[0].reason, 'invalid_quota');

  h.quotas.b = quota(0.03);
  const empty = await dsh.acquire();
  assert.equal(empty.status, 'exhausted');
  const session = await dsh.open(empty);
  assert.deepEqual(await dsh.prompt(empty, session.sessionId), { stopReason: 'end_turn' });
  assert.equal(dsh.events[0].params.update.content.text, '额度测试');
  assert.equal(h.streams.length, 0);
  await dsh.release(empty);
  dsh.connection.close();
});

test('switches other chats while keeping the original turn, stream, permission, and MCP routing isolated', async () => {
  const h = harness();
  const a = client(h.router, 'dshA');
  const b = client(h.router, 'dshB');
  await Promise.all([a.initialize(), b.initialize()]);
  const original = await a.acquire();
  const aSession = await a.open(original, bridge(23100));
  const [oldWorker] = h.streams;
  const oldNew = oldWorker.last('session/new');
  assert.equal(oldNew.params.mcpServers[0].url, 'http://127.0.0.1:43101' + tenant);
  assert.deepEqual(oldNew.params.mcpServers[0].headers, authorization);
  assert.deepEqual(oldNew.params._meta, META);
  assert.equal(aSession._meta[EXT].nativeSessionId, NATIVE_SESSION);
  assert.equal(aSession._meta.example, true);
  const aPrompt = a.prompt(original, aSession.sessionId, 7);
  const oldPrompt = oldWorker.last('session/prompt');
  assert.equal(oldPrompt.params.sessionId, NATIVE_SESSION);

  h.quotas.a = quota(0.01);
  const fresh = await b.acquire();
  assert.equal(fresh.accountId, 'b');
  const bSession = await b.open(fresh, bridge(23100));
  const newWorker = h.streams[1];
  assert.equal(newWorker.last('session/new').params.mcpServers[0].url, 'http://127.0.0.1:43102' + tenant);
  assert.notEqual(bSession.sessionId, aSession.sessionId);
  const bPrompt = b.prompt(fresh, bSession.sessionId, 7);
  const newPrompt = newWorker.last('session/prompt');
  assert.equal(oldPrompt.id, newPrompt.id, 'backends intentionally reuse request numbers');

  const aCrossLease = await a.request('session/set_config_option', {
    sessionId: aSession.sessionId, configId: 'model', value: MODEL, _meta: leaseMeta(fresh),
  });
  assert.equal(aCrossLease.error.code, -32042);
  const bCrossSession = await b.request('session/set_config_option', {
    sessionId: aSession.sessionId, configId: 'model', value: MODEL, _meta: leaseMeta(fresh),
  });
  assert.equal(bCrossSession.error.code, -32042);
  for (const [worker, label] of [[oldWorker, 'old account'], [newWorker, 'new account']]) {
    worker.inject('session/update', { sessionId: NATIVE_SESSION, update: { text: label } });
    worker.inject('session/request_permission', { sessionId: NATIVE_SESSION, options: [] }, 17);
  }
  assert.equal(a.events.find(f => f.method === 'session/update').params.update.text, 'old account');
  assert.equal(b.events.find(f => f.method === 'session/update').params.update.text, 'new account');
  const aPermission = a.events.find(f => f.method === 'session/request_permission');
  const bPermission = b.events.find(f => f.method === 'session/request_permission');
  assert.notEqual(aPermission.id, bPermission.id);
  assert.equal(aPermission.params.sessionId, aSession.sessionId);
  assert.equal(bPermission.params.sessionId, bSession.sessionId);
  await b.connection.receive(rpc({ id: aPermission.id, result: { wrong: true } }));
  assert.equal(oldWorker.frames.some(f => f.id === 17), false);
  oldWorker.inject('$/cancel_request', { requestId: 17 });
  assert.equal(a.events.at(-1).params.requestId, aPermission.id);
  assert.equal(b.events.some(f => f.method === '$/cancel_request'), false);
  await a.connection.receive(rpc({ id: aPermission.id, result: { outcome: { outcome: 'cancelled' } } }));
  await b.connection.receive(rpc({ id: bPermission.id, result: { outcome: { outcome: 'selected', optionId: 'b' } } }));
  assert.equal(oldWorker.frames.at(-1).result.outcome.outcome, 'cancelled');
  assert.equal(newWorker.frames.at(-1).result.outcome.optionId, 'b');
  newWorker.reply(newPrompt.id, { stopReason: 'end_turn' });
  await bPrompt;
  await b.release(fresh);
  assert.equal(oldWorker.closed, false);

  oldWorker.reply(oldPrompt.id, { stopReason: 'end_turn' });
  await aPrompt;
  // ACP completing one prompt is not the end of the DSH turn.
  const continuation = a.prompt(original, aSession.sessionId);
  const nextNative = oldWorker.last('session/prompt');
  assert.notEqual(nextNative.id, oldPrompt.id);
  oldWorker.inject('session/request_permission', { sessionId: NATIVE_SESSION, options: [] }, 18);
  oldWorker.reply(nextNative.id, { stopReason: 'end_turn' });
  await continuation;
  await a.release(original);
  assert.equal(oldWorker.closed, false, 'wait for outstanding permission callback');
  let nextLease;
  const next = a.acquire().then(lease => { nextLease = lease; return lease; });
  await tick();
  assert.equal(nextLease, undefined, 'same chat must wait for lease drain');
  const pending = a.events.findLast(f => f.method === 'session/request_permission');
  await a.connection.receive(rpc({ id: pending.id, result: { outcome: { outcome: 'cancelled' } } }));
  assert.equal(oldWorker.closed, true);
  assert.equal((await next).accountId, 'b');
  await a.release(nextLease);
  a.connection.close();
  b.connection.close();
});

test('validates MCP authority and remaps request/session cancellation without replay after worker loss', async () => {
  const h = harness();
  const a = client(h.router, 'dshA');
  await a.initialize();
  const lease = await a.acquire();
  const malformed = await a.request('session/new', {
    cwd: '/original',
    mcpServers: [{ ...bridge(23100)[0], url: 'http://127.0.0.1.example:23100' + tenant }],
    _meta: leaseMeta(lease),
  });
  assert.equal(malformed.error.code, -32602);
  assert.equal(h.streams.length, 0);
  const { sessionId } = await a.open(lease, bridge(23100));
  const [worker] = h.streams;
  const prompt = a.request('session/prompt', { sessionId, prompt: [], _meta: leaseMeta(lease) }, 91);
  const native = worker.last('session/prompt');
  worker.inject('session/request_permission', { sessionId: NATIVE_SESSION }, 101);
  await a.notify('$/cancel_request', { requestId: 91 });
  assert.equal(worker.last('$/cancel_request').params.requestId, native.id);
  await a.notify('session/cancel', { sessionId });
  assert.equal(worker.last('session/cancel').params.sessionId, NATIVE_SESSION);
  assert.equal(worker.frames.find(f => f.id === 101).result.outcome.outcome, 'cancelled');
  worker.close();
  assert.equal((await prompt).error.data.kind, 'submission_unknown');
  assert.equal(worker.frames.filter(f => f.method === 'session/prompt').length, 1);
  await a.release(lease);
  const next = await a.acquire();
  assert.equal(next.accountId, lease.accountId);
  assert.notEqual(next.generationId, lease.generationId);
  await a.release(next);
  a.connection.close();
});

test('cancels queued acquisition without reserving an orphan chat lease', async () => {
  const h = harness();
  const dsh = client(h.router, 'dshA');
  await dsh.initialize();
  let reply;
  h.quotas.a = new Promise(resolve => { reply = resolve; });
  const pending = dsh.request(ACQUIRE, { chatKey: 'cancelled-chat', model: MODEL }, 92);
  await tick();
  assert.equal(h.probes.length, 1);
  await dsh.notify('$/cancel_request', { requestId: 92 });
  assert.equal((await pending).error.code, -32800);
  h.quotas.a = quota(0.75);
  reply(quota(0.75));
  const lease = await dsh.acquire('cancelled-chat');
  assert.equal(lease.accountId, 'a');
  await dsh.release(lease);
  dsh.connection.close();
});
