import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { apply as applyRetry } from '@deepseek-ai/dsh-llm-retry'
import { AntigravityAdapter } from '../lib/adapter.js'
import { Config } from '../lib/config.js'
import { proxyArgv } from '../lib/proxy.js'
import { AntigravityRuntime } from '../lib/runtime.js'

const extension = 'antigravityAccountSwitcher'
const acquire = '_' + extension + '/acquireTurn'
const switchOptions = { _meta: { [extension]: { switchAccount: true } } }
const model = 'gemini-4-argon'
const provider = 'antigravity'
const message = (id, role, text, source) => ({ id, role, content: [{ type: 'text', text }], source })
const user = (id, text) => message(id, 'user', text, { kind: 'user' })
const sys = message('system', 'system', 'PRIVATE SYSTEM PROMPT', { kind: 'system-prompt' })
const assistant = (id, chunks) => ({
  id, role: 'assistant', source: { kind: 'model', provider, model },
  content: chunks.filter(c => c.type === 'block-end').map(c => c.block),
})
const tool = (id, toolCallId, text) => ({
  ...message(id, 'tool', text, { kind: 'tool', callId: toolCallId }),
  toolCallId,
})
const echo = { name: 'echo', description: 'Echo a string', parameters: { type: 'object', properties: { text: { type: 'string' } } } }
const textOf = chunks => chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
const rpcMeta = params => params._meta?.[extension]
const err = (code, message) => ({ code, message })

