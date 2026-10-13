// Packaging guards.
//
// These check the SHIPPED tarball rather than the source. Every failure here
// was a real one found by installing the packed tarball into an empty project:
// the plugin shipped with a `lib/types` entry that was never built, with
// sourcemaps generated but excluded, and — worst — with `@deepseek-ai/schemastery`
// marked external while the code loaded it at runtime, so a clean install threw
// "no usable @deepseek-ai/schemastery in this installation" on import.

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/**
 * Run a command, cross-platform.
 *
 * `npm` resolves to `npm.cmd` on Windows, and that is a BATCH file: spawning
 * it directly fails with EINVAL, so it goes through cmd.exe via `shell: true`.
 *
 * The `prepare` script runs a build that prints to stdout, and that output
 * lands ahead of npm's own JSON. The document is therefore taken from the JSON
 * array inside the buffer rather than from the whole thing.
 */
const run = (cmd, args, opts) => execFileSync(cmd, args, { encoding: 'utf8', shell: true, ...opts })

/** Pull npm's JSON array out of a buffer that may carry build chatter too. */
function parsePackJson(out) {
  const text = String(out)
  const start = text.indexOf('[')
  assert.ok(start >= 0, `npm pack produced no JSON:\n${text}`)
  return JSON.parse(text.slice(start, text.lastIndexOf(']') + 1))
}

test('the package can actually be packed', () => {
  // `npm pack --dry-run` also proves the `files` globs match something real.
  const files = parsePackJson(run('npm', ['pack', '--dry-run', '--json'], { cwd: root }))[0].files
    .map(f => f.path)
  for (const required of ['index.js', 'lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'package.json']) {
    assert.ok(files.includes(required), `${required} must be published`)
  }
})

test('every path named in "files" exists', () => {
  // `lib/types/**` was declared for a directory the build never produced.
  for (const entry of pkg.files) {
    if (entry.includes('*')) continue
    assert.ok(existsSync(join(root, entry)), `files lists "${entry}", which does not exist`)
  }
  assert.ok(
    !pkg.files.some(entry => entry.includes('lib/types')),
    'lib/types is declared but no build step generates it',
  )
})

test('the sourcemaps esbuild produces are actually published', () => {
  const files = parsePackJson(run('npm', ['pack', '--dry-run', '--json'], { cwd: root }))[0].files
    .map(f => f.path)
  for (const map of ['lib/index.js.map', 'lib/client.js.map']) {
    assert.ok(existsSync(join(root, map)), `${map} must be built`)
    assert.ok(files.includes(map), `${map} must be published, or the map comments dangle`)
  }
})

test('schemastery is bundled, so a clean install can load the plugin', () => {
  const bundle = readFileSync(join(root, 'lib/index.js'), 'utf8')
  assert.ok(
    !/from\s+["']@deepseek-ai\/schemastery["']/.test(bundle),
    'schemastery must be inlined; an external import fails on a clean install',
  )
  assert.ok(
    /from\s+["']undici["']/.test(bundle),
    'undici MUST stay external so the dispatcher and fetch share one realm',
  )
})

test('a clean install of the tarball imports without throwing', () => {
  // The definitive check: pack, install into an empty project with NO
  // schemastery, and import it.
  const dir = mkdtempSync(join(tmpdir(), 'dspp-'))
  try {
    const packed = run('npm', ['pack', '--pack-destination', dir], { cwd: root })
    // `npm pack` echoes the build output from `prepare`, then the filename.
    const tarball = packed
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.endsWith('.tgz'))
      .pop()
    assert.ok(tarball, `npm pack printed no tarball name:\n${packed}`)
    run('npm', ['init', '-y'], { cwd: dir, stdio: 'ignore' })
    run('npm', ['install', join(dir, tarball)], { cwd: dir, stdio: 'ignore' })

    const script =
      "import('dsh-provider-proxy').then(m => {" +
      "  if (typeof m.apply !== 'function') throw new Error('no apply export');" +
      "  if (!Array.isArray(m.inject)) throw new Error('no inject export');" +
      "  process.stdout.write('OK ' + m.name + ' ' + JSON.stringify(m.inject));" +
      "}).catch(e => { process.stderr.write('FAIL ' + e.message); process.exit(1); });"
    const out = execFileSync(process.execPath, ['-e', script], { cwd: dir, encoding: 'utf8' })
    assert.match(out, /^OK dsh-provider-proxy \["llm"\]$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the package description matches what it actually does', () => {
  // It used to promise a per-provider card inside Settings → Models, which is
  // where this plugin stopped rendering in 0.2.0-rc.1.
  assert.ok(!pkg.description.includes('Models'), 'the description must not name the abandoned slot')
  assert.match(pkg.description, /provider/i)
})

test('the package declares where its source lives', () => {
  // Without a `repository`, a plugin marketplace has nothing to link to and
  // falls back to guessing a GitHub URL from the package NAME. That guess found
  // someone else's long-standing `dsh-provider-proxy` repository, so the
  // installed plugin opened a page that was not this code.
  const REPO = 'github.com/hpfs0/dsh-provider-proxy'
  assert.ok(pkg.repository, 'package.json must declare a repository')
  assert.ok(
    pkg.repository.url.includes(REPO),
    `repository.url must point at ${REPO}, got ${pkg.repository.url}`,
  )
  assert.ok(pkg.homepage?.includes(REPO), 'homepage must point at the same repository')
  assert.ok(pkg.bugs?.url?.includes(REPO), 'bugs.url must point at the same repository')
  assert.ok(pkg.author, 'package.json must declare an author')
})