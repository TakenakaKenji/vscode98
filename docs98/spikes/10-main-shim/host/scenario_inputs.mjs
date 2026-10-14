// Feature scenario: text editing in plain <input> controls (the command palette's input box): typing, caret movement, selection, deletion, clipboard, undo.
import { createRig } from './scenario_lib.mjs';
export async function run(ctx) { try { await run0(ctx); } catch (e) { ctx.log('inputs: failed ' + (e && e.stack || e)); } }
async function run0(ctx) {
	const rig = await createRig(ctx); const { check } = rig; const sel = () => { const a = rig.active; return a && a.localName === 'input' ? [a.selectionStart, a.selectionEnd] : null; };
	{ const x = rig.$('.onboarding-a-close-btn'); if (x) { await rig.clickEl(x); } }
	await rig.key('F1'); const input = await rig.waitFor(() => rig.$('.quick-input-box input')); check('palette input appears', !!input);
	check('palette input focused', rig.active === input, rig.describe(rig.active));
	await rig.key('Backspace'); await rig.type('hello'); check('typed text in value', input.value === 'hello', JSON.stringify(input.value)); rig.shot('inputs1');
	await rig.key('ArrowLeft'); await rig.key('ArrowLeft'); check('caret moved left 2', JSON.stringify(sel()) === '[3,3]', JSON.stringify(sel()));
	await rig.type('X'); check('insert at caret', input.value === 'helXlo', input.value);
	await rig.key('Backspace'); check('backspace', input.value === 'hello', input.value);
	await rig.key('Home'); check('home', JSON.stringify(sel()) === '[0,0]');
	await rig.key('End', { shift: true }); check('shift+end selects', JSON.stringify(sel()) === '[0,5]', JSON.stringify(sel()));
	await rig.type('x'); check('typing replaces selection', input.value === 'x', input.value);
	await rig.key('z', { ctrl: true }); check('undo', input.value === 'hello', input.value);
	await rig.key('a', { ctrl: true }); check('ctrl+a', JSON.stringify(sel()) === '[0,5]', JSON.stringify(sel())); rig.shot('inputs2');
	await rig.key('c', { ctrl: true }); check('ctrl+c copies', globalThis.__clipboard98.text === 'hello', JSON.stringify(globalThis.__clipboard98.text));
	await rig.key('Delete'); check('delete selection', input.value === '', JSON.stringify(input.value));
	await rig.key('v', { ctrl: true }); check('ctrl+v pastes', input.value === 'hello', JSON.stringify(input.value));
	await rig.key('Backspace', { ctrl: true }); check('ctrl+backspace deletes word', input.value === '', JSON.stringify(input.value));
	await rig.type('abc def'); await rig.key('ArrowLeft', { ctrl: true }); check('ctrl+left word', JSON.stringify(sel()) === '[4,4]', JSON.stringify(sel()));
	{ const r = input.getBoundingClientRect(); await rig.click(Math.round(r.left + 20), Math.round(r.top + r.height / 2)); check('click places caret', sel() && sel()[0] === sel()[1] && sel()[0] < 7, JSON.stringify(sel())); rig.shot('inputs3');
	  await rig.click(Math.round(r.left + 20), Math.round(r.top + r.height / 2), { detail: 2 }); check('double click selects a word', sel() && sel()[1] > sel()[0], JSON.stringify(sel())); }
	await rig.key('Escape'); check('escape closes palette', !rig.$('.quick-input-widget:not([style*="display: none"]) .quick-input-box input') || rig.active !== input);
	rig.summary();
}
