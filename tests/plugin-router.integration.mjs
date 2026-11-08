import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startBroker } from './broker-fixture.mjs';
import { AntigravityAdapter } from '../dsh-plugin/lib/adapter.js';
import { Config } from '../dsh-plugin/lib/config.js';
import { AntigravityRuntime } from '../dsh-plugin/lib/runtime.js';

const model = 'gemini-4-argon';
const provider = 'antigravity';
const turn = (id, role, content, source) => ({ id, role, source, content: [{ type: 'text', text: content }] });
const user = (id, text) => turn(id, 'user', text, { kind: 'user' });
const answer = (id, text) => turn(id, 'assistant', text, { kind: 'model', provider, model });
const textOf = chunks => chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('');

test('real DSH adapter and Rust router switch accounts, replay own history, and return normal exhaustion', { timeout: 45_000 }, async t => {
  const quotas = new Map([['a', 0.05], ['b', 0.30]]);
  const seen = [];
  const checked = [];
  let sessionCounter = 0;
  const instances = { 'dsh-a': 43101, 'dsh-b': 43102 };
  const broker = await startBroker(t, { accounts: ['a', 'b'], instances, modelGroups: { [model]: 'Gemini Models' } });
  for (const account of quotas.keys()) {
    const streams = new Set();
    const worker = await broker.link('worker', account, (operation, args) => {
      switch (operation) {
        case 'worker/probe':
          assert.equal(args.groupId, 'Gemini Models');
          checked.push(account);
          return { weekly: 0.50, fiveHour: quotas.get(account) };
        case 'worker/open':
          assert.ok(!streams.has(args.streamId));
          streams.add(args.streamId);
          return null;
        case 'worker/close':
          streams.delete(args.streamId);
          worker.notify('worker/closed', { streamId: args.streamId });
          return null;
        case 'worker/send': {
          assert.ok(streams.has(args.streamId));
          const { id, method, params } = args.frame;
          const send = frame => worker.notify('worker/frame', {
            streamId: args.streamId, frame: { jsonrpc: '2.0', ...frame },
          });
          const result = value => send({ id, result: value });
          switch (method) {
            case 'initialize':
              return result({ protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } });
            case 'session/new':
              assert.equal(params._meta?.antigravityAccountSwitcher, undefined);
              return result({ sessionId: 'native-' + ++sessionCounter, configOptions: [
                { id: 'model', category: 'model', type: 'select', currentValue: model, options: [{ value: model, name: model }] },
              ] });
            case 'session/set_config_option':
            case 'session/close':
              return result({});
            case 'session/prompt':
              assert.equal(params._meta?.antigravityAccountSwitcher, undefined);
              seen.push({ account, text: params.prompt.map(block => block.text ?? '').join('\n') });
              send({ method: 'session/update', params: { sessionId: params.sessionId,
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reply from ' + account } } } });
              return result({ stopReason: 'end_turn' });
            default:
              if (id !== undefined) return send({ id, error: { code: -32601, message: 'unsupported test method' } });
          }
        }
        default:
          assert.fail('Unexpected worker operation: ' + operation);
      }
    });
    assert.equal(await worker.request('broker/ready', {}), true);
  }

  async function dsh(id) {
    const home = await mkdtemp(join(tmpdir(), 'aas-joint-'));
    const spawnAcp = await broker.ingress(id);
    const runtime = new AntigravityRuntime({
      config: Config({ home, autoPatch: false, warmup: false,
        proxy: { host: 'router.example.test', user: 'aas-test', remotePort: instances[id],
          identityFile: join(home, 'id'), knownHostsFile: join(home, 'known_hosts') } }),
      spawnAcp,
      runCommand() { assert.fail('Proxy ran the local agy command'); },
      readImage: async () => undefined, canReadImages: () => false,
      log: { warn() {}, info() {} }, onModelsChanged() {},
    });
    const adapter = new AntigravityAdapter(runtime, 'Antigravity', () => false);
    t.after(async () => {
      await runtime.dispose();
      await rm(home, { recursive: true, force: true });
    });
    return async (messages) => {
      const chunks = [];
      for await (const chunk of adapter.stream({ provider, model, sessionId: 'same-client-chat-id', messages, tools: [] })) chunks.push(chunk);
      assert.equal(chunks.at(-1)?.type, 'finish');
      return textOf(chunks);
    };
  }
  const a = await dsh('dsh-a');
  const b = await dsh('dsh-b');
  const a1 = user('a1', 'only the first DSH knows this marker');
  assert.equal(await a([a1]), 'reply from a');
  quotas.set('a', 0.049);
  assert.equal(await b([user('b1', 'a different DSH marker')]), 'reply from b');
  const aHistory = [a1, answer('a2', 'reply from a'), user('a3', 'second message')];
  assert.equal(await a(aHistory), 'reply from b');
  assert.deepEqual(seen.map(row => row.account), ['a', 'b', 'b']);
  assert.match(seen[2].text, /<dsh_history>[\s\S]*only the first DSH knows this marker/);
  assert.doesNotMatch(seen[2].text, /a different DSH marker/);
  quotas.set('b', 0.01);
  assert.equal(await a([...aHistory, answer('a4', 'reply from b'), user('a5', 'third message')]), '余额不足');
  assert.equal(seen.length, 3);
  assert.deepEqual(checked, ['a', 'a', 'b', 'b', 'b', 'a']);
});
