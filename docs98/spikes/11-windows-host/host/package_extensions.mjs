// Copies the built-in extensions of a built repo into a package: for each extension the files it ships (manifest, grammars, themes, snippets, compiled code in out/ and client/server
// out/, resources) without sources, tests and source maps, plus the production `dependencies` closure of its package.json (and of client/ and server/) copied flat into its
// node_modules. The dev tree of an extension is 100 to 300 MB (dev dependencies); this keeps what the extension host loads.
// Usage: node package_extensions.mjs <repoRoot> <outDir> [--skip a,b,c] [--only a,b,c]
import fs from 'node:fs';
import path from 'node:path';

const [root, out] = process.argv.slice(2, 4); const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1].split(',') : null; };
if (!root || !out) { console.error('usage: package_extensions.mjs <repoRoot> <outDir> [--skip a,b] [--only a,b]'); process.exit(2); }
const extRoot = path.join(root, 'extensions');
// not shipped: AI and cloud features (out of scope on old Windows, D-008), test extensions, native/auth ones, webview-only ones until webviews work
const SKIP = new Set(['copilot', 'mermaid-markdown-features', 'github', 'github-authentication', 'microsoft-authentication', 'vscode-api-tests', 'vscode-colorize-perf-tests', 'vscode-colorize-tests', 'vscode-test-resolver', 'tunnel-forwarding', 'node_modules', 'types', ...(arg('--skip') || [])]);
const ONLY = arg('--only');
// dependencies that are only used by webview pages (bundled into media) or are telemetry
const SKIP_DEPS = new Set(['mermaid', '@vscode/markdown-editor', '@vscode/observables', '@vscode/extension-telemetry']);
const TELEMETRY_STUB = `'use strict';
// stand-in for @vscode/extension-telemetry: this build sends no telemetry
class TelemetryReporter { constructor() { } sendTelemetryEvent() { } sendTelemetryErrorEvent() { } sendRawTelemetryEvent() { } sendRawTelemetryErrorEvent() { } sendDangerousTelemetryEvent() { } sendDangerousTelemetryErrorEvent() { } dispose() { return Promise.resolve(); } }
module.exports = TelemetryReporter; module.exports.default = TelemetryReporter; module.exports.TelemetryReporter = TelemetryReporter;
`;
const SKIP_DIRS = new Set(['node_modules', 'src', 'test', 'tests', '.vscode', 'build', 'scripts', 'test-workspace', 'markdown-editor-src', 'preview-src', 'testWorkspace', 'fixtures', '.github']);
const SKIP_FILE = /(\.map|\.tsbuildinfo|\.ts|\.mts|package-lock\.json|CONTRIBUTING\.md|cgmanifest\.json|tsconfig[\w.-]*\.json|\.vscodeignore|\.npmignore|\.eslintrc[\w.]*)$/;
const SKIP_MODULE_DIRS = new Set(['test', 'tests', 'docs', 'doc', '.github', 'example', 'examples', '__tests__', 'benchmark']);
const SKIP_MODULE_FILE = /(\.map|\.md|\.markdown|\.ts|\.mts|\.tsbuildinfo|\.flow|\.yml|\.yaml)$/i;

