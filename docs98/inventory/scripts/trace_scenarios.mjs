// Scripted-scenario trace of the VS Code renderer over the Chrome DevTools Protocol.
//
// Drives the real UI with synthetic keyboard/mouse input (new file + typing, quick open + scrolling + find,
// search, integrated terminal, settings editor, markdown preview, diff editor) and records, per step,
// which instrumented DOM/Web APIs were called for the first time or called more, plus DOM stats and a screenshot.
//
// Usage (normally via run_scenarios.sh):
//   node trace_scenarios.mjs <port> <out.json> <shotsDir>
//
// Safety: edits happen in an untitled editor and nothing is saved. The workspace should be a throwaway copy.

import CDP from 'chrome-remote-interface';
import { writeFileSync, mkdirSync } from 'node:fs';
import { INSTRUMENT, CENSUS } from './trace_common.mjs';

const [port = '9333', out = 'scenarios-trace.json', shotsDir = 'shots'] = process.argv.slice(2);
mkdirSync(shotsDir, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let target;
for (let i = 0; i < 90 && !target; i++) {
	try { target = (await CDP.List({ port: Number(port) })).find(t => t.type === 'page' && /workbench/.test(t.url)); } catch { /* not up yet */ }
	if (!target) { await sleep(1000); }
}
if (!target) { console.error('no workbench target'); process.exit(2); }

const client = await CDP({ port: Number(port), target });
const { Page, Runtime, Input, Emulation } = client;
await Page.enable(); await Runtime.enable();
await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await Emulation.setFocusEmulationEnabled({ enabled: true });
await Page.addScriptToEvaluateOnNewDocument({ source: INSTRUMENT });
await Page.reload();

const ev = async (expression) => {
	const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
	if (r.exceptionDetails) { throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); }
	return r.result.value;
};

// ---- input helpers -------------------------------------------------------------------------------
const NAMED = {
	enter: { key: 'Enter', code: 'Enter', vk: 13 }, escape: { key: 'Escape', code: 'Escape', vk: 27 }, f1: { key: 'F1', code: 'F1', vk: 112 },
	pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 }, pageup: { key: 'PageUp', code: 'PageUp', vk: 33 }, end: { key: 'End', code: 'End', vk: 35 },
	home: { key: 'Home', code: 'Home', vk: 36 }, down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 }, up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
	right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 }, left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 }, backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
	tab: { key: 'Tab', code: 'Tab', vk: 9 }, space: { key: ' ', code: 'Space', vk: 32 }, '`': { key: '`', code: 'Backquote', vk: 192 }, ',': { key: ',', code: 'Comma', vk: 188 }
};
const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
function spec(combo) {
	const parts = combo.toLowerCase().split('+'); const k = parts.pop(); let modifiers = 0;
	for (const p of parts) { modifiers |= MOD[p]; }
	const n = NAMED[k] ?? (k.length === 1 && /[a-z]/.test(k) ? { key: (modifiers & 8) ? k.toUpperCase() : k, code: 'Key' + k.toUpperCase(), vk: k.toUpperCase().charCodeAt(0) } : null);
	if (!n) { throw new Error('unknown key ' + combo); }
	return { ...n, modifiers };
}
async function press(combo, times = 1, gap = 40) {
	const s = spec(combo);
	for (let i = 0; i < times; i++) {
		await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: s.key, code: s.code, windowsVirtualKeyCode: s.vk, nativeVirtualKeyCode: s.vk, modifiers: s.modifiers });
		await Input.dispatchKeyEvent({ type: 'keyUp', key: s.key, code: s.code, windowsVirtualKeyCode: s.vk, nativeVirtualKeyCode: s.vk, modifiers: s.modifiers });
		if (gap) { await sleep(gap); }
	}
}
const PUNCT = { '.': ['Period', 190, 0], ',': ['Comma', 188, 0], '"': ['Quote', 222, 8], "'": ['Quote', 222, 0], '-': ['Minus', 189, 0], '_': ['Minus', 189, 8], '/': ['Slash', 191, 0],
	';': ['Semicolon', 186, 0], ':': ['Semicolon', 186, 8], '(': ['Digit9', 57, 8], ')': ['Digit0', 48, 8], '{': ['BracketLeft', 219, 8], '}': ['BracketRight', 221, 8], '[': ['BracketLeft', 219, 0],
	']': ['BracketRight', 221, 0], '=': ['Equal', 187, 0], '<': ['Comma', 188, 8], '>': ['Period', 190, 8], ' ': ['Space', 32, 0], '+': ['Equal', 187, 8], '|': ['Backslash', 220, 8], '&': ['Digit7', 55, 8], '$': ['Digit4', 52, 8] };