function setup(t, { switchAccountOnNextTurn = false, switchAccountEnabled = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'aas-plugin-'))
  const proxy = {
    host: 'router.example.test', user: 'dsh_test', remotePort: 17223,
    identityFile: join(home, 'id test'), knownHostsFile: join(home, 'known hosts'), switchAccountOnNextTurn,
  }
  const state = {
    account: 'a', generation: '1', fail: undefined, quotaDetails: undefined, packets: [], arguments: [], pending: new Map(),
    mcpRequests: [], localProbes: 0, lastSpawn: 0, switchError: undefined,
  }
  let nextLease = 0
  let nextSession = 0
  const spawnAcp = argv => {
    state.arguments.push(argv)
    const connection = ++state.lastSpawn
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const lines = createInterface({ input: stdin })
    const signal = new AbortController()
    let exit
    const exited = new Promise(resolve => { exit = resolve })
    const leases = new Map()
    const sessions = new Map()
    const close = () => {
      signal.abort()
      lines.close()
      stdin.end()
      stdout.end()
      exit({ code: 255, signal: null })
    }
    const write = frame => {
      if (!signal.signal.aborted) stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n')
    }
    lines.on('line', line => {
      const { id, method, params } = JSON.parse(line)
      state.packets.push({ connection, method, params })
      const result = value => write({ id, result: value })
      const fail = error => write({ id, error })
      const session = sessions.get(params.sessionId)
      const update = text => write({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } })
      switch (method) {
        case 'initialize':
          result({ protocolVersion: 1, _meta: { [extension]: { version: 1, switchAccount: switchAccountEnabled } } })
          break
        case acquire: {
          if (state.fail === 'quota') return fail({ ...err(-32040, 'quota unavailable'), data: state.quotaDetails })
          if (rpcMeta(params)?.switchAccount === true && state.switchError !== undefined) return fail(state.switchError)
          const exhausted = state.account === undefined
          const lease = {
            status: exhausted ? 'exhausted' : 'selected',
            leaseId: 'lease-' + ++nextLease, accountId: state.account,
            generationId: exhausted ? 'exhausted' : state.generation,
          }
          leases.set(lease.leaseId, lease)
          result(lease)
          break
        }
        case '_' + extension + '/releaseTurn':
          leases.delete(params.leaseId)
          result({})
          break
        case 'session/new': {
          const lease = leases.get(rpcMeta(params)?.leaseId)
          if (lease === undefined) return fail(err(-32042, 'missing lease'))
          const sessionId = 'proxy-' + ++nextSession
          const nativeSessionId = lease.status === 'selected' ? 'native-' + nextSession : undefined
          sessions.set(sessionId, { generationId: lease.generationId, nativeSessionId, mcp: params.mcpServers[0] })
          result({ sessionId, _meta: { [extension]: { nativeSessionId } }, configOptions: [
            { id: 'model', currentValue: 'old-model', options: [{ value: model }] },
            { id: 'thought_level', currentValue: 'medium', options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] },
          ] })
          break
        }
        case 'session/set_config_option':
          if (leases.get(rpcMeta(params)?.leaseId)?.generationId !== session?.generationId) return fail(err(-32042, 'missing lease'))
          result({})
          break
        case 'session/prompt': {
          const lease = leases.get(rpcMeta(params)?.leaseId)
          if (lease === undefined || lease.generationId !== session?.generationId) return fail(err(-32042, 'stale route'))
          if (state.fail === 'ssh') return close()
          if (state.fail === 'worker') return fail(err(-32041, 'worker transport was lost'))
          if (lease.status === 'exhausted') {
            update('余额不足')
            return result({ stopReason: 'end_turn' })
          }
          const prompt = params.prompt.map(block => block.text ?? '').join('\n')
          if (prompt.includes('ABORT NOW')) {
            state.pending.set(params.sessionId, { cancel: () => result({ stopReason: 'cancelled' }) })
            return
          }
          if (prompt.includes('PARK ONE TOOL') && !prompt.includes('<dsh_history>')) {
            const body = {
              jsonrpc: '2.0', id: 1, method: 'tools/call',
              params: { name: 'echo', arguments: { text: 'once' }, _meta: { 'antigravity.google/conversation_id': session.nativeSessionId } },
            }
            state.mcpRequests.push(body)
            state.pending.set(params.sessionId, { fail: () => fail(err(-32041, 'worker lost after parking')) })
            void fetch(session.mcp.url, {
              method: 'POST', signal: signal.signal,
              headers: { ...Object.fromEntries(session.mcp.headers.map(h => [h.name, h.value])), 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }).then(async response => {
              const payload = await response.text()
              if (state.pending.delete(params.sessionId)) {
                update(lease.accountId + ' tool result ' + payload)
                result({ stopReason: 'end_turn' })
              }
            }).catch(() => {})
            return
          }
          update(lease.accountId + ' reply')
          result({ stopReason: 'end_turn' })
          break
        }
        case 'session/cancel': {
          const lease = leases.get(rpcMeta(params)?.leaseId)
          if (lease !== undefined) state.pending.get(params.sessionId)?.cancel?.()
          state.pending.delete(params.sessionId)
          break
        }
        case 'session/close':
          sessions.delete(params.sessionId)
          result({})
          break
      }
    })
    return { stdin, stdout, exited, terminate: close, stderrTail: () => '' }
  }
  const runtime = new AntigravityRuntime({
    config: Config({ home, proxy, parkSettleMs: 0, warmup: false, autoPatch: false }),
    spawnAcp,
    runCommand: () => { state.localProbes++; throw new Error('Proxy ran a local agy command') },
    readImage: async () => undefined,
    canReadImages: () => false,
    log: { warn: () => {}, info: () => {} },
    onModelsChanged: () => {},
  })
  const adapter = new AntigravityAdapter(runtime, 'Antigravity', () => false)
  t.after(async () => {
    await runtime.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  const packets = method => state.packets.filter(packet => packet.method === method)
  const request = (sessionId, messages, options = {}) => adapter.stream({ provider, model, sessionId, messages, tools: [echo], reasoningEffort: 'low', ...options })
  return { adapter, runtime, state, packets, proxy, request }
}

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

test('proxy SSH argv binds the actual loopback bridge, pins host keys, and supplies no remote command', async t => {
  const { runtime, state, proxy, packets } = setup(t)
  assert.equal(Config({}).proxy, undefined)
  assert.throws(() => Config({ proxy: { host: 'x' } }), /user/)
  await runtime.warmup()
  assert.equal(packets('initialize').length, 1)
  assert.equal(packets('session/new').length, 0)
  const argv = state.arguments[0]
  assert.equal(argv[0], 'ssh')
  assert.equal(argv.at(-1), proxy.host)
  assert.equal(argv[argv.indexOf('-R') + 1], '127.0.0.1:' + proxy.remotePort + ':127.0.0.1:' + runtime.bridge.localPort)
  for (const option of ['StrictHostKeyChecking=yes', 'ExitOnForwardFailure=yes', 'IdentitiesOnly=yes', 'GlobalKnownHostsFile=none']) {
    assert.ok(argv.includes(option))
  }
  assert.equal((await runtime.readQuota()).status, 'error')
  assert.equal(state.localProbes, 0)
  const normalized = Config({ proxy }).proxy
  assert.throws(() => proxyArgv({ ...normalized, host: '-oProxyCommand=evil' }, 12345), /host/)
  assert.throws(() => proxyArgv({ ...normalized, knownHostsFile: 'relative' }, 12345), /literal absolute/)
})

test('profile switch arms one new main turn and stays out of warmup, title, and tool continuation', async t => {
  const { request, runtime, packets } = setup(t, { switchAccountOnNextTurn: true, switchAccountEnabled: true })
  await runtime.warmup()
  assert.equal(packets(acquire).length, 0)
  await collect(request('chat', [user('title', 'name this chat')], { purpose: 'session-title' }))

  const initial = [sys, user('main', 'PARK ONE TOOL')]
  const step = await collect(request('chat', initial))
  const call = step.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block
  const continued = [...initial, assistant('answer', step), tool('tool-result', call.id, 'tool result')]
  const resumed = await collect(request('chat', continued, switchOptions))
  assert.match(textOf(resumed), /^a tool result /)
  await collect(request('chat', [...continued, assistant('resumed', resumed), user('next', 'next question')]))

  assert.deepEqual(packets(acquire).map(packet => rpcMeta(packet.params)), [undefined, { switchAccount: true }, undefined])
  assert.ok(packets('session/prompt').every(packet => rpcMeta(packet.params)?.switchAccount === undefined))
})

test('a switch requires advertised authorization and does not fall back after rejection', async t => {
  const unsupported = setup(t)
  const input = [user('request', 'hello')]
  await assert.rejects(collect(unsupported.request('chat', input, switchOptions)), { code: 'PROXY_ACCOUNT_SWITCH_DISABLED' })
  assert.equal(unsupported.packets(acquire).length, 0)
  assert.equal(textOf(await collect(unsupported.request('chat', input))), 'a reply')

  const { request, packets, state } = setup(t, { switchAccountEnabled: true })
  state.switchError = { ...err(-32044, 'switch failed'), data: { kind: 'account_switch_unavailable', reason: 'no_current_account' } }
  await assert.rejects(collect(request('chat', input, switchOptions)), { code: 'PROXY_ACCOUNT_SWITCH_UNAVAILABLE', message: /Send an ordinary turn first/ })
  assert.deepEqual(packets(acquire).map(packet => rpcMeta(packet.params)), [{ switchAccount: true }])
  assert.equal(packets('session/prompt').length, 0)
  assert.equal(textOf(await collect(request('chat', input))), 'a reply')
})

test('a parked tool and its callback stay with the old account while another chat switches', async t => {
  const { request, state, packets } = setup(t)
  const initial = [sys, user('a1', 'PARK ONE TOOL')]
  const step1 = await collect(request('chatA', initial))
  assert.equal(step1.at(-1).reason.kind, 'tool-calls')
  const call = step1.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block
  assert.equal(call.name, 'echo')
  assert.equal(state.mcpRequests[0].params._meta['antigravity.google/conversation_id'], 'native-1')
  assert.equal(packets('_' + extension + '/releaseTurn').length, 0)

  state.account = 'b'
  state.generation = '2'
  const other = await collect(request('chatB', [sys, user('b1', 'private chat B')]))
  assert.equal(textOf(other), 'b reply')
  assert.equal(packets('_' + extension + '/releaseTurn')[0].params.leaseId, 'lease-2')

  const toolHistory = [...initial, assistant('a2', step1), tool('t1', call.id, 'private chat A result')]
  const resumed = await collect(request('chatA', toolHistory))
  assert.match(textOf(resumed), /^a tool result .*private chat A result/s)
  assert.equal(packets('session/prompt').length, 2)
  assert.equal(packets('_' + extension + '/acquireTurn').length, 2)
  assert.equal(packets('_' + extension + '/releaseTurn')[1].params.leaseId, 'lease-1')

  const next = await collect(request('chatA', [...toolHistory, assistant('a3', resumed), user('a4', 'new question')]))
  assert.equal(textOf(next), 'b reply')
  const open = packets('session/new').at(-1)
  assert.match(open.params._meta.antigravity.systemPrompt.append, /PRIVATE SYSTEM PROMPT/)
  assert.equal(rpcMeta(open.params).leaseId, 'lease-3')
  const lastPrompt = packets('session/prompt').at(-1).params
  assert.equal(lastPrompt.sessionId, 'proxy-3')
  const replay = lastPrompt.prompt.map(block => block.text ?? '').join('\n')
  assert.match(replay, /<dsh_history>.*private chat A result/s)
  assert.doesNotMatch(replay, /private chat B/)
  assert.equal(state.localProbes, 0)
})

test('exhausted turns use normal ACP output, disclose no chat history to the synthetic session, and recover', async t => {
  const { request, state, packets } = setup(t)
  state.account = undefined
  const history = [sys, user('user-1', 'private chat history')]
  const exhausted = await collect(request('chat', history))
  assert.equal(textOf(exhausted), '余额不足')
  const open = packets('session/new')[0].params
  assert.equal(open._meta.antigravity, undefined)
  assert.deepEqual(open.mcpServers, [])
  assert.doesNotMatch(JSON.stringify(packets('session/prompt')[0].params.prompt), /private chat history/)
  state.account = 'a'
  const recovered = await collect(request('chat', [...history, assistant('reply-1', exhausted), user('user-2', 'continue')]))
  assert.equal(textOf(recovered), 'a reply')
  assert.match(JSON.stringify(packets('session/prompt').at(-1).params.prompt), /余额不足/)
})

test('submitted SSH and worker failures cannot replay the same input, and DSH retry respects the policy', async t => {
  const { request, state, packets, adapter } = setup(t)
  let recover
  const scheduled = []
  const dispose = []
  applyRetry({
    sessionProjections: { register: () => {}, stateOf: () => ({}) },
    on: (event, handler) => {
      assert.equal(event, 'agent/request-error')
      recover = handler
      return () => {}
    },
    effect: activate => dispose.push(activate()),
  })
  t.after(async () => { for (const fn of dispose) await fn() })
  const requestError = code => recover({
    agent: { session: { append: (...args) => scheduled.push(args) } },
    turn: 1, step: 1, provider, failure: { code, message: 'test' },
    retryPolicy: adapter.providerRetryPolicy(provider), signal: new AbortController().signal,
  }, async () => undefined)
  assert.equal(await requestError('TRANSPORT'), undefined)
  assert.equal(await requestError('SUBMISSION_UNKNOWN'), undefined)
  assert.deepEqual(scheduled, [])

  for (const [index, failure] of ['ssh', 'worker'].entries()) {
    state.fail = failure
    const history = [sys, user('id-' + index, 'once only')]
    await assert.rejects(collect(request('chat', history)), { code: 'SUBMISSION_UNKNOWN' })
    const count = packets('session/prompt').length
    state.fail = undefined
    await assert.rejects(collect(request('chat', history)), { code: 'SUBMISSION_UNKNOWN' })
    assert.equal(packets('session/prompt').length, count)
    assert.equal(textOf(await collect(request('chat', [...history, user('next-' + index, 'new input')]))), 'a reply')
  }
  state.fail = 'quota'
  await assert.rejects(collect(request('chat', [sys, user('quota', 'quota probe')])), { code: 'PROXY_QUOTA_UNAVAILABLE' })
})

test('quota failures surface only allowlisted reasons without exposing router details', async t => {
  const { request, state, packets } = setup(t)
  const secret = 'https://example.test/private-login?token=hidden'
  const accountId = 'private-account-id'
  state.fail = 'quota'
  for (const [details, code, message] of [
    [{ accounts: [{ accountId, reason: 'login_required', raw: secret }] }, 'PROXY_QUOTA_LOGIN_REQUIRED', /Sign in to Antigravity/],
    [{ reason: 'timeout' }, 'PROXY_QUOTA_TIMEOUT', /timed out/],
    [{ accounts: [{ accountId, reason: 'invalid_quota' }] }, 'PROXY_QUOTA_INVALID', /missing or invalid quota fields/],
    [{ accounts: [{ accountId, reason: 'login_required' }, { accountId, reason: 'invalid_quota' }, { accountId, reason: secret }] }, 'PROXY_QUOTA_UNAVAILABLE', /sign-in required.*missing or invalid quota fields.*another probe failure/],
    [{ accounts: [{ accountId, reason: secret }] }, 'PROXY_QUOTA_UNAVAILABLE', /Check the account workers and quota configuration/],
  ]) {
    state.quotaDetails = { kind: 'quota_unknown', ...details }
    await assert.rejects(collect(request('chat', [sys, user('quota', 'quota probe')])), error => {
      assert.equal(error.code, code)
      assert.match(error.message, message)
      assert.ok(!error.message.includes(secret) && !error.message.includes(accountId))
      assert.equal(error.cause, undefined)
      return true
    })
  }
  assert.equal(packets('session/prompt').length, 0)
})

test('worker loss while parked blocks tool continuation and releases its lease', async t => {
  const { request, state, packets } = setup(t)
  const initial = [sys, user('u', 'PARK ONE TOOL')]
  const step = await collect(request('chat', initial))
  const call = step.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block
  const pending = state.pending.get('proxy-1')
  state.pending.delete('proxy-1')
  pending.fail()
  await setImmediate()
  await assert.rejects(collect(request('chat', [...initial, assistant('a', step), tool('t', call.id, 'executed only once')])), { code: 'SUBMISSION_UNKNOWN' })
  assert.equal(packets('session/prompt').length, 1)
  assert.equal(packets('_' + extension + '/releaseTurn')[0].params.leaseId, 'lease-1')
})

test('closing the iterator on a terminal chunk releases the lease, and abort forwards lease-scoped cancellation', async t => {
  const { request, packets } = setup(t)
  for await (const chunk of request('chat', [sys, user('normal', 'finish early')])) {
    if (chunk.type === 'finish') break
  }
  assert.equal(packets('_' + extension + '/releaseTurn').length, 1)
  const signal = AbortSignal.timeout(150)
  const cancelled = await collect(request('abort-chat', [sys, user('abort', 'ABORT NOW')], { signal }))
  assert.equal(cancelled.at(-1).reason.kind, 'aborted')
  assert.equal(rpcMeta(packets('session/cancel')[0].params).leaseId, 'lease-2')
  assert.equal(packets('_' + extension + '/releaseTurn').at(-1).params.leaseId, 'lease-2')
})
