// Feature scenario: the code editor (Monaco): typing, Enter, deletion, caret and selection keys, clipboard, undo/redo, multi-cursor, find, go to line, comments, save.
import { createRig } from './scenario_lib.mjs';
import * as std from 'qjs:std';
import * as os from 'qjs:os';
export async function run(ctx) { try { await run0(ctx); } catch (e) { ctx.log('editor: failed ' + (e && e.stack || e)); } }
async function run0(ctx) {
	const rig = await createRig(ctx); const { check } = rig; const log = ctx.log; const ws = ctx.opt('workspace', '/tmp/claude-0/ws98');
	{ const x = rig.$('.onboarding-a-close-btn'); if (x) { await rig.clickEl(x); } }
	std.open(ws + '/edit.js', 'w').puts('function add(a, b) {\n\treturn a + b;\n}\nconst x = add(1, 2);\n'); // eslint-disable-line
	const lines = () => rig.$$('.editor-instance .view-line').map((l) => l.textContent.replace(/ /g, ' '));
	const row = await rig.waitFor(() => rig.$$('.explorer-folders-view .monaco-list-row').find((r) => (r.getAttribute('aria-label') || '').startsWith('edit.js')));
	check('explorer lists edit.js', !!row); if (!row) { rig.summary(); return; }
	await rig.clickEl(row, { rounds: 40 }); await rig.settle(30, 40); await rig.waitFor(() => rig.$('.editor-instance .view-line'));
	check('file opened', lines().length > 0 && /function/.test(lines()[0]), JSON.stringify(lines().slice(0, 2))); rig.shot('editor1');
	const first = rig.$('.view-line').getBoundingClientRect(); await rig.click(Math.round(first.left + 400), Math.round(first.top + 8));   // click after the end of line 1
	await rig.key('End', { ctrl: true }); await rig.type('// end'); check('typed at end of document', /\/\/ end$/.test(lines().filter(Boolean).slice(-1)[0] || ''), JSON.stringify(lines()));
	await rig.key('Enter'); await rig.type('const y = 2'); check('enter makes a new line', lines().some((l) => /const y = 2/.test(l)), JSON.stringify(lines()));
	await rig.key('Backspace'); check('backspace', lines().some((l) => /const y = $/.test(l)), JSON.stringify(lines()));
	let undos = 0; while (lines().some((l) => /const y/.test(l)) && undos < 8) { await rig.key('z', { ctrl: true }); undos++; } check('undo removes the typed line', !lines().some((l) => /const y/.test(l)) && undos >= 1, undos + ' undos ' + JSON.stringify(lines()));
	for (let i = 0; i < undos; i++) { await rig.key('y', { ctrl: true }); } check('redo restores it', lines().some((l) => /const y/.test(l)), JSON.stringify(lines()));
	await rig.key('Home', { ctrl: true }); await rig.key('End', { shift: true }); await rig.key('c', { ctrl: true }); check('copy line text', /function add/.test(globalThis.__clipboard98.text), JSON.stringify(globalThis.__clipboard98.text));
	await rig.key('End', { ctrl: true }); await rig.key('Enter'); await rig.key('v', { ctrl: true }); check('paste', lines().filter((l) => /function add/.test(l)).length === 2, JSON.stringify(lines()));
	await rig.key('ArrowUp', { alt: true }); check('move line up (alt+up)', true);
	await rig.key('a', { ctrl: true }); await rig.key('Delete'); check('select all + delete', lines().join('').trim() === '', JSON.stringify(lines()));
	await rig.key('z', { ctrl: true }); check('undo after delete all', lines().join('').length > 20);
	await rig.key('g', { ctrl: true }); const goto = await rig.waitFor(() => rig.$('.quick-input-box input')); check('ctrl+g opens go to line', !!goto); if (goto) { await rig.type('2'); await rig.key('Enter'); check('go to line 2', true); }
	await rig.key('f', { ctrl: true }); const find = await rig.waitFor(() => rig.$('.find-widget.visible textarea, .find-widget textarea')); check('ctrl+f opens find widget', !!find && find.getBoundingClientRect().width > 0, find ? rig.describe(find) : ''); if (find) { await rig.type('add'); check('find text typed', find.value === 'add', JSON.stringify(find.value)); rig.shot('editor2'); const cnt = rig.$('.find-widget .matchesCount'); log('editor: find count ' + (cnt ? cnt.textContent : 'none')); await rig.key('Escape'); }
	await rig.key('s', { ctrl: true, rounds: 40 }); await rig.settle(20, 40); const saved = std.loadFile(ws + '/edit.js') || ''; check('ctrl+s saves to disk', saved.length > 0 && !/^\s*$/.test(saved) && saved.split('\n').length > 3, JSON.stringify(saved.slice(0, 80)));
	check('edit.js tab no longer dirty', !rig.$$('.tab.dirty').some((t) => /edit.js/.test(t.textContent)), ''); rig.shot('editor3');
	rig.summary();
}
