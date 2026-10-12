// Build both halves.
//
// The browser half must be a classic script in the client module system's
// lazy-CJS factory format — a script that only REGISTERS a factory, with every
// side effect (CSS injection included) inside the closure. This mirrors
// packages/client/tsdown.client.ts in the harness repo and the shipped shape of
// dsh-llm-retry-settings, which was verified against a running desktop profile.

import { build } from 'esbuild'
import { readFileSync } from 'node:fs'

import { cssModulesPlugin } from './css-modules.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const id = pkg.name

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  // BUNDLED, not external, and this matters.
  //
  // `@deepseek-ai/schemastery` was left external on the assumption that the
  // Host would hoist it. It does not: a clean `npm install` of this package
  // pulls no schemastery at all, and importing the plugin fails immediately
  // with "no usable @deepseek-ai/schemastery in this installation".
  //
  // schemastery is pure JavaScript with no dependencies, so bundling it makes
  // the package genuinely self-contained. The loader path in
  // `src/config.ts` still prefers the PROFILE's copy when one is reachable, so
  // a DSH-provided instance stays authoritative and identity is preserved.
  // Only `undici` stays external — it carries Node-version-specific internals
  // and must be the same instance the profile uses.
  external: ['undici', '@deepseek-ai/cordis'],
})

await build({
  entryPoints: ['src/client.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  // React/Cordis come from the shell-seeded module table.
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/cordis'],
  loader: { '.css': 'css' },
  // CSS Modules: `styles` becomes a hashed class map, injected at materialization.
  plugins: [cssModulesPlugin],
  // The CJS `module`/`exports` pair has to exist inside the factory closure,
  // so it is part of the banner rather than a separate esbuild option.
  banner: {
    js:
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {` +
      'var module = { exports: {} }; var exports = module.exports;',
  },
  footer: { js: 'return module.exports; } });' },
})

console.log('built lib/index.js and lib/client.js')