async function typeText(text, gap = 6) {
	for (const ch of text) {
		if (ch === '\n') { await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); }
		else {
			const up = ch.toUpperCase(); const pu = PUNCT[ch];
			const code = pu ? pu[0] : /[a-z]/i.test(ch) ? 'Key' + up : /[0-9]/.test(ch) ? 'Digit' + ch : '';
			const vk = pu ? pu[1] : /[a-z0-9]/i.test(ch) ? up.charCodeAt(0) : ch.charCodeAt(0);
			const modifiers = pu ? pu[2] : (ch !== ch.toLowerCase() ? 8 : 0);
			await Input.dispatchKeyEvent({ type: 'keyDown', key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, text: ch, unmodifiedText: ch });
			await Input.dispatchKeyEvent({ type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
		}
		if (gap) { await sleep(gap); }
	}
}
async function wheel(x, y, dy, times, gap = 30) { for (let i = 0; i < times; i++) { await Input.dispatchMouseEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy }); await sleep(gap); } }
async function click(x, y) {
	await Input.dispatchMouseEvent({ type: 'mouseMoved', x, y }); await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
	await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
async function waitFor(expr, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(expr)) { return true; } } catch { /* page not ready */ } await sleep(300); } return false; }
async function quickOpen(name) { await press('ctrl+p'); await sleep(500); await typeText(name); await sleep(900); await press('enter'); await sleep(1500); }
async function palette(cmd) { await press('f1'); await sleep(500); await typeText(cmd); await sleep(800); await press('enter'); await sleep(800); }

// ---- step runner ---------------------------------------------------------------------------------
const steps = []; let prev = {};
const snapCounts = () => ev('({ ...globalThis.__trace.counts })');
const domStats = () => ev(`(() => ({
	elements: document.getElementsByTagName('*').length, iframes: document.querySelectorAll('iframe,webview').length, canvases: document.querySelectorAll('canvas').length,
	textareas: document.querySelectorAll('textarea').length, inputs: document.querySelectorAll('input').length, contentEditable: document.querySelectorAll('[contenteditable=true],[contenteditable=plaintext-only]').length,
	svg: document.querySelectorAll('svg').length, xterm: document.querySelectorAll('.xterm').length, diffEditors: document.querySelectorAll('.monaco-diff-editor').length,
	activeTab: document.querySelector('.tabs-container .tab.active .label-name, .tab.active .monaco-icon-label')?.textContent ?? null, settingsModal: !!document.querySelector('.settings-editor'), searchRows: document.querySelectorAll('.search-view .monaco-list-row').length, editors: document.querySelectorAll('.monaco-editor').length, listRows: document.querySelectorAll('.monaco-list-row').length, heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576)
}))()`);

