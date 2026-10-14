// Feature scenario: editing settings through the Settings editor (text box, number box, checkbox, drop-down) and checking settings.json.
import { createRig } from './scenario_lib.mjs';
import * as std from 'qjs:std';
export async function run(ctx) { try { await run0(ctx); } catch (e) { ctx.log('settings: failed ' + (e && e.stack || e)); } }
async function run0(ctx) {
	const rig = await createRig(ctx); const { check } = rig; const log = ctx.log; const ud = ctx.opt('user-data-dir', '/tmp/claude-0/ud98c');
	{ const x = rig.$('.onboarding-a-close-btn'); if (x) { await rig.clickEl(x); } }
	const settingsJson = () => { try { return JSON.parse(std.loadFile(ud + '/User/settings.json') || '{}'); } catch { return {}; } };
	await rig.key(',', { ctrl: true, rounds: 40 }); await rig.settle(40, 40); check('settings editor opens', !!rig.$('.settings-editor'));
	const search = async (q) => { await rig.key('Escape', { rounds: 20 }); await rig.settle(10, 20); await rig.key(',', { ctrl: true, rounds: 40 }); await rig.settle(30, 30); await rig.key('a', { ctrl: true }); await rig.type(q); await rig.settle(30, 40); };   // each query starts from a freshly opened Settings editor (focus is in its search box)
	await search('editor.fontSize'); const num = await rig.waitFor(() => rig.$$('.settings-editor .setting-item input').find((i) => i.getAttribute('aria-label') === 'editor.fontSize')); check('font size number box shows 14', !!num);
	if (num) { await rig.clickEl(num); await rig.key('a', { ctrl: true }); await rig.type('17'); await rig.key('Tab', { rounds: 40 }); await rig.settle(30, 60); check('font size written to settings.json', settingsJson()['editor.fontSize'] === 17, JSON.stringify(settingsJson()['editor.fontSize'])); rig.shot('settings1'); }
	await search('editor.wordWrap'); log('settings: search box value ' + JSON.stringify(rig.active && rig.active.value) + ' items ' + JSON.stringify(rig.$$('.settings-editor [data-key]').map((e) => e.getAttribute('data-key')))); const sel = await rig.waitFor(() => rig.$('.settings-editor [data-key="editor.wordWrap"] select'));
	log('settings: wordWrap control ' + (sel ? rig.describe(sel) : 'none')); rig.shot('settings_ww'); { const it = rig.$('.settings-editor .setting-item'); if (it) { log('settings: first item html ' + it.outerHTML.slice(0, 1500)); } } check('word wrap drop-down present', !!sel);
	if (sel) { await rig.clickEl(sel, { rounds: 40 }); await rig.settle(20, 30); rig.shot('settings2'); const opts = rig.$$('.context-view .option-text, .monaco-select-box-dropdown-container .option-text').map((o) => o.textContent); log('settings: drop-down options ' + JSON.stringify(opts)); check('drop-down opens with options', opts.length > 1); const on = rig.$$('.context-view .option-text, .monaco-select-box-dropdown-container .option-text').find((o) => /^on$/.test(o.textContent.trim())); if (on) { await rig.clickEl(on, { rounds: 40 }); await rig.settle(30, 60); check('word wrap written to settings.json', settingsJson()['editor.wordWrap'] === 'on', JSON.stringify(settingsJson()['editor.wordWrap'])); } }
	await search('editor.minimap.enabled'); const cb = await rig.waitFor(() => rig.$('.settings-editor [data-key="editor.minimap.enabled"] .monaco-custom-toggle'));
	check('minimap checkbox present', !!cb, cb ? rig.describe(cb) : ''); if (cb) { await rig.clickEl(cb, { rounds: 40 }); await rig.settle(30, 60); log('settings: minimap now ' + JSON.stringify(settingsJson()['editor.minimap.enabled'])); check('checkbox toggles the setting (true is the default, so the key is removed)', settingsJson()['editor.minimap.enabled'] !== false, JSON.stringify(settingsJson()['editor.minimap.enabled'])); rig.shot('settings3'); }
	rig.summary();
}
