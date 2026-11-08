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
const heldMessage = 'hold this first DSH turn open';
const turn = (id, role, content, source) => ({ id, role, source, content: [{ type: 'text', text: content }] });
const user = (id, text) => turn(id, 'user', text, { kind: 'user' });
const answer = (id, text) => turn(id, 'assistant', text, { kind: 'model', provider, model });
const textOf = chunks => chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('');

test('real DSH adapters switch accounts, finish active turns, and rebuild isolated histories', { timeout: 45_000 }, async t => {
  const quotas = new Map([['a', 0.05], ['b', 0.30]]);
  const seen = [];
  const checked = [];
  const activePromptStarted = Promise.withResolvers();
  let finishActivePrompt;
  let sessionCounter = 0;
  const instances = { 'dsh-a': 43101, 'dsh-b': 43102 };
  const broker = await startBroker(t, {
    accounts: ['a', 'b'], instances, accountSwitchInstances: ['dsh-b'], modelGroups: { [model]: 'Gemini Models' },
  });
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
            case 'session/prompt': {
              assert.equal(params._meta?.antigravityAccountSwitcher, undefined);
              const text = params.prompt.map(block => block.text ?? '').join('\n');
              seen.push({ account, sessionId: params.sessionId, text });
              const finish = () => {
                assert.ok(streams.has(args.streamId));
                send({ method: 'session/update', params: { sessionId: params.sessionId,
                  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reply from ' + account } } } });
                result({ stopReason: 'end_turn' });
              };
              if (params.prompt.at(-1)?.text === heldMessage) {
                assert.equal(account, 'a');
                finishActivePrompt = finish;
                activePromptStarted.resolve();
                return null;
              }
              return finish();
            }
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
    return async (messages, switchAccount = false) => {
      const chunks = [];
      const options = { provider, model, sessionId: 'same-client-chat-id', messages, tools: [] };
      if (switchAccount) options._meta = { antigravityAccountSwitcher: { switchAccount: true } };
      for await (const chunk of adapter.stream(options)) chunks.push(chunk);
      assert.equal(chunks.at(-1)?.type, 'finish');
      return textOf(chunks);
    };
  }
  const a = await dsh('dsh-a');
  const b = await dsh('dsh-b');
  const a1 = user('a1', 'only the first DSH knows this marker');
  const b1 = user('b1', 'a different DSH marker');
  await assert.rejects(b([b1], true), { code: 'PROXY_ACCOUNT_SWITCH_UNAVAILABLE' });
  assert.deepEqual(checked, []);
  assert.equal(await a([a1]), 'reply from a');
  assert.equal(await b([b1]), 'reply from a');
  assert.notEqual(seen[0].sessionId, seen[1].sessionId);

  const aActive = [a1, answer('a2', 'reply from a'), user('a3', heldMessage)];
  const pendingA = a(aActive);
  await Promise.race([
    activePromptStarted.promise,
    pendingA.then(() => assert.fail('The first DSH turn finished before the switch')),
  ]);
  const bSwitch = [b1, answer('b2', 'reply from a'), user('b3', 'request an account switch')];
  assert.equal(await b(bSwitch, true), 'reply from b');
  assert.deepEqual(checked, ['a', 'a', 'a', 'b']);
  assert.equal(seen[2].sessionId, seen[0].sessionId);
  assert.notEqual(seen[3].sessionId, seen[1].sessionId);
  assert.match(seen[3].text, /<dsh_history>[\s\S]*a different DSH marker/);
  assert.doesNotMatch(seen[3].text, /only the first DSH knows this marker/);
  finishActivePrompt();
  assert.equal(await pendingA, 'reply from a');

  const aHistory = [...aActive, answer('a4', 'reply from a'), user('a5', 'continue after the switch')];
  assert.equal(await a(aHistory), 'reply from b');
  assert.notEqual(seen[4].sessionId, seen[2].sessionId);
  assert.match(seen[4].text, /<dsh_history>[\s\S]*only the first DSH knows this marker/);
  assert.doesNotMatch(seen[4].text, /a different DSH marker/);

  quotas.set('a', 0.049);
  const bContinue = [...bSwitch, answer('b4', 'reply from b'), user('b5', 'try again after a failed switch')];
  await assert.rejects(b(bContinue, true), { code: 'PROXY_ACCOUNT_SWITCH_UNAVAILABLE' });
  assert.equal(seen.length, 5);
  assert.equal(await b(bContinue), 'reply from b');
  assert.equal(seen[5].sessionId, seen[3].sessionId);

  quotas.set('a', 0.05);
  quotas.set('b', 0.049);
  const aFallback = [...aHistory, answer('a6', 'reply from b'), user('a7', 'use normal quota fallback')];
  assert.equal(await a(aFallback), 'reply from a');
  quotas.set('a', 0.049);
  assert.equal(await a([...aFallback, answer('a8', 'reply from a'), user('a9', 'use exhaustion reply')]), '余额不足');
  assert.deepEqual(seen.map(row => row.account), ['a', 'a', 'a', 'b', 'b', 'b', 'a']);
  assert.deepEqual(checked, ['a', 'a', 'a', 'b', 'b', 'a', 'b', 'b', 'a', 'a', 'b']);
});
