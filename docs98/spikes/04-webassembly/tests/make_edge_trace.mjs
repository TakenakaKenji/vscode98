// Builds an edge-case trace in the same format replay_bench.mjs reads, with the REFERENCE results taken from vscode-oniguruma on V8's WebAssembly.
// Stresses what real source code rarely does: non-ASCII text (offset mapping), surrogate pairs and lone surrogates, positions inside a pair / past the end,
// \G anchors, look-behind, backreferences, case folding, \p{} classes, empty strings, long lines (the engine's per-string cache path is for >= 1000 bytes), all option flags.
// Usage: node make_edge_trace.mjs > edge-trace.json
import { loadOnig } from './common.mjs';
const onig = await loadOnig('wasm');
const patternSets = [
	['\\w+', '\\d+', '[,;]'], ['\\G\\s*(\\w+)', 'x'], ['(?<=a)b', '(?<!a)b', 'b(?=c)'], ['(a)(b)?(c)?', '(\\w)\\1'], ['(?i)straße', '(?i)é+', 'CAFÉ'],
	['\\p{Lu}\\p{Ll}+', '\\p{Han}+', '\\p{Emoji}', '[\\x{1F600}-\\x{1F64F}]'], ['^\\s*$', '$', '\\A', '\\z'], ['(?<name>[a-z]+)\\k<name>', '(?:ab|a)(?:bc|c)?'],
	['.', '\\X', '\\R', '[^\\x00-\\x7f]+'], ['a{2,}', 'a*?b', 'a++b', '(?>a+)b'], ['\\bfunction\\b', '\\b[A-Z_][A-Z0-9_]*\\b', '(["\'])(?:\\\\.|(?!\\1).)*\\1'],
];
const long = ('lorem ipsum dolor sit amet, consectetur adipiscing elit é 漢字 ').repeat(40);   // > 1000 bytes
const strings = ['', 'a', 'abc', 'ab', 'aab', 'xaabbbc', 'aaa aab aaab', 'function foo() { return "bar"; }  CONST_X = 42', 'café CAFÉ straße STRASSE', '漢字 ééé abc',
	'😀 grin 😀😀 x', 'a😀b😀c', 'lone \ud83d high', 'lone \ude00 low', 'mixed 😀 \ud83d x \ude00', 'tab\tnew\nline\r\nend', 'nul\u0000inside', 'é combining', 'ABCabc', long, long + '😀', 'abab abab', 'xxééyy'];
const trace = { scanners: patternSets, strings, calls: [] };
let errors = 0;
for (let sid = 0; sid < patternSets.length; sid++) {
	let scanner; try { scanner = onig.createOnigScanner(patternSets[sid]); } catch (e) { errors++; continue; }
	for (let stri = 0; stri < strings.length; stri++) {
		const s = strings[stri]; const obj = onig.createOnigString(s);
		const positions = [...new Set([0, 1, 2, 3, Math.floor(s.length / 2), s.length - 1, s.length, s.length + 5, -3])].filter(p => p >= -3);
		for (const pos of positions) {
			for (let opts = 0; opts < 8; opts++) {
				let r; try { r = scanner.findNextMatchSync(obj, pos, opts); } catch (e) { trace.calls.push([sid, stri, pos, opts, -2, 'throws: ' + e.message]); continue; }
				trace.calls.push([sid, stri, pos, opts, r ? r.index : -1, r ? r.captureIndices.map(c => c.start + ':' + c.end).join(',') : '']);
			}
		}
		obj.dispose && obj.dispose();
	}
	scanner.dispose && scanner.dispose();
}
console.error(`edge trace: ${patternSets.length} scanners, ${strings.length} strings, ${trace.calls.length} calls, ${trace.calls.filter(c => c[4] >= 0).length} matches, ${trace.calls.filter(c => c[4] === -2).length} throws, ${errors} scanner errors`);
console.log(JSON.stringify(trace));
