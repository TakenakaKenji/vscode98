// The selector parser in C (07-native-render/host/style_selector.c, spike:style parseSelector) against selectors.js parseSelectorJS: the same objects (JSON, without
// __nser) and, for every top-level complex selector, a __nser equal to native_style.js serializeJS of the JavaScript result. Corpus: the selectors of the given CSS files
// and of a captured page; then random mutations of them. Where JavaScript throws, the native parser must return null.
// qjs-spike7 --stack-size 0 selector_parse_test.mjs [--files list.txt] [--page captured.json] [--fuzz N] [--seed S]
import * as std from 'qjs:std';
import '../../02-node-shim/host/globals.js';
import '../../06-rendering/host/dom/intl_shim.js';
import * as S from 'spike:style';
import { CSSStyleSheet, CSSStyleRule } from '../../06-rendering/host/dom/css.js';
import { parseSelectorJS } from '../../06-rendering/host/dom/selectors.js';
import { serializeJS } from '../../07-native-render/host/native_style.js';

const args = scriptArgs.slice(1); const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const log = (m) => { std.out.puts(m + '\n'); std.out.flush(); };
const sels = new Set();
const collect = (rules) => { for (const r of rules) { if (r instanceof CSSStyleRule) { sels.add(r.selectorText); } else if (r.cssRules) { collect(r.cssRules); } } };
if (opt('files')) { for (const f of std.loadFile(opt('files')).split('\n').filter(Boolean)) { const t = std.loadFile(f); if (t !== null) { try { collect(new CSSStyleSheet(t).cssRules); } catch { } } } }
if (opt('page')) { for (const s of JSON.parse(std.loadFile(opt('page'))).sheets) { collect(new CSSStyleSheet(s.text).cssRules); } }

const noNser = (k, v) => k === '__nser' ? undefined : v;
let checked = 0, fallbacks = 0, bad = 0, jsThrows = 0; let tJS = 0, tNative = 0;
function check(name, text) {
	let js = null, jsErr = null; const t0 = performance.now(); try { js = parseSelectorJS(text); } catch (e) { jsErr = e; } const t1 = performance.now();
	let nat = null, natErr = null; try { nat = S.parseSelector(text); } catch (e) { natErr = e; } const t2 = performance.now();
	tJS += t1 - t0; tNative += t2 - t1; checked++;
	if (jsErr) { jsThrows++; }
	if (nat === null && !natErr) { fallbacks++; return; }   // left to JavaScript: always correct
	let why = null;
	if (natErr) { why = 'native threw ' + natErr.message; }
	else if (jsErr) { why = 'JavaScript throws (' + jsErr.message + '), native parsed'; }
	else if (JSON.stringify(nat, noNser) !== JSON.stringify(js)) { why = 'objects differ'; }
	else { for (let i = 0; i < js.length; i++) { const want = serializeJS(js[i]).join(); if (!nat[i].__nser || nat[i].__nser.join() !== want) { why = `__nser of #${i} differs`; break; } } }
	if (why) { bad++; if (bad <= 10) { log(`MISMATCH ${name}: ${why}: ${JSON.stringify(text.slice(0, 200))}`); } }
}
let k = 0; for (const t of sels) { check(`selector ${k++}`, t); }
log(`corpus: ${sels.size} distinct selectors; left to JavaScript ${fallbacks}, mismatches ${bad}; parse time JavaScript ${tJS.toFixed(0)} ms, native ${tNative.toFixed(0)} ms`);

let seed = Number(opt('seed', 1)); const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const BITS = [' ', '  ', '>', '+', '~', ',', '(', ')', '[', ']', '"', "'", '=', '~=', '|=', '^=', '$=', '*=', ' i', ' s', '*', '|', '#', '.', ':', '::', ':not(', ':is(', ':where(', ':has(> ', ':nth-child(', '2n+1', '-n+3', 'odd', 'even', ' of ', ':nth-of-type(3)', ':lang(en)', '::before', '::part(x)', ':hover', ':HOVER', 'DIV', 'a', '-', '_', '9', '\t', '\n', '\\', 'é', '{', ';', ':focus-within', ':first-child', ':empty', ':root', '[data-x="a b"]', '[x]', 'constructor', ':constructor', ' '];
const pool = [...sels]; const fuzzN = Number(opt('fuzz', 0)); const b0 = bad, f0 = fallbacks;
for (let n = 0; n < fuzzN; n++) {
	let t = pool.length ? pool[Math.floor(rnd() * pool.length)] : 'a';
	const m = 1 + Math.floor(rnd() * 4); for (let j = 0; j < m; j++) { const at = Math.floor(rnd() * (t.length + 1)); const del = rnd() < 0.3 ? Math.floor(rnd() * 3) : 0; t = t.slice(0, at) + BITS[Math.floor(rnd() * BITS.length)] + t.slice(at + del); }
	check(`fuzz #${n}`, t);
}
if (fuzzN) { log(`fuzz: ${fuzzN} selectors, left to JavaScript ${fallbacks - f0}, mismatches ${bad - b0} (JavaScript threw on ${jsThrows} of all)`); }
log(bad ? 'FAIL' : 'PASS');
std.exit(bad ? 1 : 0);