async function step(name, fn, check) {
	const t0 = Date.now(); let error = null, checkOk = null;
	try { await fn(); } catch (e) { error = String(e.message ?? e).slice(0, 300); }
	await sleep(500);
	try { if (check) { checkOk = await waitFor(check, 6000); } } catch { checkOk = false; }
	const cur = await snapCounts(); const fresh = {}, inc = {};
	for (const [k, v] of Object.entries(cur)) { const d = v - (prev[k] ?? 0); if (d > 0) { if (prev[k] === undefined) { fresh[k] = v; } else { inc[k] = d; } } }
	prev = cur;
	const shot = `${shotsDir}/${String(steps.length).padStart(2, '0')}-${name}.png`;
	try { writeFileSync(shot, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } catch { /* ignore */ }
	const dom = await domStats();
	const top = Object.entries(inc).sort((a, b) => b[1] - a[1]).slice(0, 15);
	steps.push({ name, ms: Date.now() - t0, error, checkOk, newApis: fresh, topIncrements: Object.fromEntries(top), totalCallsInStep: Object.values(inc).reduce((a, b) => a + b, 0) + Object.values(fresh).reduce((a, b) => a + b, 0), dom, screenshot: shot });
	console.error(`[${name}] ${Date.now() - t0}ms check=${checkOk} err=${error} new=${Object.keys(fresh).length} elements=${dom.elements}`);
}

// ---- scenarios -----------------------------------------------------------------------------------
const ready = await waitFor(`!!document.querySelector('.monaco-workbench .part.editor') && !!document.querySelector('.monaco-workbench .part.sidebar') && document.querySelectorAll('.monaco-workbench .statusbar-item').length > 0`, 90000);
console.error('workbench ready:', ready);
await sleep(8000); // let startup tasks finish
await step('00-ready', async () => { await click(745, 300); await sleep(500); });

const CODE = ['import { Disposable } from "./lifecycle";', '', 'export class Counter extends Disposable {', 'private count = 0;', 'increment(by: number): number {', 'this.count += by;', 'return this.count;', '}', '}', 'const c = new Counter();', 'console.'].join('\n');
await step('01-new-file-typing', async () => {
	await press('ctrl+n'); await sleep(1200);
	if (!(await ev(`!!document.querySelector('.monaco-editor textarea.inputarea')`))) { await click(745, 300); await press('ctrl+n'); await sleep(1500); }
	await palette('Change Language Mode'); await typeText('TypeScript'); await sleep(600); await press('enter'); await sleep(800);
	await typeText(CODE, 8); await sleep(500);
	await press('ctrl+space'); await sleep(4000); await press('escape');
}, `[...document.querySelectorAll('.monaco-editor .view-line')].some(l => l.textContent.includes('Counter'))`);

await step('02-quickopen-scroll-find', async () => {
	await quickOpen('model/textModel.ts');
	await press('pagedown', 25, 60); await wheel(700, 400, 240, 40); await press('ctrl+end'); await sleep(300); await press('ctrl+home');
	await press('down', 15, 20); await press('shift+down', 25, 20); await press('right'); // selection + cursor moves
	await press('ctrl+f'); await sleep(400); await typeText('this'); await press('enter', 6, 120); await press('escape');
	await click(700, 300); await sleep(300);
}, `[...document.querySelectorAll('.monaco-editor .view-line')].some(l => /TextModel|import/.test(l.textContent))`);

await step('03-search-in-files', async () => {
	await press('ctrl+shift+f'); await sleep(600); await typeText('Disposable'); await press('enter'); await waitFor(`document.querySelectorAll('.search-view .monaco-list-row').length > 3`, 20000); await sleep(1500);
	const r = await ev(`(() => { const e = document.querySelectorAll('.search-view .monaco-list-row')[2]; if (!e) { return null; } const b = e.getBoundingClientRect(); return { x: b.x + 60, y: b.y + b.height / 2 }; })()`);
	if (r) { await click(r.x, r.y); await sleep(800); await click(r.x, r.y + 1); await sleep(1500); } // select + open a result
}, `document.querySelectorAll('.search-view .monaco-list-row').length > 3`);

await step('04-terminal', async () => {
	await press('ctrl+`'); await waitFor(`/[$#] ?$/m.test([...document.querySelectorAll('.xterm-rows > div')].map(d => d.textContent).join('\\n'))`, 20000); await sleep(1500);
	await typeText('ls\n', 40); await sleep(1500); await typeText('echo hello\n', 40); await sleep(1500); await typeText('cat README.md\n', 40); await sleep(2500);
}, `!!document.querySelector('.xterm')`);

await step('05-settings-editor', async () => {
	await press('ctrl+,'); await sleep(4000); await typeText('font size'); await sleep(2000); await wheel(700, 500, 200, 12);
}, `!!document.querySelector('.settings-editor')`);

await step('05b-close-settings', async () => {
	await press('escape'); await sleep(800);
	if (await ev(`!!document.querySelector('.settings-editor')`)) { await click(1276, 121); await sleep(800); }
}, `!document.querySelector('.settings-editor')`);

await step('06-markdown-preview', async () => {
	await quickOpen('README.md'); await press('ctrl+shift+v'); await sleep(6000);
}, `document.querySelectorAll('iframe,webview').length > 0`);

// webview frames: list targets and census the first frame target we can attach to
let webviewTargets = [];
try {
	const { targetInfos } = await client.send('Target.getTargets');
	webviewTargets = targetInfos.map(t => ({ type: t.type, scheme: t.url.split(':')[0], urlHead: t.url.slice(0, 80) }));
} catch { /* ignore */ }
let webviewCensus = null;
try {
	const { targetInfos } = await client.send('Target.getTargets');
	const wv = targetInfos.find(t => t.type === 'iframe' && /vscode-webview/.test(t.url));
	if (wv) {
		const { sessionId } = await client.send('Target.attachToTarget', { targetId: wv.targetId, flatten: true });
		const r = await client.send('Runtime.evaluate', { expression: '(' + CENSUS.trim().replace(/;$/, '') + ')', returnByValue: true }, sessionId);
		webviewCensus = r.result?.value ?? { error: JSON.stringify(r).slice(0, 300) };
	}
} catch (e) { webviewCensus = { error: String(e.message ?? e).slice(0, 200) }; }

await step('07-diff-editor', async () => {
	await palette('Compare Active File With'); await sleep(800); await typeText('package.json'); await sleep(1000); await press('enter'); await sleep(3500);
}, `document.querySelectorAll('.monaco-diff-editor').length > 0`);

await step('08-explorer-and-palette', async () => {
	await press('ctrl+shift+e'); await sleep(600); await press('down', 8, 60); await press('right'); await press('down', 4, 60);
	await press('f1'); await sleep(500); await typeText('theme'); await sleep(800); await press('escape');
}, `!!document.querySelector('.explorer-viewlet')`);

const finalCensus = await ev(CENSUS);
const finalCounts = await snapCounts();
const sorted = o => Object.fromEntries(Object.entries(o || {}).sort((a, b) => b[1] - a[1]));
writeFileSync(out, JSON.stringify({ takenAt: new Date().toISOString(), ready, steps, webviewTargets, webviewCensus, finalApiCounts: sorted(finalCounts), finalCensus: { ...finalCensus, computed: sorted(finalCensus.computed), stylesheets: { ...finalCensus.stylesheets, properties: sorted(finalCensus.stylesheets.properties) } } }, null, 1));
console.error('wrote', out);
await client.close();
process.exit(0);
