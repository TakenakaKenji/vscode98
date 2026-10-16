// The stylesheet parser in C (07-native-render/host/style_sheet.c, spike:style parseSheet) against css.js parseRulesJS: identical rules for every CSS file given, for the
// sheets of a captured page, and for random mutations of them (quotes, escapes, braces, comments, at-rules, !important, Unicode white space cut in at random places).
// qjs-spike7 --stack-size 0 sheet_parse_test.mjs [--files list.txt] [--page captured.json] [--fuzz N] [--seed S]
import * as std from 'qjs:std';
import '../../02-node-shim/host/globals.js';
import '../../06-rendering/host/dom/intl_shim.js';
import * as S from 'spike:style';
import { CSSStyleSheet, parseRulesJS, sheetRulesEqual, setNativeSheetParser } from '../../06-rendering/host/dom/css.js';

const args = scriptArgs.slice(1); const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const log = (m) => { std.out.puts(m + '\n'); std.out.flush(); };
const texts = [];
if (opt('files')) { for (const f of std.loadFile(opt('files')).split('\n').filter(Boolean)) { const t = std.loadFile(f); if (t !== null) { texts.push([f, t]); } } }
if (opt('page')) { const data = JSON.parse(std.loadFile(opt('page'))); data.sheets.forEach((s, i) => texts.push([`page sheet ${i}`, s.text])); }

const sheet = new CSSStyleSheet('');
let checked = 0, fallbacks = 0, rules = 0, bad = 0, threw = 0; let tNative = 0, tJS = 0;
function check(name, text) {
	let js, jsErr = null; const t0 = performance.now(); try { js = parseRulesJS(text, sheet); } catch (e) { jsErr = e; } const t1 = performance.now();
	setNativeSheetParser((t) => S.parseSheet(t)); let nat, natErr = null; const t2 = performance.now();
	try { const items = S.parseSheet(text); if (items === null) { fallbacks++; nat = null; } else { nat = items; } } catch (e) { natErr = e; }
	const t3 = performance.now(); tJS += t1 - t0; tNative += t3 - t2; checked++;
	if (nat === null) { return; }   // left to JavaScript: always correct
	if (jsErr) { threw++; bad++; if (bad <= 10) { log(`MISMATCH ${name}: JavaScript throws (${jsErr.message}), native parses`); } return; }
	const { parseRules } = globalThis.__cssModule; const mine = parseRules(text, sheet);
	if (natErr || !sheetRulesEqual(mine, js)) { bad++; if (bad <= 10) { log(`MISMATCH ${name}: ${natErr ? natErr.message : 'rules differ'} ${JSON.stringify(text.slice(0, 300))}`); } return; }
	rules += js.length;
}
globalThis.__cssModule = await import('../../06-rendering/host/dom/css.js');
for (const [name, t] of texts) { check(name, t); }
log(`corpus: ${texts.length} texts, ${(texts.reduce((a, x) => a + x[1].length, 0) / 1e6).toFixed(1)} MB; checked ${checked}, left to JavaScript ${fallbacks}, mismatches ${bad}; parse time JavaScript ${tJS.toFixed(0)} ms, native ${tNative.toFixed(0)} ms`);

// random mutations
let seed = Number(opt('seed', 1)); const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const BITS = ['{', '}', '(', ')', ';', ':', '"', "'", '\\', '/*', '*/', '@', '@media screen', '@font-face', '@supports (x)', '!important', ' ! important', '!IMPORTANT', '--x', '&', ' > ', ',', '\n', '\t', ' ', ' ', '　', '﻿', '\u0085', 'é', 'Ä', '\u{1F600}', 'a', '.c', '#i', ' ', '\\"', "\\'", '/', '*', 'url(a;b)', '"a;b"', '{}', '@layer a, b;', '@charset "x";', 'COLOR', '-webkit-', '\u0000'];
const pieces = texts.length ? texts.map(x => x[1]).filter(t => t.length < 200000) : ['a { color: red }'];
const fuzzN = Number(opt('fuzz', 0)); const before = bad, fb0 = fallbacks;
for (let n = 0; n < fuzzN; n++) {
	const src = pieces[Math.floor(rnd() * pieces.length)]; const start = Math.floor(rnd() * Math.max(1, src.length - 400)); let t = src.slice(start, start + 20 + Math.floor(rnd() * 380));
	const k = 1 + Math.floor(rnd() * 6); for (let j = 0; j < k; j++) { const at = Math.floor(rnd() * (t.length + 1)); t = t.slice(0, at) + BITS[Math.floor(rnd() * BITS.length)] + t.slice(at); }
	check(`fuzz #${n}`, t);
}
if (fuzzN) { log(`fuzz: ${fuzzN} texts, left to JavaScript ${fallbacks - fb0}, mismatches ${bad - before} (JavaScript throws where native parsed: ${threw})`); }
log(bad ? 'FAIL' : 'PASS');
std.exit(bad ? 1 : 0);
