// esbuild CSS-Modules shim.
//
// The harness compiles `x.module.css` into a hashed class map and injects the
// sheet at factory execution. Outside the monorepo we reproduce that here: the
// sheet becomes a string injected into <head> the first time the factory runs,
// and the module's DEFAULT EXPORT is the class map that client.ts reads as
// `styles`.
//
// The default export matters: esbuild compiles `import styles from './x.css'`
// into a namespace read of `.default`, so emitting only a bare `module.exports`
// object yields `undefined` at runtime. The `__esModule` marker is what tells
// esbuild this CJS module's exports object carries a real `default`.

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

/** Collect `.name` selectors, ignoring at-rule and property dots. */
function parseClasses(source) {
  const names = new Set()
  for (const match of source.matchAll(/(^|[\s,>+~{])\.(-?[_a-zA-Z][\w-]*)/g)) names.add(match[2])
  return Object.fromEntries([...names].map(name => [name, name]))
}

export const cssModulesPlugin = {
  name: 'dsh-css-modules',
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, async args => {
      const source = await readFile(args.path, 'utf8')
      const hashed = parseClasses(source)

      let out = source
      for (const name of Object.keys(hashed)) {
        const hash = createHash('sha256').update(`${name} ${source}`).digest('hex').slice(0, 8)
        const local = `${hash}_${name}`
        hashed[name] = local
        // Replace only the WHOLE class token. A plain `replaceAll('.name')`
        // also hits `.nameLonger`, which merged `.diag` / `.diagSummary` /
        // `.diagList` into one rule and left the longer two unstyled.
        out = out.replace(
          new RegExp(`\\.${name}(?![A-Za-z0-9_-])`, 'g'),
          `.${local}`,
        )
      }

      const sheet = JSON.stringify(out)
      const owner = JSON.stringify(`dsh-provider-proxy/${args.path.split(/[\\/]/).pop()}`)

      // The class map must be reachable as the module's DEFAULT export.
      // esbuild compiles `import styles from './x.css'` to
      // `__toESM(require_x(), 1)`, and in that node-compat mode it OVERWRITES
      // `default` with the whole `module.exports` object — so a
      // `{ default: map }` shape yields the wrapper, and every `styles.x` read
      // is undefined, which is why the page rendered completely unstyled.
      //
      // Assigning the map straight onto `module.exports` makes `default` (and
      // the named keys) the map itself, so both the ESM default and a bare
      // property read resolve correctly.
      const contents = `
var __dshMap = ${JSON.stringify(hashed)};
var __dshStyles = (globalThis.__dshPluginStyles || (globalThis.__dshPluginStyles = new Set()));
if (!__dshStyles.has(${owner})) {
  __dshStyles.add(${owner});
  var __dshStyle = document.createElement('style');
  __dshStyle.setAttribute('data-plugin-css', ${owner});
  __dshStyle.textContent = ${sheet};
  document.head.appendChild(__dshStyle);
}
module.exports = __dshMap;
module.exports.default = __dshMap;
module.exports.__esModule = true;
`

      return { contents, loader: 'js' }
    })
  },
}

export default cssModulesPlugin
