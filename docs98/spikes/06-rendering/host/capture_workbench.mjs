// Captures the live VS Code workbench from a running Electron (CDP) for static layout replay: DOM (outerHTML), all CSS (absolute font URLs), per-element boxes and scroll offsets.
//   node capture_workbench.mjs <port> <out.json> [settleSeconds]
import CDP from '/home/user/vscode98/node_modules/chrome-remote-interface/index.js';
import { writeFileSync } from 'node:fs';
const [port = '9333', out = 'workbench.json', settle = '4'] = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let target; for (let i = 0; i < 400 && !target; i++) { try { target = (await CDP.List({ port: Number(port) })).find(t => t.type === 'page' && /workbench/.test(t.url)); } catch { } if (!target) { await sleep(100); } }
if (!target) { console.error('no workbench page'); process.exit(2); }
const client = await CDP({ port: Number(port), target }); const { Runtime, Emulation, Page } = client; await Runtime.enable(); await Page.enable();
const READY = `(() => { const q = s => document.querySelector(s); return document.readyState === 'complete' && !!q('.monaco-workbench .part.editor') && !!q('.monaco-workbench .part.statusbar'); })()`;
for (let i = 0; i < 1200; i++) { const r = await Runtime.evaluate({ expression: READY, returnByValue: true }).catch(() => ({ result: {} })); if (r.result.value === true) { break; } await sleep(100); }
await sleep(Number(settle) * 1000);
await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }); await sleep(3000);
const shot = await Page.captureScreenshot({ format: 'png' }); writeFileSync(out.replace(/\.json$/, '.png'), Buffer.from(shot.data, 'base64'));
const expr = `(() => {
	const abs = (css, base) => css.replace(/url\\(\\s*(['"]?)([^'")]+)\\1\\s*\\)/g, (m, q, u) => { try { return 'url("' + new URL(u, base).href + '")'; } catch { return m; } });
	const sheets = []; const addSheet = (s, adopted) => { try { const base = s.href || document.baseURI; let text = ''; for (const r of s.cssRules) { text += abs(r.cssText, base) + '\\n'; } sheets.push({ href: s.href || null, adopted, text }); } catch (e) { sheets.push({ href: s.href, error: String(e) }); } };
	for (const s of document.styleSheets) { addSheet(s, false); } for (const s of document.adoptedStyleSheets || []) { addSheet(s, true); }
	const props = ['display', 'position', 'overflow-x', 'overflow-y'];
	const rows = []; let n = 0;
	const walk = (el, path) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); rows.push({ path, tag: el.localName, cls: el.getAttribute('class') || '', x: r.x, y: r.y, w: r.width, h: r.height, display: cs.display, position: cs.position, flex: cs.flexGrow + ' ' + cs.flexShrink + ' ' + cs.flexBasis, cwidth: cs.width, cmaxw: cs.maxWidth, cminw: cs.minWidth, cdir: cs.flexDirection, cmargin: cs.marginLeft + '/' + cs.marginRight, ffam: cs.fontFamily.slice(0, 40), fsize: cs.fontSize, fweight: cs.fontWeight, st: el.scrollTop, sl: el.scrollLeft, offsetW: el.offsetWidth, offsetH: el.offsetHeight, scrollW: el.scrollWidth, scrollH: el.scrollHeight, inlineStyle: el.getAttribute('style') || '', depth: path.split('/').length - 1, text: el.children.length === 0 ? (el.textContent || '').slice(0, 60) : undefined }); let i = 0; for (const c of el.children) { walk(c, path + '/' + c.localName + '[' + (i++) + ']'); } };
	walk(document.documentElement, 'html');
	return JSON.stringify({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio, html: document.documentElement.outerHTML, sheets, elements: rows, fonts: [...document.fonts].map(f => f.family + ':' + f.weight + ':' + f.status) });
})()`;
// which platform fonts did Chromium actually use? (CSS.getPlatformFontsForNode) -> tells us which installed font each CSS family stack resolved to
const { DOM, CSS } = client; await DOM.enable(); await CSS.enable(); const doc0 = await DOM.getDocument({ depth: 0 }); const fontsUsed = {};
for (const sel of ['.menubar-menu-button', '.monaco-alert', '.statusbar-item-label', '.monaco-workbench', '.explorer-folders-view .label-name', '.pane-header .title', '.monaco-editor .view-line', '.codicon-warning', '.window-title']) { try { const n = await DOM.querySelector({ nodeId: doc0.root.nodeId, selector: sel }); if (!n.nodeId) { continue; } const f = await CSS.getPlatformFontsForNode({ nodeId: n.nodeId }); fontsUsed[sel] = f.fonts.map(x => `${x.familyName}${x.isCustomFont ? ' (custom)' : ''} x${x.glyphCount}`); } catch (e) { fontsUsed[sel] = String(e.message).slice(0, 80); } }
console.error('platform fonts: ' + JSON.stringify(fontsUsed, null, 1));
const r = await Runtime.evaluate({ expression: expr, returnByValue: true, timeout: 120000 }); if (r.exceptionDetails) { console.error(JSON.stringify(r.exceptionDetails).slice(0, 500)); process.exit(3); }
writeFileSync(out, r.result.value); writeFileSync(out.replace(/\.json$/, '.fonts.json'), JSON.stringify(fontsUsed, null, 1)); const d = JSON.parse(r.result.value); console.error(`captured: viewport ${d.w}x${d.h}, ${d.elements.length} elements, html ${(d.html.length / 1024) | 0} KB, ${d.sheets.length} stylesheets (${d.sheets.reduce((n, s) => n + (s.text ? s.text.length : 0), 0) / 1024 | 0} KB)`);
await client.close();
