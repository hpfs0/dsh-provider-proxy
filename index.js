// Loader compatibility shim.
//
// cordis-plugin-loader resolves an entry as "<package>/index.js" by convention
// and does NOT read package.json `main`/`exports`, so a package installed into
// a profile must expose this file. The implementation lives in ./lib/index.js.
export * from './lib/index.js'