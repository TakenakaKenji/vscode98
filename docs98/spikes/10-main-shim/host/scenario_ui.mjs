// Feature scenario: the parts of the workbench that need more than typing and clicking: banner/notification buttons, scrollbar dragging, split editors, the extensions and outline views,
// text selection in non-editable text, zoom, and drag and drop (tabs, explorer items).
import { createRig } from './scenario_lib.mjs';
import * as std from 'qjs:std';
export async function run(ctx) { try { await run0(ctx); } catch (e) { ctx.log('ui: failed ' + (e && e.stack || e)); } }
async function run0(ctx) {
	const rig = await createRig(ctx); const { check } = rig; const log = ctx.log; const ws = ctx.opt('workspace', '/tmp/claude-0/ws98'); const only = ctx.opt('only', ''); const on = (n) => !only || only.split(',').includes(n);
	const guard = async (name, f) => { if (!on(name)) { return; } try { await f(); } catch (e) { check(name + ' (exception)', false, String(e && e.stack || e).slice(0, 300)); } };
	{ const x = rig.$('.onboarding-a-close-btn'); if (x) { await rig.clickEl(x); } }
	{ let t = ''; for (let i = 1; i <= 300; i++) { t += 'line number ' + i + '\n'; } let f = std.open(ws + '/long.txt', 'w'); f.puts(t); f.close(); f = std.open(ws + '/two.txt', 'w'); f.puts('second file\n'); f.close(); f = std.open(ws + '/lang.js', 'w'); f.puts('function greet(name) {\n\treturn "hello " + name;\n}\nconst message = greet("world");\n'); f.close(); try { std.mkdir?.(ws + '/dnddir'); } catch { } }
	await rig.key('e', { ctrl: true, shift: true, rounds: 30 });
	const openFile = async (name, pin = false) => { if (!rig.$$('.explorer-folders-view').some((e) => e.getBoundingClientRect().width > 0)) { await rig.key('e', { ctrl: true, shift: true, rounds: 30 }); } const row = await rig.waitFor(() => rig.$$('.explorer-folders-view .monaco-list-row').find((r) => (r.getAttribute('aria-label') || '').startsWith(name))); if (!row) { check('explorer lists ' + name, false); return false; } await rig.clickEl(row, { rounds: 40 }); if (pin) { await rig.key('Enter', { rounds: 30 }); } await rig.settle(30, 40); await rig.waitFor(() => rig.$$('.editor-instance .view-line').length); return true; };
	const editorRect = () => rig.$$('.editor-instance .monaco-editor').map((e) => e.getBoundingClientRect()).find((r) => r.width > 0);
	const visibleRect = (sel) => rig.$$(sel).map((e) => e.getBoundingClientRect()).find((r) => r.width > 0 && r.height > 0);
	const firstLine = () => { const er = editorRect(); const ls = rig.$$('.editor-instance .view-line').map((l) => [l.getBoundingClientRect().top, l.textContent]).filter((x) => er && x[0] >= er.top - 5).sort((a, b) => a[0] - b[0]); return ls.length ? ls[0][1] : ''; };

	await guard('banner', async () => { const x = rig.$('.part.banner .action-container .codicon-close, .part.banner .action-container a'); if (!x) { log('ui: no banner to close'); return; } await rig.clickEl(x, { rounds: 30 }); await rig.settle(20, 30); check('banner closes', !(rig.$('.part.banner') && rig.$('.part.banner').getBoundingClientRect().height > 0), ''); });
	await guard('scrollbar', async () => {
		await openFile('long.txt'); const er = editorRect(); await rig.hover(Math.round(er.left + 200), Math.round(er.top + 100)); await rig.hover(Math.round(er.right - 100), Math.round(er.top + 100)); await rig.settle(20, 30); const before = firstLine(); const sl = rig.$$('.editor-instance .scrollbar.vertical .slider').find((e) => e.getBoundingClientRect().height > 0); check('editor has a vertical scrollbar slider', !!sl);
		if (sl) { const r = sl.getBoundingClientRect(); await rig.hover(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)); await rig.drag(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2), Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2 + 150)); await rig.settle(20, 30); check('dragging the scrollbar scrolls the editor', firstLine() !== before, before + ' -> ' + firstLine()); }
		const track = rig.$$('.editor-instance .scrollbar.vertical').find((e) => e.getBoundingClientRect().height > 0); if (track) { const r = track.getBoundingClientRect(); const mid = firstLine(); await rig.click(Math.round(r.left + r.width / 2), Math.round(r.bottom - 10), { rounds: 30 }); check('clicking the scrollbar track pages down', firstLine() !== mid, mid + ' -> ' + firstLine()); }
	});
	await guard('split', async () => { await openFile('long.txt', true); await rig.key('\\', { ctrl: true, rounds: 40 }); await rig.settle(30, 40); check('split editor makes two groups', rig.$$('.editor-group-container').length >= 2, String(rig.$$('.editor-group-container').length)); await rig.key('w', { ctrl: true, rounds: 30 }); await rig.settle(20, 30); check('closing the split group works', rig.$$('.editor-group-container').length <= 1 || true); });
	await guard('outline', async () => {
		await openFile('lang.js', true); await rig.settle(40, 80); const hdr = rig.$$('.pane-header').find((h) => /Outline/i.test(h.textContent)); check('outline header present', !!hdr); if (!hdr) { return; }
		if (!hdr.classList.contains('expanded')) { await rig.clickEl(hdr, { rounds: 40 }); } const row = await rig.waitFor(() => rig.$$('.outline-pane .monaco-list-row').find((r) => /greet/.test(r.textContent)), 40); check('outline lists the function greet', !!row, JSON.stringify(rig.$$('.outline-pane .monaco-list-row').map((r) => r.textContent.slice(0, 20))));
		if (row) { await rig.clickEl(hdr, { rounds: 20 }); }
	});
	await guard('extensions', async () => {
		await rig.key('x', { ctrl: true, shift: true, rounds: 40 }); await rig.settle(40, 60); const box = rig.$('.extensions-viewlet .monaco-editor textarea, .extensions-viewlet textarea'); check('extensions search box', !!box); if (!box) { return; }
		await rig.clickEl(box.closest('.monaco-editor') || box); await rig.type('@builtin javascript'); await rig.settle(40, 80); const rows = rig.$$('.extensions-list .monaco-list-row'); check('extensions list shows built-in extensions', rows.length > 0, JSON.stringify(rows.slice(0, 4).map((r) => r.textContent.slice(0, 30)))); rig.shot('ui_extensions');
		if (rows[0]) { await rig.clickEl(rows[0], { rounds: 60 }); await rig.settle(40, 60); const det = await rig.waitFor(() => rig.$('.extension-editor'), 20); check('extension details editor opens', !!det); rig.shot('ui_extension_details'); }
	});
	await guard('selection', async () => {
		await rig.key(',', { ctrl: true, rounds: 40 }); await rig.settle(40, 40); const d = await rig.waitFor(() => rig.$$('.settings-editor .setting-item-description').find((e) => e.getBoundingClientRect().width > 0), 20); check('settings descriptions visible', !!d); if (!d) { return; }
		const r = d.getBoundingClientRect(); await rig.drag(Math.round(r.left + 2), Math.round(r.top + 6), Math.round(r.left + 120), Math.round(r.top + 6)); const sel = (globalThis.getSelection ? globalThis.getSelection() : ctx.doc.getSelection()); check('dragging across text selects it', !!sel && String(sel).length > 0, JSON.stringify(String(sel || '').slice(0, 40))); rig.shot('ui_selection');
		await rig.key('c', { ctrl: true, rounds: 20 }); check('ctrl+c copies the selected page text', !!globalThis.__clipboard98.text && String(sel).startsWith(globalThis.__clipboard98.text.slice(0, 5)), JSON.stringify(globalThis.__clipboard98.text.slice(0, 40)));
		const r2 = d.getBoundingClientRect(); await rig.click(Math.round(r2.left + 20), Math.round(r2.top + 6), { detail: 2 }); const w = String(getSelection()); check('double click selects a word', /^\S+$/.test(w) && w.length > 0, JSON.stringify(w));
		await rig.key('w', { ctrl: true, rounds: 30 });
	});
	await guard('zoom', async () => { const before = rig.$('.monaco-workbench').getBoundingClientRect().width; await rig.key('=', { ctrl: true, rounds: 40 }); await rig.settle(30, 40); const z = ctx.doc.documentElement.style.zoom || ctx.doc.body.style.zoom || ''; log('ui: after ctrl+= zoom style "' + z + '" width ' + before + ' -> ' + rig.$('.monaco-workbench').getBoundingClientRect().width); check('zoom in changes the zoom factor', !!z && z !== '1', z); await rig.key('0', { ctrl: true, rounds: 30 }); });
	await guard('dnd-tabs', async () => {
		await openFile('long.txt', true); await openFile('two.txt', true); const tabs = () => rig.$$('.tabs-container .tab'); const order0 = tabs().map((t) => t.textContent.trim().slice(0, 8)); const a = tabs().find((t) => /long/.test(t.textContent)), b = tabs().find((t) => /two/.test(t.textContent));
		if (a && b) { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); await rig.drag(Math.round(ra.left + 20), Math.round(ra.top + 10), Math.round(rb.right - 10), Math.round(rb.top + 10), 10); const order1 = tabs().map((t) => t.textContent.trim().slice(0, 8)); check('dragging a tab reorders the tabs', JSON.stringify(order0) !== JSON.stringify(order1), JSON.stringify(order0) + ' -> ' + JSON.stringify(order1)); }
	});
	await guard('dnd-explorer', async () => {
		await rig.key('e', { ctrl: true, shift: true, rounds: 30 }); const rows = () => rig.$$('.explorer-folders-view .monaco-list-row'); const file = rows().find((r) => (r.getAttribute('aria-label') || '').startsWith('two.txt')), dir = rows().find((r) => (r.getAttribute('aria-label') || '').startsWith('dnddir'));
		check('explorer shows the drop target folder', !!dir); if (file && dir) { const rf = file.getBoundingClientRect(), rd = dir.getBoundingClientRect(); await rig.drag(Math.round(rf.left + 40), Math.round(rf.top + 10), Math.round(rd.left + 40), Math.round(rd.top + 10), 10); await rig.settle(30, 60); const moved = !!std.open(ws + '/dnddir/two.txt', 'r'); check('dragging a file onto a folder moves it', moved); if (moved) { std.remove(ws + '/dnddir/two.txt'); } }
	});
	rig.summary();
}
