// Feasibility check: the Claude Agent SDK store functions bundle into ONE ESM file (<= 3 MB, target node18)
// that runs under plain Node 18/20/24 against a temp copy of tests/fixtures/claude-home.
// Each runner that passes also drives the real built helper (out/helper, so `npm run build` first) over NDJSON stdio.
// Node majors other than the running one are fetched with `npx -y node@<major>`; a failed download is reported as skipped.
// HELPER_CHECK_NODE18 / HELPER_CHECK_NODE20 (paths to node executables, e.g. from actions/setup-node in CI) replace the
// npx download for that major; a runtime whose major doesn't match its variable fails the check.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_BYTES = 3 * 1024 * 1024
const NODE_MAJORS = [18, 20]
const FUNCTIONS = ['listSessions', 'getSessionInfo', 'getSessionMessages', 'listSubagents', 'getSubagentMessages', 'renameSession', 'forkSession', 'deleteSession']

const ENTRY = `
import { ${FUNCTIONS.join(', ')} } from '@anthropic-ai/claude-agent-sdk'
const dir = process.argv[2]
process.env.CLAUDE_CONFIG_DIR = dir
const results = {}
const step = async (name, fn) => { try { results[name] = { ok: true, detail: await fn() } } catch (e) { results[name] = { ok: false, error: String(e && e.message || e) } } }
const A = '11111111-0000-4000-8000-00000000000a'
const B = '11111111-0000-4000-8000-00000000000b'
const C = '11111111-0000-4000-8000-00000000000c'
let forkId
await step('listSessions', async () => { const l = await listSessions(); if (l.length < 3) throw new Error('expected >=3 sessions, got ' + l.length); return l.length })
await step('getSessionInfo', async () => { const i = await getSessionInfo(A); if (!i || i.sessionId !== A) throw new Error('missing'); return i.sessionId })
await step('getSessionMessages', async () => { const m = await getSessionMessages(A); if (!m.length) throw new Error('empty'); return m.length })
await step('listSubagents', async () => { const s = await listSubagents(A); if (!s.includes('fixture01')) throw new Error(JSON.stringify(s)); return s.length })
await step('getSubagentMessages', async () => { const m = await getSubagentMessages(A, 'fixture01'); if (!m.length) throw new Error('empty'); return m.length })
await step('renameSession', async () => { await renameSession(B, 'helper-check-title'); const i = await getSessionInfo(B); if (i?.customTitle !== 'helper-check-title' && i?.summary !== 'helper-check-title') throw new Error('title not applied'); return 'ok' })
await step('forkSession', async () => { const r = await forkSession(C); forkId = r.sessionId; if (!forkId) throw new Error('no id'); return 'ok' })
await step('deleteSession', async () => { await deleteSession(forkId ?? B); if (forkId && (await getSessionInfo(forkId))) throw new Error('still present'); return 'ok' })
console.log('HELPER_CHECK ' + JSON.stringify(results))
process.exit(Object.values(results).every((r) => r.ok) ? 0 : 1)
`

// Only a failure to fetch the Node runtime counts as "skipped"; anything else (load error, crash, timeout) is a real failure.
const DOWNLOAD_FAILURE = /ENOTFOUND|ETIMEDOUT|EAI_AGAIN|E404|ECONNRESET|npm ERR! network|npm error network/

// shell:true joins argv with spaces unquoted — a temp path with a space would split.
const shellQuote = (a) => (/[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)

function run(cmd, args, opts = {}) {
  const shell = cmd === 'npx' && process.platform === 'win32'
  const r = spawnSync(cmd, shell ? args.map(shellQuote) : args, { encoding: 'utf8', shell, timeout: 240_000, ...opts })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '' }
}