let bytes = 0, files = 0;
function copyFile(src, dst) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); bytes += fs.statSync(dst).size; files++; }
function copyTree(src, dst, { skipDirs, skipFile, keepDts = false }) {
	for (const e of fs.readdirSync(src, { withFileTypes: true })) {
		const s = path.join(src, e.name), d = path.join(dst, e.name);
		if (e.isDirectory()) { if (!skipDirs.has(e.name)) { copyTree(s, d, { skipDirs, skipFile, keepDts }); } }
		else if (e.isFile() || e.isSymbolicLink()) { if (!skipFile.test(e.name) || (keepDts && e.name.endsWith('.d.ts')) || /LICENSE/i.test(e.name)) { try { copyFile(s, d); } catch { /* dangling link */ } } }
	}
}
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
/** where a module lives: next to the package, then the extension's node_modules, then extensions/node_modules, then the repo's */
function findModule(name, from) {
	const roots = [...from.map((f) => (path.basename(f) === 'node_modules' ? f : path.join(f, 'node_modules'))), path.join(extRoot, 'node_modules'), path.join(root, 'node_modules')];
	for (const r of roots) { const p = path.join(r, name); if (fs.existsSync(path.join(p, 'package.json'))) { return p; } }
	return null;
}
/** copies the production dependency closure of the package at srcDir into dstDir/node_modules */
function copyDeps(srcDir, dstDir, search) {
	const seen = new Set(); const todo = [[readJson(path.join(srcDir, 'package.json')), srcDir]];
	while (todo.length) {
		const [pkg, from, parentNm] = todo.pop(); if (!pkg) { continue; }
		for (const dep of Object.keys(pkg.dependencies || {})) {
			if (seen.has(dep)) { continue; } seen.add(dep); if (dep === '@vscode/extension-telemetry') { const d = path.join(dstDir, 'node_modules', dep); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: dep, version: '0.0.0', main: 'index.js' })); fs.writeFileSync(path.join(d, 'index.js'), TELEMETRY_STUB); continue; } if (SKIP_DEPS.has(dep)) { continue; } const p = findModule(dep, [from, ...(parentNm ? [parentNm] : []), ...search]); if (!p) { console.warn(`  missing dependency ${dep} of ${pkg.name}`); continue; }
			if (dep === 'typescript') { copyTypescript(p, path.join(dstDir, 'node_modules', dep)); continue; }
			copyTree(p, path.join(dstDir, 'node_modules', dep), { skipDirs: SKIP_MODULE_DIRS, skipFile: SKIP_MODULE_FILE, keepDts: false });
			const nm = path.dirname(p); todo.push([readJson(path.join(p, 'package.json')), p, path.basename(nm).startsWith('@') ? path.dirname(nm) : nm]);
		}
		for (const dep of Object.keys(pkg.optionalDependencies || {})) { if (!seen.has(dep) && findModule(dep, [from, ...search])) { /* optional natives are not shipped */ } }
	}
}
/** tsserver needs lib/*.js and the lib.*.d.ts files, not the 20 locale folders or the compiler's typings */
function copyTypescript(src, dst) {
	copyFile(path.join(src, 'package.json'), path.join(dst, 'package.json')); if (fs.existsSync(path.join(src, 'LICENSE.txt'))) { copyFile(path.join(src, 'LICENSE.txt'), path.join(dst, 'LICENSE.txt')); }
	for (const e of fs.readdirSync(path.join(src, 'lib'), { withFileTypes: true })) { if (e.isFile() && /^(lib\..*\.d\.ts|[\w.-]+\.js|[\w.-]+\.json)$/.test(e.name) && !e.name.endsWith('.map')) { copyFile(path.join(src, 'lib', e.name), path.join(dst, 'lib', e.name)); } }
}

let n = 0;
for (const name of fs.readdirSync(extRoot).sort()) {
	const dir = path.join(extRoot, name); if (!fs.statSync(dir).isDirectory() || SKIP.has(name) || (ONLY && !ONLY.includes(name)) || !fs.existsSync(path.join(dir, 'package.json'))) { continue; }
	const dst = path.join(out, name); const b0 = bytes;
	copyTree(dir, dst, { skipDirs: SKIP_DIRS, skipFile: SKIP_FILE });
	// client/ and server/ of the language-feature extensions are packages of their own with compiled code in out/
	for (const sub of ['client', 'server']) { const sd = path.join(dir, sub); if (fs.existsSync(path.join(sd, 'package.json'))) { copyFile(path.join(sd, 'package.json'), path.join(dst, sub, 'package.json')); copyDeps(sd, path.join(dst, sub), [dir]); } }
	copyDeps(dir, dst, []); n++;
	console.log(`${name}: ${((bytes - b0) / 1048576).toFixed(1)} MB`);
}
// the TypeScript extension looks for tsserver in extensions/node_modules/typescript
copyTypescript(path.join(extRoot, 'node_modules', 'typescript'), path.join(out, 'node_modules', 'typescript'));
console.log(`${n} extensions, ${files} files, ${(bytes / 1048576).toFixed(1)} MB`);
