// Control benchmark: drives a running Electron VS Code (started with --remote-debugging-port) through the same actions as the QuickJS host's
// scenario_lat2.mjs and prints the wall time of each, from the input event to the DOM state that shows the result (polled every animation frame).
// Usage: node electron_lat.mjs <port> <workspace dir> [rounds]
import { connectPage } from './cdp_page.mjs';
import fs from 'node:fs';
const [port, ws, roundsArg] = process.argv.slice(2); const rounds = Number(roundsArg || 3);
const page = await connectPage(port, (t) => /workbench\.html/.test(t.url) && /ws98/.test(t.title));
await page.setViewportSize({ width: 1280, height: 800 });   // the headless window starts at 400x270; the QuickJS host runs at 1280x800
const log = (m) => console.log('ctl: ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** runs act, then waits (polling every frame) until pred holds in the page; ms from before act to the frame where it held */
async function timed(act, pred, arg, max = 60000) { const t0 = Date.now(); await act(); await page.waitForFunction(pred, arg, { polling: 'raf', timeout: max }); return Date.now() - t0; }   // note: the input is sent over CDP and the wait polls every frame; both add a few ms
const rect = (sel, text) => page.evaluate(([s, t]) => { const el = [...document.querySelectorAll(s)].find((e) => (!t || (e.getAttribute('aria-label') || e.textContent || '').startsWith(t)) && e.getBoundingClientRect().height > 0); if (!el) { return null; } const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }, [sel, text]);
const center = (r) => [r.x + r.w / 2, r.y + r.h / 2];
const menuOpen = () => [...document.querySelectorAll('.monaco-menu')].some((m) => m.getBoundingClientRect().height > 0);
const noMenu = () => ![...document.querySelectorAll('.monaco-menu')].some((m) => m.getBoundingClientRect().height > 0);
const esc = async () => { await page.keyboard.press('Escape'); try { await page.waitForFunction(noMenu, null, { polling: 'raf', timeout: 5000 }); } catch { } await sleep(500); };
await page.waitForFunction(() => [...document.querySelectorAll('.explorer-folders-view .monaco-list-row')].some((r) => (r.getAttribute('aria-label') || '').startsWith('hello.txt')), null, { timeout: 120000 });
await sleep(5000);
fs.writeFileSync(ws + '/caret.txt', 'second file\n'); fs.writeFileSync(ws + '/two.txt', 'another file here\n');
await sleep(2000);
const results = [];
for (let round = 1; round <= rounds; round++) {
	const res = {};
	// explorer context menu
	{ const r = await rect('.explorer-folders-view .monaco-list-row', 'hello.txt'); const [x, y] = center(r); res.context = await timed(() => page.mouse.click(x, y, { button: 'right' }), menuOpen); await esc(); }
	// menu bar: open File, then move to Edit
	{ const f = await rect('.menubar .menubar-menu-button', 'File'); const e = await rect('.menubar .menubar-menu-button', 'Edit'); const [fx, fy] = center(f); const [ex, ey] = center(e);
	  res.menubar = await timed(() => page.mouse.click(fx, fy), menuOpen);
	  res.menuMove = await timed(() => page.mouse.move(ex, ey), () => { const b = [...document.querySelectorAll('.menubar .menubar-menu-button')].find((x) => /Edit/.test(x.textContent)); const f = [...document.querySelectorAll('.menubar .menubar-menu-button')].find((x) => /File/.test(x.textContent)); const isOpen = (x) => !!x && (x.classList.contains('open') || x.getAttribute('aria-expanded') === 'true'); return isOpen(b) && !isOpen(f) && [...document.querySelectorAll('.monaco-menu')].some((m) => m.getBoundingClientRect().height > 0); });
	  await esc(); }
	// open a file from the explorer (single click: preview)
	{ const r = await rect('.explorer-folders-view .monaco-list-row', 'caret.txt'); const [x, y] = center(r); res.openFile = await timed(() => page.mouse.click(x, y), () => [...document.querySelectorAll('.editor-instance .view-line')].some((l) => /second.file/.test(l.textContent))); }
	// open a second file, then switch back with the explorer (preview replaces: use Ctrl+Tab-free path: click rows)
	{ const r = await rect('.explorer-folders-view .monaco-list-row', 'two.txt'); const [x, y] = center(r); res.switchFile = await timed(() => page.mouse.click(x, y), () => [...document.querySelectorAll('.editor-instance .view-line')].some((l) => /another.file/.test(l.textContent))); }
	{ const r = await rect('.explorer-folders-view .monaco-list-row', 'caret.txt'); const [x, y] = center(r); await page.mouse.click(x, y); await page.waitForFunction(() => [...document.querySelectorAll('.editor-instance .view-line')].some((l) => /second.file/.test(l.textContent)), null, { polling: 'raf' }); await sleep(800); }
	// click in the text: caret to column 4
	{ const sp = await page.evaluate(() => { const e = [...document.querySelectorAll('.editor-instance .view-line span span')].find((s) => /second.file/.test(s.textContent)); const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, n: e.textContent.length }; });
	  const cw = sp.w / sp.n; const col = 3 + (round % 3); res.caret = await timed(() => page.mouse.click(sp.x + cw * (col + 0.3), sp.y + sp.h / 2), (c) => [...document.querySelectorAll('.statusbar-item')].some((s) => new RegExp('Col ' + c + '\\b').test(s.textContent)), col + 1);
	  await sleep(500);
	  res.dblclick = await timed(() => page.mouse.dblclick(sp.x + cw * 1.5, sp.y + sp.h / 2), () => !!document.querySelector('.editor-instance .selected-text')); await sleep(500);
	  await page.mouse.click(sp.x + sp.w + 20, sp.y + sp.h / 2); await sleep(500);
	  // typing: one key, until the line shows it
	  const ks = []; for (const ch of 'abcde') { ks.push(await timed(() => page.keyboard.press(ch), (s) => [...document.querySelectorAll('.editor-instance .view-line')].some((l) => l.textContent.replace(/ /g, ' ').includes('file' + s)), 'abcde'.slice(0, 'abcde'.indexOf(ch) + 1))); }
	  res.key = Math.round(ks.reduce((a, b) => a + b, 0) / ks.length);
	  for (let i = 0; i < 5; i++) { await page.keyboard.press('Backspace'); } await page.keyboard.press('Control+S'); await sleep(800); }
	// quick open and command palette
	res.quickOpen = await timed(() => page.keyboard.press('Control+P'), () => { const i = document.querySelector('.quick-input-widget'); return !!i && i.getBoundingClientRect().height > 0 && document.querySelectorAll('.quick-input-list .monaco-list-row').length > 0; }); await esc();
	res.palette = await timed(() => page.keyboard.press('Control+Shift+P'), () => { const i = document.querySelector('.quick-input-widget'); return !!i && i.getBoundingClientRect().height > 0 && document.querySelectorAll('.quick-input-list .monaco-list-row').length > 0; }); await esc();
	// new file / new folder through the explorer title actions
	for (const [kind, label] of [['newFile', 'New File'], ['newFolder', 'New Folder']]) {
		const hdr = await rect('.explorer-folders-view .monaco-list-row', ''); await page.mouse.move(hdr.x + 40, hdr.y - 10); await sleep(400);
		const b = await rect('.action-label', label); const [bx, by] = center(b); const name = `ctl_${kind}_${round}` + (kind === 'newFile' ? '.txt' : '');
		res[kind + 'Input'] = await timed(() => page.mouse.click(bx, by), () => !!document.querySelector('.explorer-item-edit-input input, .monaco-tl-contents .monaco-inputbox input'));
		await page.keyboard.type(name);
		res[kind] = await timed(() => page.keyboard.press('Enter'), (n) => [...document.querySelectorAll('.explorer-folders-view .monaco-list-row')].some((r) => (r.getAttribute('aria-label') || '').startsWith(n)), name);
		await sleep(1500);
	}
	log('round ' + round + ' ' + JSON.stringify(res)); results.push(res);
	await sleep(2000);
}
const keys = Object.keys(results[0]); const med = {}; for (const k of keys) { const v = results.map((r) => r[k]).sort((a, b) => a - b); med[k] = v[Math.floor(v.length / 2)]; }
log('median ' + JSON.stringify(med));
page.close();