// The real built helper (out/helper, from `npm run build`), deployed under its
// helper-<hash>.mjs name and driven over NDJSON stdio until stdin EOF.
const BUILT_DIR = join(root, 'out', 'helper')
const A_ID = '11111111-0000-4000-8000-00000000000a'
const REQUESTS = [
  { id: 1, method: 'ping', params: {} },
  { id: 2, method: 'store.list', params: {} },
  { id: 3, method: 'store.messages', params: { sessionId: A_ID, offset: 0, limit: 500 } },
  { id: 4, method: 'store.listSubagents', params: { sessionId: A_ID } },
  { id: 5, method: 'store.transcriptPath', params: { sessionId: A_ID } },
  { id: 6, method: 'env.get', params: {} },
  { id: 7, method: 'watch.subscribe', params: {} },
  { id: 8, method: 'no.such', params: {} },
]
function checkBuilt(r, work, hash) {
  const home = join(work, `built-${r.label.replace(/\W/g, '')}`)
  const cfg = join(home, '.claude')
  mkdirSync(join(home, '.agent-workspace'), { recursive: true })
  cpSync(join(root, 'tests', 'fixtures', 'claude-home'), cfg, { recursive: true })
  const file = join(home, '.agent-workspace', `helper-${hash}.mjs`)
  cpSync(join(BUILT_DIR, 'agent-workspace-helper.mjs'), file)
  const res = run(r.cmd, [...r.pre, file, '--stdio'], {
    input: REQUESTS.map((q) => JSON.stringify(q)).join('\n') + '\n',
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: cfg },
  })
  const frames = res.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))
  const byId = new Map(frames.filter((f) => typeof f.id === 'number').map((f) => [f.id, f]))
  const problems = []
  const hello = frames[0]
  if (hello?.method !== 'hello' || hello.params?.protocol !== 1 || hello.params?.hash !== hash) problems.push('hello')
  if (typeof byId.get(1)?.result?.t !== 'number') problems.push('ping')
  if (!(byId.get(2)?.result?.length >= 3)) problems.push('store.list')
  if (!(byId.get(3)?.result?.length > 0)) problems.push('store.messages')
  if (!byId.get(4)?.result?.includes?.('fixture01')) problems.push('store.listSubagents')
  if (typeof byId.get(5)?.result?.path !== 'string') problems.push('store.transcriptPath')
  if (byId.get(6)?.result?.env?.CLAUDE_CONFIG_DIR !== cfg) problems.push('env.get')
  if (!byId.get(7)?.result) problems.push('watch.subscribe')
  if (byId.get(8)?.error?.code !== 'unknown-method') problems.push('unknown-method')
  if (res.code !== 0) problems.push(`exit ${res.code}`)
  return { problems, out: res.out }
}

const work = mkdtempSync(join(tmpdir(), 'helper-bundle-check-'))
const bundle = join(work, 'bundle.mjs')
let failed = false
const passed = []
const skipped = []
try {
  await build({
    stdin: { contents: ENTRY, resolveDir: root, loader: 'js', sourcefile: 'helper-entry.mjs' },
    outfile: bundle, bundle: true, platform: 'node', target: 'node18', format: 'esm', minify: true, logLevel: 'error',
  })
  const size = statSync(bundle).size
  if (size > MAX_BYTES) { failed = true; console.error(`bundle ${size} bytes exceeds ${MAX_BYTES}`) }
  let builtHash = null
  try {
    builtHash = JSON.parse(readFileSync(join(BUILT_DIR, 'helper-hash.json'), 'utf8')).hash
    if (statSync(join(BUILT_DIR, 'agent-workspace-helper.mjs')).size >= MAX_BYTES) { failed = true; console.error('built helper exceeds 3 MB') }
  } catch {
    failed = true
    console.error('out/helper is missing - run `npm run build` first')
  }

  const runners = [{ label: `node${process.versions.node.split('.')[0]}(local)`, cmd: process.execPath, pre: [] }]
  for (const m of NODE_MAJORS) {
    const preinstalled = process.env[`HELPER_CHECK_NODE${m}`]?.trim()
    if (!preinstalled) { runners.push({ label: `node${m}`, cmd: 'npx', pre: ['-y', `node@${m}`] }); continue }
    const v = run(preinstalled, ['-p', 'process.versions.node'])
    const major = Number(v.stdout.trim().split('.')[0])
    if (v.code !== 0 || major !== m) {
      failed = true
      console.error(`HELPER_CHECK_NODE${m}: expected a Node ${m} executable, got exit ${v.code} version '${v.stdout.trim()}'`)
      continue
    }
    runners.push({ label: `node${m}(${v.stdout.trim()})`, cmd: preinstalled, pre: [] })
  }
  for (const r of runners) {
    const home = join(work, `home-${r.label.replace(/\W/g, '')}`)
    mkdirSync(home)
    cpSync(join(root, 'tests', 'fixtures', 'claude-home'), home, { recursive: true })
    const res = run(r.cmd, [...r.pre, bundle, home])
    console.error(`${r.label}: exit ${res.code} ${res.out.slice(0, 1200)}`)
    if (res.code === 0 && res.out.includes('HELPER_CHECK')) passed.push(r.label)
    else if (r.pre.length && !res.out.includes('HELPER_CHECK') && DOWNLOAD_FAILURE.test(res.out)) { skipped.push(r.label); continue }
    else { failed = true; continue }
    if (builtHash) {
      const b = checkBuilt(r, work, builtHash)
      console.error(`${r.label}: built helper ${b.problems.length ? `FAIL [${b.problems.join(', ')}] ${b.out.slice(0, 1200)}` : 'OK'}`)
      if (b.problems.length) { failed = true; passed.pop() }
    }
  }
  if (!passed.length) failed = true
  if (skipped.length) {
    if (process.env.CI) failed = true
    else console.error(`WARNING: ${skipped.join(', ')} not verified (runtime download failed); the Node 18 floor is unproven.`)
  }
  console.log(`helper-bundle-check ${failed ? 'FAIL' : 'OK'}: ${(size / 1024).toFixed(0)} KB, passed [${passed.join(', ')}]${skipped.length ? `, skipped [${skipped.join(', ')}]` : ''}`)
} catch (e) {
  failed = true
  console.error(e)
  console.log('helper-bundle-check FAIL')
} finally {
  rmSync(work, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
