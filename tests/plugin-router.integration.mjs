import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { Router } from '../dist/router.js';
import { AntigravityAdapter } from '../dsh-plugin/lib/adapter.js';
import { Config } from '../dsh-plugin/lib/config.js';
import { AntigravityRuntime } from '../dsh-plugin/lib/runtime.js';

const model = 'gemini-4-argon';
const provider = 'antigravity';
const turn = (id, role, content, source) => ({ id, role, source, content: [{ type: 'text', text: content }] });
const user = (id, text) => turn(id, 'user', text, { kind: 'user' });
const answer = (id, text) => turn(id, 'assistant', text, { kind: 'model', provider, model });
const textOf = chunks => chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('');

test('real DSH adapter and router switch accounts, replay own history, and return normal exhaustion', { timeout: 15_000 }, async t => {
  const quotas = new Map([['a', 0.05], ['b', 0.30]]);
  const seen = [];
  const checked = [];
  let sessionCounter = 0;
  const directory = {
    async probe(account, group) {
      assert.equal(group, 'Gemini Models');
      checked.push(account);
      return { weekly: 0.50, fiveHour: quotas.get(account) };
    },
    async open(account) {
      let onFrame;
      let onClose;
      const send = frame => queueMicrotask(() => onFrame?.({ jsonrpc: '2.0', ...frame }));
      return {
        onFrame(fn) { onFrame = fn; },
        onClose(fn) { onClose = fn; },
        close() { onClose?.(); },
        send({ id, method, params }) {
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
        },
      };
    },
  };
  const config = { accounts: ['a', 'b'], modelGroups: { [model]: 'Gemini Models' },
    instances: { 'dsh-a': { mcpPort: 43101 }, 'dsh-b': { mcpPort: 43102 } } };
  const router = new Router(config, directory);

  async function dsh(id) {
    const home = await mkdtemp(join(tmpdir(), 'aas-joint-'));
    const runtime = new AntigravityRuntime({
      config: Config({ home, autoPatch: false, warmup: false,
        proxy: { host: 'router.example.test', user: 'aas-test', remotePort: config.instances[id].mcpPort,
          identityFile: join(home, 'id'), knownHostsFile: join(home, 'known_hosts') } }),
      spawnAcp() {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const source = createInterface({ input: stdin });
        let resolve;
        const exited = new Promise(done => { resolve = done; });
        const connection = router.connect(id, frame => stdout.write(JSON.stringify(frame) + '\n'));
        source.on('line', line => { void connection.receive(JSON.parse(line)); });
        const close = () => {
          connection.close();
          source.close();
          stdin.end();
          stdout.end();
          resolve({ code: 0, signal: null });
        };
        return { stdin, stdout, exited, terminate: close, stderrTail: () => '' };
      },
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
