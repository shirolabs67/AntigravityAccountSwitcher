import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { AccountWorker, validateWorkerWorkspace, WorkerError } from '../dist/worker.js'

const group = 'Gemini Models'
const fixture = [
  "const readline = require('node:readline')",
  "const [mode, response, command] = process.argv.slice(2)",
  "if (command === '-p') {",
  "  if (mode === 'timeout') setInterval(() => {}, 1_000)",
  "  else if (mode === 'auth') { process.stderr.write('authentication required: test secret'); process.exitCode = 1 }",
  "  else if (mode === 'oversize') process.stdout.write('x'.repeat(1_100_000))",
  "  else process.stdout.write(response)",
  "} else if (mode === 'invalid-acp') {",
  "  process.stdout.write('not ACP and contains test secret\\n')",
  "} else {",
  "  const lines = readline.createInterface({ input: process.stdin })",
  "  let sequence = 0",
  "  lines.on('line', line => {",
  "    const frame = JSON.parse(line)",
  "    const response = JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { frame, sequence: ++sequence, cwd: process.cwd(), hasProfile: process.env.USERPROFILE !== undefined } })",
  "    process.stdout.write(response.slice(0, 8))",
  "    process.stdout.write(response.slice(8) + '\\n')",
  "  })",
  "}",
].join('\n')

function usage(buckets, name = group) {
  return JSON.stringify({
    status: 'SUCCESS',
    command: { data: { groups: [{ name, buckets }] } },
  })
}

const weekly = fraction => ({ id: 'gemini-weekly', window: 'weekly', remaining_fraction: fraction })
const short = fraction => ({ id: 'gemini-5h', window: '5h', remaining_fraction: fraction })

async function setup(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'aas-worker-test-'))
  const script = join(cwd, 'fake-agy.cjs')
  await writeFile(script, fixture)
  const workers = []
  const spawned = []
  t.after(async () => {
    for (const worker of workers) worker.closeAll()
    await Promise.all(spawned.map(({ done }) => done))
    await unlink(script)
    await rmdir(cwd)
  })
  return {
    cwd,
    spawned,
    worker(mode, response = '', probeTimeoutMs = 5_000) {
      const worker = new AccountWorker({
        agyPath: process.execPath,
        cwd,
        geminiDir: join(cwd, 'profile'),
        probeTimeoutMs,
      }, (path, args, options) => {
        const child = spawn(path, [script, mode, response, ...args], options)
        const done = new Promise(resolve => child.once('close', resolve))
        spawned.push({ path, args, options, done })
        return child
      })
      workers.push(worker)
      return worker
    },
  }
}

const category = code => error => error instanceof WorkerError && error.code === code
  && !error.message.includes('test secret')

test('quota probes use the local profile and accept the real weekly and five-hour windows', async t => {
  const context = await setup(t)
  const worker = context.worker('quota', usage([weekly(0.05), short(0)]))
  assert.deepEqual(await worker.probe(group), { weekly: 0.05, fiveHour: 0 })
  const [probe] = context.spawned
  assert.deepEqual(probe.args, ['-p', '/usage', '--output-format', 'json', '--gemini-dir', join(context.cwd, 'profile')])
  assert.deepEqual(probe.options, { cwd: context.cwd, windowsHide: true, shell: false, stdio: 'pipe' })
})

test('missing, ambiguous, disabled and malformed quotas remain unknown', async t => {
  const context = await setup(t)
  const examples = [
    usage([weekly(1), short(1)], 'Other Group'),
    usage([weekly(0.1)]),
    usage([weekly(0.1), weekly(0.3), short(1)]),
    usage([weekly(1), { ...short(0), disabled: true }]),
    usage([weekly(undefined), short(0)]),
    usage([weekly('0.05'), short(1)]),
    usage([weekly(1.1), short(1)]),
    '{not-json}',
  ]
  await Promise.all(examples.map(response =>
    assert.rejects(context.worker('quota', response).probe(group), category('quota-invalid')),
  ))
})

test('quota probe failures distinguish login, timeout, output limits and shutdown', async t => {
  const context = await setup(t)
  const pending = context.worker('timeout')
  const aborted = assert.rejects(pending.probe(group), category('quota-unavailable'))
  pending.closeAll()
  await Promise.all([
    aborted,
    assert.rejects(context.worker('auth').probe(group), category('quota-auth')),
    assert.rejects(context.worker('timeout', '', 100).probe(group), category('quota-timeout')),
    assert.rejects(context.worker('oversize').probe(group), category('quota-invalid')),
  ])
})

test('ACP streams isolate reused request IDs and preserve extensions while replacing local paths', { timeout: 10_000 }, async t => {
  const context = await setup(t)
  const worker = context.worker('acp')
  let closed = 0
  const frame = {
    jsonrpc: '2.0',
    id: 17,
    method: 'session/new',
    params: {
      cwd: 'remote-machine-only',
      additionalDirectories: ['remote-machine-only'],
      mcpServers: [],
      _meta: { antigravity: { systemPrompt: { append: '测试上下文' } } },
    },
  }
  function turn(stream) {
    const result = new Promise(resolve => worker.open(stream, resolve, () => { closed++ }))
    worker.send(stream, frame)
    return result
  }
  const first = turn('one')
  const second = turn('two')
  assert.throws(() => worker.open('one', () => {}, () => {}), category('stream-invalid'))
  for (const response of await Promise.all([first, second])) {
    assert.equal(response.id, 17)
    assert.equal(response.result.sequence, 1)
    assert.equal(response.result.cwd, context.cwd)
    assert.equal(response.result.hasProfile, process.env.USERPROFILE !== undefined)
    assert.deepEqual(response.result.frame.params, {
      cwd: context.cwd,
      mcpServers: [],
      _meta: frame.params._meta,
    })
  }
  assert.deepEqual(context.spawned[0].args, [
    'acp', '--process-per-session', '--disable-telemetry', '--agent', 'dsh-bridge',
    '--gemini-dir', join(context.cwd, 'profile'),
  ])
  worker.close('one')
  worker.close('one')
  assert.throws(() => worker.send('one', frame), category('stream-unavailable'))
  worker.closeAll()
  assert.equal(closed, 2)
  assert.equal(frame.params.cwd, 'remote-machine-only')
})

test('invalid child stdout closes the affected ACP stream without forwarding it', { timeout: 10_000 }, async t => {
  const context = await setup(t)
  const worker = context.worker('invalid-acp')
  let forwarded = 0
  await new Promise(resolve => worker.open('bad', () => { forwarded++ }, resolve))
  assert.equal(forwarded, 0)
  assert.throws(() => worker.send('bad', { jsonrpc: '2.0' }), category('stream-unavailable'))
})

test('worker startup requires the configured workspace agent to exist and be readable', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'aas-worker-agent-test-'))
  const customizations = join(cwd, '.agents')
  const agents = join(customizations, 'agents')
  const agent = join(agents, 'dsh-bridge.md')
  t.after(async () => {
    await unlink(agent)
    await rmdir(agents)
    await rmdir(customizations)
    await rmdir(cwd)
  })
  await mkdir(agents, { recursive: true })
  await assert.rejects(validateWorkerWorkspace(cwd), category('agent-missing'))
  await writeFile(agent, '')
  await assert.rejects(validateWorkerWorkspace(cwd), category('agent-missing'))
  await writeFile(agent, '---\nname: dsh-bridge\n---\n')
  await validateWorkerWorkspace(cwd)
})
