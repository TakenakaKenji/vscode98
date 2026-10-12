// Bundles the standalone Monaco editor (src/vs/editor/editor.main.ts) from this repo's sources into one IIFE + one CSS file with esbuild.
// Usage (repo root, Node 24): node docs98/spikes/06-rendering/host/build_monaco.mjs <outDir> [--es2015]
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
const { build } = createRequire(import.meta.url)(process.env.ESBUILD_DIR || '../../../../build/node_modules/esbuild');
const [outDir] = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, '../../../..');
fs.mkdirSync(outDir, { recursive: true });
const entry = path.join(outDir, '.entry.ts');
fs.writeFileSync(entry, `import * as monaco from '${root}/src/vs/editor/editor.main.ts';\n(globalThis as any).monaco = monaco;\n`);
const r = await build({
	entryPoints: [entry], outfile: path.join(outDir, 'monaco.js'), bundle: true, format: 'iife', platform: 'browser', target: process.argv.includes('--es2015') ? 'es2015' : 'es2022',
	loader: { '.ttf': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' }, logLevel: 'warning', minify: false, sourcemap: false, metafile: true,
	define: { 'process.env.VSCODE_DEV': 'false' },
});
fs.rmSync(entry);
console.log(Object.entries(r.metafile.outputs).map(([k, v]) => `${path.relative(outDir, k)} ${v.bytes}`).join(', '));
