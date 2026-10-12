// Stages a packaged-app-shaped directory around the esbuild bundle (out-vscode-min/) so it can be launched with the stock Electron
// binary and measured like a production build: package.json, product.json, out/, extensions/, node_modules.asar (production
// dependencies only) and node_modules.asar.unpacked (native + WASM files), mirroring the globs in build/gulpfile.vscode.ts.
// Usage (repo root): node --experimental-strip-types docs98/inventory/scripts/stage_bundled_app.ts <appDir>
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { getProductionDependencies } from '../../../build/lib/dependencies.ts';

const root = process.cwd();
const appDir = path.resolve(process.argv[2] ?? '');
if (!process.argv[2] || !fs.existsSync(path.join(root, 'out-vscode-min'))) { console.error('usage: stage_bundled_app.ts <appDir> (run from the repo root after building out-vscode-min)'); process.exit(1); }
const asar = createRequire(import.meta.url)(path.join(root, 'node_modules/asar'));

fs.rmSync(appDir, { recursive: true, force: true });
fs.mkdirSync(appDir, { recursive: true });
const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: 'inherit' });
sh('cp', ['-al', path.join(root, 'out-vscode-min'), path.join(appDir, 'out')]);
sh('cp', ['-al', path.join(root, 'extensions'), path.join(appDir, 'extensions')]);
fs.copyFileSync(path.join(root, 'package.json'), path.join(appDir, 'package.json'));
fs.copyFileSync(path.join(root, 'product.json'), path.join(appDir, 'product.json'));

// production dependencies only, hard-linked into a staging tree that is then archived
const staging = path.join(appDir, '.nm-staging', 'node_modules');
fs.mkdirSync(staging, { recursive: true });
const deps = getProductionDependencies(root).map(d => path.relative(root, d)).filter(d => d.startsWith('node_modules' + path.sep));
let linked = 0;
for (const d of deps) {
	const rel = path.relative('node_modules', d);
	if (rel.split(path.sep).includes('node_modules') && rel.split(path.sep).filter(p => p === 'node_modules').length > 0 && !fs.existsSync(path.join(root, d))) { continue; }
	const dest = path.join(staging, rel);
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	sh('cp', ['-al', path.join(root, d), dest]); linked++;
}
console.log(`staged ${linked} production dependency folders`);

// asar matches `unpack` against basenames (matchBase) and `unpackDir` against directory paths relative to the archive root.
const unpack = '*.{node,wasm}';
const unpackDir = '{node-pty/build/Release,node-pty/lib/worker,node-pty/lib/shared,@vscode/ripgrep/bin,@vscode/vsce-sign/bin,@devcontainers/cli}';
await asar.createPackageWithOptions(staging, path.join(appDir, 'node_modules.asar'), { unpack, unpackDir });
// the build also keeps a few packages as real files next to the archive (spawned as plain Node processes)
for (const keep of ['@vscode/sandbox-runtime', '@pondwader/socks5-server', 'shell-quote', 'zod']) {
	const src = path.join(root, 'node_modules', keep);
	if (fs.existsSync(src)) { const dest = path.join(appDir, 'node_modules', keep); fs.mkdirSync(path.dirname(dest), { recursive: true }); sh('cp', ['-al', src, dest]); }
}
fs.rmSync(path.join(appDir, '.nm-staging'), { recursive: true, force: true });
const size = (p: string) => execFileSync('du', ['-sm', p]).toString().split('\t')[0];
console.log(`node_modules.asar ${size(path.join(appDir, 'node_modules.asar'))} MB, node_modules.asar.unpacked ${size(path.join(appDir, 'node_modules.asar.unpacked'))} MB`);
