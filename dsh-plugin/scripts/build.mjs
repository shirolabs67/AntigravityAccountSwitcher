#!/usr/bin/env node
// Build: link host peer packages from a DeepSeek Harness checkout, compile
// src/*.ts to lib/*.js, and copy the browser half next to the compiled host
// modules.
//
// The checkout is located by trying, in order:
//   1. the DSH_CHECKOUT environment variable;
//   2. this package or an ancestor directory (a plugin at <repo>/<name> or
//      <repo>/plugins/<name>) that carries packages/llm/llm;
//   3. the checkout behind any `link:` dependency recorded in a ~/.dsh
//      profile — the parent chain of a linked plugin usually reaches it.
// A checkout that carries the peer packages but no built `lib/types` fails the
// compile instead of silently resolving another copy.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checkOnly = process.argv.includes('--check')

const isCheckout = (dir) => existsSync(join(dir, 'packages', 'llm', 'llm', 'package.json'))

/** Nearest ancestor of `dir` (inclusive, up to `depth` levels) that is a checkout. */
function checkoutAbove(dir, depth = 3) {
  let current = resolve(dir)
  for (let level = 0; level <= depth; level += 1) {
    if (isCheckout(current)) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

function inferCheckout() {
  if (process.env.DSH_CHECKOUT) {
    const env = resolve(process.env.DSH_CHECKOUT)
    if (isCheckout(env)) return env
  }
  const near = checkoutAbove(root)
  if (near !== undefined) return near
  try {
    const profiles = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles')
    for (const name of readdirSync(profiles)) {
      const manifest = join(profiles, name, 'package.json')
      if (!existsSync(manifest)) continue
      const dependencies = JSON.parse(readFileSync(manifest, 'utf8')).dependencies ?? {}
      for (const spec of Object.values(dependencies)) {
        const linked = /^link:(.*)$/.exec(String(spec))
        if (linked === null) continue
        const found = checkoutAbove(linked[1])
        if (found !== undefined) return found
      }
    }
  } catch { /* profiles are optional */ }
  return undefined
}

const repo = inferCheckout()
if (repo !== undefined) {
  const links = {
    '@deepseek-ai/dsh-llm': 'packages/llm/llm',
    '@deepseek-ai/dsh-subprocess': 'packages/subprocess/subprocess',
    '@deepseek-ai/dsh-typert-protocol': 'packages/typert/protocol',
    '@deepseek-ai/schemastery': 'vendor/schemastery',
    '@deepseek-ai/cordis': 'vendor/cordis',
    '@types': 'node_modules/@types',
  }
  const isWin = process.platform === 'win32'
  for (const [name, target] of Object.entries(links)) {
    const absolute = join(repo, target)
    if (!existsSync(join(absolute, 'package.json')) && !existsSync(join(absolute, 'node', 'package.json'))) continue
    const link = join(root, 'node_modules', name)
    mkdirSync(dirname(link), { recursive: true })
    const wanted = isWin ? absolute : relative(dirname(link), absolute)
    if (existsSync(link) || isLink(link)) {
      if (isLink(link) && resolve(dirname(link), readlinkSync(link)) === resolve(absolute)) continue
      rmSync(link, { recursive: true, force: true })
    }
    symlinkSync(wanted, link, isWin ? 'junction' : 'dir')
  }
}

const tscCandidates = [
  join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
  repo !== undefined ? join(repo, 'node_modules', 'typescript', 'bin', 'tsc') : undefined,
  join(root, '..', 'node_modules', 'typescript', 'bin', 'tsc'),
  join(root, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc'),
].filter(Boolean)
const tscBin = tscCandidates.find(p => existsSync(p))
if (!tscBin) {
  console.error('typescript compiler not found; install devDependencies or set DSH_CHECKOUT to a DeepSeek Harness checkout')
  process.exit(1)
}

if (checkOnly) {
  const res = spawnSync(process.execPath, [tscBin, '-p', join(root, 'tsconfig.json'), '--noEmit'], { stdio: 'inherit' })
  process.exit(res.status ?? 1)
}

rmSync(join(root, 'lib'), { recursive: true, force: true })
const tsc = spawnSync(process.execPath, [tscBin, '-p', join(root, 'tsconfig.json')], { stdio: 'inherit' })
if (tsc.status !== 0) process.exit(tsc.status ?? 1)
copyFileSync(join(root, 'src', 'client.js'), join(root, 'lib', 'client.js'))
console.log('dsh-llm-antigravity-acp: built lib/')

function isLink(path) {
  try { return lstatSync(path).isSymbolicLink() } catch { return false }
}
