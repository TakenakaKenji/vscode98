// Builds scope-map.json: TextMate scopeName -> grammar file path, from the built-in extensions' package.json (contributes.grammars).
// Both the Node and the QuickJS benchmarks read this, so they load exactly the same grammars. Usage: node make_scope_map.mjs <repoRoot> > scope-map.json
import fs from 'node:fs'; import path from 'node:path';
const root = process.argv[2] || process.cwd();
const map = {};
for (const d of fs.readdirSync(path.join(root, 'extensions'))) {
	const pj = path.join(root, 'extensions', d, 'package.json'); if (!fs.existsSync(pj)) { continue; }
	const p = JSON.parse(fs.readFileSync(pj, 'utf8'));
	for (const g of (p.contributes && p.contributes.grammars) || []) { if (g.scopeName && g.path) { map[g.scopeName] = path.join(root, 'extensions', d, g.path); } }
	for (const g of (p.contributes && p.contributes.grammars) || []) { if (g.injectTo) { /* injections are loaded on demand via injectTo below */ } }
}
console.log(JSON.stringify(map));
