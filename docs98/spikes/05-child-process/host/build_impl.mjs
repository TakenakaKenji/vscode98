// Bundles npm `readable-stream` 3.6.0 (the pure-JS Node-10-era streams) and `string_decoder` into ES modules usable on QuickJS as the `stream` and
// `string_decoder` shims. `events`/`util`/`buffer` are NOT bundled: they are mapped to the spike's own shims (so `instanceof EventEmitter` agrees across modules).
// Usage: node build_impl.mjs <implOutDir> <shimsDir>      (shimsDir = the gen_shims.mjs outDir/shims, where events.js etc. will live)
import { createRequire } from 'node:module';
const { build } = createRequire(import.meta.url)(process.env.ESBUILD_DIR || '../../../../build/node_modules/esbuild');
import fs from 'node:fs';
import path from 'node:path';
const [outDir, shimsDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const root = path.resolve(import.meta.dirname, '../../../../node_modules');
// `require('events'|'util'|'buffer')` inside the CommonJS packages resolves to tiny ESM adapters that re-export the spike's shims (esbuild turns an external
// require() into a throwing __require, so the shim import must be a real static ESM import in the output).
const adapter = { name: 'adapter', setup(b) {
	b.onResolve({ filter: /^(events|util|buffer)$/ }, a => ({ path: a.path, namespace: 'adapter' }));
	b.onResolve({ filter: /\/shims\/[\w@.-]+\.js$/ }, a => ({ path: a.path, external: true }));
	b.onLoad({ filter: /.*/, namespace: 'adapter' }, a => ({ contents: a.path === 'buffer' ? `export const Buffer = globalThis.Buffer;` : `import X from '${shimsDir}/${a.path}.js'; export default X; export * from '${shimsDir}/${a.path}.js';`, resolveDir: root }));
} };
const common = { bundle: true, format: 'esm', platform: 'browser', mainFields: ['browser', 'main'], target: 'es2020', logLevel: 'warning', nodePaths: [root], plugins: [adapter] };
// stream: CommonJS readable-stream -> ESM with named exports
fs.writeFileSync(path.join(outDir, '.stream_entry.js'), `import * as S from '${root}/readable-stream/readable-browser.js';\nconst m = S.default;\nexport default m;\nexport const { Readable, Writable, Duplex, Transform, PassThrough, Stream, finished, pipeline } = m;\n`);
await build({ ...common, entryPoints: [path.join(outDir, '.stream_entry.js')], outfile: path.join(outDir, 'stream.js') });
// string_decoder
fs.writeFileSync(path.join(outDir, '.sd_entry.js'), `import * as S from '${root}/string_decoder/lib/string_decoder.js';\nexport const StringDecoder = S.default.StringDecoder;\nexport default S.default;\n`);
await build({ ...common, entryPoints: [path.join(outDir, '.sd_entry.js')], outfile: path.join(outDir, 'string_decoder.js') });
fs.rmSync(path.join(outDir, '.stream_entry.js')); fs.rmSync(path.join(outDir, '.sd_entry.js'));
for (const f of fs.readdirSync(path.join(import.meta.dirname, 'impl'))) { fs.writeFileSync(path.join(outDir, f), fs.readFileSync(path.join(import.meta.dirname, 'impl', f), 'utf8').replaceAll('__SHIMS__', shimsDir)); }
console.log('built', fs.readdirSync(outDir).map(f => f + ' ' + fs.statSync(path.join(outDir, f)).size).join(', '));
