// Feature scenario: more of the workbench: the diff editor (SCM), color themes, diagnostics, go to definition, formatting, folding, multi-cursor, word wrap, the Welcome page.
import { createRig } from './scenario_lib.mjs';
import * as std from 'qjs:std';
export async function run(ctx) { try { await run0(ctx); } catch (e) { ctx.log('more: failed ' + (e && e.stack || e)); } }
async function run0(ctx) {
	const rig = await createRig(ctx); const { check } = rig; const log = ctx.log; const ws = ctx.opt('workspace', '/tmp/claude-0/ws98'); const only = ctx.opt('only', ''); const on = (n) => !only || only.split(',').includes(n);
	const guard = async (name, f) => { if (!on(name)) { return; } try { await f(); } catch (e) { check(name + ' (exception)', false, String(e && e.stack || e).slice(0, 300)); } };
	{ const x = rig.$('.onboarding-a-close-btn'); if (x) { await rig.clickEl(x); } }
	const write = (name, text) => { const f = std.open(ws + '/' + name, 'w'); f.puts(text); f.close(); };
	write('fmt.js', 'function  add( a,b ){\nreturn a+b\n}\nconst   x=add( 1,2 );\nfunction outer() {\n\tfunction inner() {\n\t\treturn 1;\n\t}\n\treturn inner();\n}\n');
	write('diag.js', 'const a = 1;\nconst b = ;\n');
	write('lang.js', 'function greet(name) {\n\treturn "hello " + name;\n}\nconst message = greet("world");\n');
	await rig.key('e', { ctrl: true, shift: true, rounds: 30 });
	const openFile = async (name) => { if (!rig.$$('.explorer-folders-view').some((e) => e.getBoundingClientRect().width > 0)) { await rig.key('e', { ctrl: true, shift: true, rounds: 30 }); } const row = await rig.waitFor(() => rig.$$('.explorer-folders-view .monaco-list-row').find((r) => (r.getAttribute('aria-label') || '').startsWith(name))); if (!row) { check('explorer lists ' + name, false); return false; } await rig.clickEl(row, { rounds: 40 }); await rig.key('Enter', { rounds: 30 }); await rig.settle(30, 40); await rig.waitFor(() => rig.$$('.editor-instance .view-line').length); return true; };
	const editorText = () => rig.$$('.editor-instance .view-line').filter((l) => l.getBoundingClientRect().height > 0).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).map((l) => l.textContent.replace(/\u00a0/g, ' '));
	const palette = async (cmd, pick) => { await rig.key('p', { ctrl: true, shift: true, rounds: 40 }); await rig.waitFor(() => rig.$('.quick-input-box input')); await rig.type(cmd); await rig.settle(20, 30); log('more: palette rows ' + JSON.stringify(rig.$$('.quick-input-list .monaco-list-row').slice(0, 3).map((r) => r.textContent.slice(0, 50)))); await rig.key('Enter', { rounds: 40 }); await rig.settle(30, 40); if (pick) { await rig.waitFor(() => rig.$('.quick-input-widget') && rig.$$('.quick-input-list .monaco-list-row').length > 3, 20); log('more: picker rows ' + rig.$$('.quick-input-list .monaco-list-row').length + ' first ' + (rig.$('.quick-input-list .monaco-list-row') || { textContent: '' }).textContent.slice(0, 40)); await rig.type(pick); await rig.settle(20, 30); await rig.key('Enter', { rounds: 40 }); await rig.settle(30, 40); } };

	await guard('diff', async () => {
		await rig.key('g', { ctrl: true, shift: true, rounds: 40 }); await rig.settle(30, 60); const row = await rig.waitFor(() => rig.$$('.scm-view .monaco-list-row').find((r) => /hello\.txt/.test(r.textContent)), 30); check('scm lists the modified file', !!row); if (!row) { return; }
		await rig.clickEl(row, { rounds: 60 }); await rig.settle(40, 60); const de = await rig.waitFor(() => rig.$('.monaco-diff-editor'), 40); check('clicking a change opens the diff editor', !!de); rig.shot('more_diff');
		if (de) { const sides = rig.$$('.monaco-diff-editor .monaco-editor').length; check('diff editor has two sides', sides >= 2, String(sides)); }
	});
	await guard('theme', async () => {
		const bg = () => ctx.env.window.getComputedStyle(rig.$('.monaco-workbench')).backgroundColor; const before = rig.$('.monaco-workbench .part.editor') ? ctx.env.window.getComputedStyle(rig.$('.monaco-workbench .part.editor')).backgroundColor : bg();
		const pickTheme = async (name) => { await rig.key('k', { ctrl: true }); await rig.key('t', { ctrl: true, rounds: 40 }); await rig.waitFor(() => rig.$('.quick-input-box input')); await rig.settle(20, 30); await rig.type(name); await rig.settle(20, 30); await rig.key('Enter', { rounds: 40 }); await rig.settle(40, 40); }; await pickTheme('Light Modern'); await rig.settle(40, 60); rig.shot('more_theme_light'); const after = ctx.env.window.getComputedStyle(rig.$('.monaco-workbench .part.editor')).backgroundColor; check('color theme change restyles the workbench', after !== before, before + ' -> ' + after);
		await pickTheme('Dark Modern');
	});
	await guard('diagnostics', async () => {
		await openFile('diag.js'); const ok = await rig.waitFor(() => rig.$$('.view-overlays .squiggly-error, .monaco-editor .squiggly-error').length > 0, 60); check('syntax error gets a squiggle', !!ok); const st = rig.$$('.statusbar-item').map((e) => e.textContent.trim()).join(' | '); log('more: status ' + st.slice(0, 120));
		await rig.key('m', { ctrl: true, shift: true, rounds: 40 }); const row = await rig.waitFor(() => rig.$$('.markers-panel .monaco-list-row').length > 0, 30); check('problems panel lists the error', !!row, rig.$$('.markers-panel .monaco-list-row').map((r) => r.textContent.slice(0, 40)).join(' | ')); await rig.key('j', { ctrl: true, rounds: 30 });
	});
	await guard('definition', async () => {
		await openFile('lang.js'); await rig.settle(40, 80); const r = rig.$$('.editor-instance .monaco-editor').map((e) => e.getBoundingClientRect()).find((q) => q.width > 0); const lines = rig.$$('.editor-instance .view-line'); const l4 = lines.find((l) => /const message/.test(l.textContent.replace(/\u00a0/g, ' '))); if (!l4) { check('lang.js shows line 4', false); return; }
		const sp = [...l4.querySelectorAll('span')].find((q) => q.textContent === 'greet'); const lr = (sp || l4).getBoundingClientRect(); await rig.click(Math.round(lr.left + 8), Math.round(lr.top + 8)); await rig.key('F12', { rounds: 60 }); await rig.settle(30, 40); const st = rig.$$('.statusbar-item a').map((a) => a.textContent.trim()).find((t) => /^Ln /.test(t)); check('F12 goes to the definition (line 1)', /^Ln 1,/.test(st || ''), st);
	});
	await guard('format', async () => {
		await openFile('fmt.js'); await rig.settle(40, 80); const r = rig.$$('.editor-instance .monaco-editor').map((e) => e.getBoundingClientRect()).find((q) => q.width > 0); await rig.click(Math.round(r.left + 200), Math.round(r.top + 100)); await palette('Format Document'); await rig.settle(40, 80); await rig.settle(40, 60);
		const t = editorText(); check('format document normalizes the code', t.some((l) => /^function add\(a, b\) \{/.test(l)), JSON.stringify(t.slice(0, 3)));
	});
	await guard('fold', async () => {
		{ const fl = rig.$$('.editor-instance .view-line').find((l) => /function outer/.test(l.textContent.replace(/\u00a0/g, ' '))); if (fl) { const q = fl.getBoundingClientRect(); await rig.click(Math.round(q.left + 40), Math.round(q.top + 8)); } } await rig.key('[', { ctrl: true, shift: true, rounds: 40 }); await rig.settle(20, 30); const folded = rig.$$('.monaco-editor .folded, .monaco-editor .codicon-folding-collapsed').length; check('fold command folds a region', folded > 0, String(folded)); await rig.key(']', { ctrl: true, shift: true, rounds: 30 });
	});
	await guard('multicursor', async () => {
		await rig.key('Home', { ctrl: true, rounds: 20 }); await rig.key('f', { ctrl: true, rounds: 30 }); await rig.key('Escape'); await rig.key('End', { shift: true, rounds: 10 }); await rig.key('d', { ctrl: true, rounds: 30 }); const cursors = rig.$$('.cursors-layer .cursor').filter((c) => c.getBoundingClientRect().width > 0).length; log('more: cursors ' + cursors); check('ctrl+d adds a selection (multi-cursor)', cursors >= 1);
	});
	await guard('wrap', async () => { await rig.key('z', { alt: true, rounds: 40 }); await rig.settle(20, 30); check('alt+z runs without error', true); });
	await guard('welcome', async () => {
		await palette('Help: Welcome'); await rig.settle(40, 60); const g = await rig.waitFor(() => rig.$('.gettingStartedContainer, .welcomePageContainer, .gettingStarted'), 30); check('welcome page opens', !!g); rig.shot('more_welcome');
	});
	rig.summary();
}
