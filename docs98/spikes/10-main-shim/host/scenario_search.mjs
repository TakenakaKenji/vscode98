// Feature scenario: the Search view: typing a query, results from the workspace, include/exclude boxes, replace.
import { createRig } from './scenario_lib.mjs';
export async function run(ctx) { try { await run0(ctx); } catch (e) { ctx.log('search: failed ' + (e && e.stack || e)); } }
async function run0(ctx) {
	const rig = await createRig(ctx); const { check } = rig; const log = ctx.log;
	{ const x = rig.$('.onboarding-a-close-btn'); if (x) { await rig.clickEl(x); } }
	await rig.key('f', { ctrl: true, shift: true, rounds: 30 }); const box = await rig.waitFor(() => rig.$('.search-widget .input-box textarea, .search-widget .input-box input, .search-widget textarea.input'));
	check('search input appears', !!box, box ? rig.describe(box) : ''); if (!box) { rig.shot('search0'); rig.summary(); return; }
	check('search input focused', rig.active === box, rig.describe(rig.active)); await rig.type('hello'); check('query typed', box.value === 'hello', JSON.stringify(box.value)); rig.shot('search1');
	await rig.key('Enter', { rounds: 80 }); await rig.settle(40, 80); rig.shot('search2');
	const msg = rig.$('.search-view .messages'); log('search: messages: ' + (msg ? msg.textContent.slice(0, 160) : 'none'));
	const matches = rig.$$('.search-view .monaco-list-row .match, .search-view .monaco-list-row .filematch'); log('search: result rows ' + matches.length + ' ' + JSON.stringify(rig.$$('.search-view .monaco-list-row').map((r) => r.textContent.slice(0, 50)).slice(0, 6)));
	check('search shows results', matches.length > 0);
	rig.summary();
}
