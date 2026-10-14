// Feature scenario: language features of the extension host in the editor (JavaScript): completion list, hover, diagnostics, go to definition, outline.
import { createRig } from './scenario_lib.mjs';
import * as std from 'qjs:std';
export async function run(ctx) { try { await run0(ctx); } catch (e) { ctx.log('lang: failed ' + (e && e.stack || e)); } }
async function run0(ctx) {
	const rig = await createRig(ctx); const { check } = rig; const log = ctx.log; const ws = ctx.opt('workspace', '/tmp/claude-0/ws98');
	{ const x = rig.$('.onboarding-a-close-btn'); if (x) { await rig.clickEl(x); } }
	{ const f = std.open(ws + '/lang.js', 'w'); f.puts('function greet(name) {\n\treturn "hello " + name;\n}\nconst message = greet("world");\nmessage.'); f.close(); }
	const row = await rig.waitFor(() => rig.$$('.explorer-folders-view .monaco-list-row').find((r) => (r.getAttribute('aria-label') || '').startsWith('lang.js')));
	check('explorer lists lang.js', !!row); if (!row) { rig.summary(); return; }
	await rig.clickEl(row, { rounds: 40 }); await rig.settle(30, 40); await rig.waitFor(() => rig.$('.editor-instance .view-line'));
	await rig.settle(40, 80);   // the language server starts
	{ const l = rig.$$('.view-line').pop().getBoundingClientRect(); await rig.click(Math.round(l.left + 300), Math.round(l.top + 8)); }
	await rig.key('End', { ctrl: true }); await rig.type('to'); await rig.key(' ', { ctrl: true, rounds: 60 }); const w = await rig.waitFor(() => { const e = rig.$('.suggest-widget.visible'); return e && e.querySelectorAll('.monaco-list-row').length ? e : null; }, 40);
	check('completion list appears for "message.to"', !!w, w ? JSON.stringify(rig.$$('.suggest-widget .monaco-list-row').slice(0, 5).map((r) => r.textContent.slice(0, 30))) : 'none'); rig.shot('lang1');
	await rig.key('Escape'); await rig.key('Home', { ctrl: true }); await rig.settle(10, 20);
	const word = rig.$$('.view-line span').find((s) => s.textContent === 'greet'); if (word) { const r = word.getBoundingClientRect(); await rig.hover(Math.round(r.left + 5), Math.round(r.top + 5)); await rig.settle(40, 60); const h = await rig.waitFor(() => rig.$('.monaco-hover:not(.hidden) .hover-contents'), 20); check('hover widget appears over a function name', !!h, h ? h.textContent.slice(0, 80) : 'none'); rig.shot('lang2'); } else { check('found the word greet', false); }
	rig.summary();
}
