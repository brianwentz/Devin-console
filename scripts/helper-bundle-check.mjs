// Feasibility check: the Claude Agent SDK store functions bundle into ONE ESM file (<= 3 MB, target node18)
// that runs under plain Node 18/20/24 against a temp copy of tests/fixtures/claude-home.
// Node majors other than the running one are fetched with `npx -y node@<major>`; a failed download is reported as skipped.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
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

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: cmd === 'npx' && process.platform === 'win32', timeout: 240_000 })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
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

  const runners = [{ label: `node${process.versions.node.split('.')[0]}(local)`, cmd: process.execPath, pre: [] }]
  for (const m of NODE_MAJORS) runners.push({ label: `node${m}`, cmd: 'npx', pre: ['-y', `node@${m}`] })
  for (const r of runners) {
    const home = join(work, `home-${r.label.replace(/\W/g, '')}`)
    mkdirSync(home)
    cpSync(join(root, 'tests', 'fixtures', 'claude-home'), home, { recursive: true })
    const res = run(r.cmd, [...r.pre, bundle, home])
    console.error(`${r.label}: exit ${res.code} ${res.out.slice(0, 1200)}`)
    if (res.code === 0 && res.out.includes('HELPER_CHECK')) passed.push(r.label)
    else if (r.pre.length && !res.out.includes('HELPER_CHECK') && DOWNLOAD_FAILURE.test(res.out)) skipped.push(r.label)
    else failed = true
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
