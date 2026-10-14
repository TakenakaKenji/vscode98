// Feature scenario: webviews (iframes with their own documents): the Markdown preview, the extension README tab.
import { createRig } from './scenario_lib.mjs';
import * as std from 'qjs:std';
export async function run(ctx) { try { await run0(ctx); } catch (e) { ctx.log('webview: failed ' + (e && e.stack || e)); } }
async function run0(ctx) {
	const rig = await createRig(ctx); const { check } = rig; const log = ctx.log; const ws = ctx.opt('workspace', '/tmp/claude-0/ws98'); const only = ctx.opt('only', ''); const on = (n) => !only || only.split(',').includes(n);
	{ const x = rig.$('.onboarding-a-close-btn'); if (x) { await rig.clickEl(x); } }
	{ const f = std.open(ws + '/preview.md', 'w'); f.puts('# Preview Title\n\nSome **bold** text and a [link](https://example.com).\n\n- item one\n- item two\n\n```js\nconst x = 1;\n```\n'); f.close(); }
	await rig.key('e', { ctrl: true, shift: true, rounds: 30 });
	const openFile = async (name) => { const row = await rig.waitFor(() => rig.$$('.explorer-folders-view .monaco-list-row').find((r) => (r.getAttribute('aria-label') || '').startsWith(name))); if (!row) { check('explorer lists ' + name, false); return false; } await rig.clickEl(row, { rounds: 40 }); await rig.key('Enter', { rounds: 30 }); await rig.settle(30, 40); await rig.waitFor(() => rig.$$('.editor-instance .view-line').length); return true; };
	/** the document of the innermost frame of the first webview, or null */
	const webviewDoc = () => { const outer = rig.$$('iframe.webview').map((f) => f.contentDocument).find((d) => d && d.getElementById('active-frame')); const inner = outer && outer.getElementById('active-frame'); return inner && inner.contentDocument; };
	const dump = (d, depth = 0) => { for (const f of d.querySelectorAll('iframe')) { const cd = f.contentDocument; const r = f.getBoundingClientRect(); log('webview: ' + '  '.repeat(depth) + 'iframe#' + f.id + '.' + String(f.className).slice(0, 30) + ' src=' + String(f.getAttribute('src')).slice(0, 90) + ' loc=' + (f.contentWindow && String(f.contentWindow.location.href).slice(0, 60)) + ' rect=' + [r.left, r.top, r.width, r.height].map(Math.round) + ' body=' + JSON.stringify(cd && cd.body ? cd.body.textContent.replace(/\s+/g, ' ').slice(0, 60) : null)); if (cd) { dump(cd, depth + 1); } } };
	if (on('markdown')) {
		await openFile('preview.md'); await rig.key('v', { ctrl: true, shift: true, rounds: 60 });
		const frame = await rig.waitFor(() => rig.$('iframe.webview'), 30); check('markdown preview creates a webview iframe', !!frame); if (frame) { await rig.settle(30, 30); log('webview: src=' + frame.getAttribute('src') + ' loc=' + (frame.contentWindow && frame.contentWindow.location.href) + ' bodyLen=' + (frame.contentDocument && frame.contentDocument.body.innerHTML.length) + ' rect=' + JSON.stringify(frame.getBoundingClientRect())); }
		const wd = await rig.waitFor(() => { const d = webviewDoc(); return d && d.body && /Preview Title/.test(d.body.textContent) ? d : null; }, 90);
		check('preview shows the rendered markdown', !!wd, wd ? wd.body.textContent.slice(0, 80) : 'webview doc: ' + (webviewDoc() ? webviewDoc().body.textContent.slice(0, 60) : 'none') + ' / iframes ' + rig.$$('iframe').length);
		{ const f = rig.$('iframe.webview'); for (let e = f, i = 0; e && i < 8; e = e.parentElement, i++) { const cs = ctx.env.window.getComputedStyle(e); const r = e.getBoundingClientRect(); log('webview: anc ' + rig.describe(e) + ' rect=' + [r.left, r.top, r.width, r.height].map(Math.round) + ' disp=' + cs.display + ' vis=' + cs.visibility + ' pos=' + cs.position + ' ov=' + cs.overflow); } }
		{ const ov = rig.$('.webview-overlay-content'); log('webview: overlay style=' + ov.getAttribute('style') + ' parent style=' + ov.parentElement.getAttribute('style')); const wc = rig.$$('.webview-editor-element, .editor-container .monaco-editor, .editor-instance').map((e) => rig.describe(e) + ' ' + JSON.stringify(e.getBoundingClientRect())); log('webview: editor els ' + wc.join(' | ')); }
		dump(ctx.doc); { const wdd = webviewDoc(); if (wdd) { log('webview: html=' + JSON.stringify(wdd.body.innerHTML.slice(0, 600))); } } await rig.settle(30, 40); rig.shot('webview_markdown');
	}
	rig.summary();
}
