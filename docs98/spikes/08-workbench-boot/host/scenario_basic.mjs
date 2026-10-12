// Scripted interaction with the booted workbench: new untitled file, typing, command palette, activity bar click. For each action: layout passes, time, and what
// a perfect incremental invalidation would have restyled (see summarizeDirty in 06-rendering/host/dom/env.js). Shared by the Node and QuickJS harnesses.
import { runScenario } from './boot_common.js';

const KEYS = { n: 78, p: 80, Escape: 27, F1: 112, Enter: 13 };
function key(target, type, k, mods = {}) { const ev = new KeyboardEvent(type, { key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k, keyCode: KEYS[k.toLowerCase?.()] ?? KEYS[k] ?? (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0), bubbles: true, cancelable: true, composed: true, ...mods }); ev.which = ev.keyCode; target.dispatchEvent(ev); return ev; }
const target = (doc) => doc.activeElement || doc.body;

export async function run(ctx) {
	const { doc, log } = ctx; const rows = [];
	const measure = async (label, action, settle = 20) => {
		const before = doc.__passStats.length; const t = performance.now(); await action(); await runScenario(ctx, { seconds: settle, stableRounds: 8 });
		const p = doc.__passStats.slice(before); const sum = (f) => p.reduce((a, x) => a + f(x), 0);
		const row = { label, passes: p.length, ms: Math.round(sum(x => x.ms)), styleMs: Math.round(sum(x => x.styleMs)), layoutMs: Math.round(sum(x => x.layoutMs)), wall: Math.round(performance.now() - t), restyleNow: sum(x => x.style ? x.style.recomputed : x.total), rematchNow: sum(x => x.style ? x.style.rematched : x.total), restyleIdeal: sum(x => x.restyleEstimate), elements: doc.getElementsByTagName('*').length };
		rows.push(row); if (globalThis.__scenarioDetail) for (const x of p) log(`      pass ${x.ms.toFixed(0)} ms mut ${x.mutations} ${JSON.stringify(x.counts)} est ${x.restyleEstimate} style ${JSON.stringify(x.style)}`); log(`  ${label}: ${row.passes} passes, ${row.ms} ms (style ${row.styleMs}, layout ${row.layoutMs}), element restyles now ${row.restyleNow} (rematched ${row.rematchNow}) vs ideal ${row.restyleIdeal}, wall ${row.wall} ms, ${row.elements} elements`);
	};
	log('scenario:');
	const skip = doc.querySelector('.onboarding-a-close-btn'); if (skip) { await measure('close the onboarding dialog (click X)', async () => { for (const t of ['mousedown', 'mouseup', 'click']) { skip.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, button: 0, buttons: 1 })); } }); }
	await measure('Ctrl+N (new untitled file)', async () => { key(target(doc), 'keydown', 'n', { ctrlKey: true }); key(target(doc), 'keyup', 'n', { ctrlKey: true }); });
	const editors = doc.querySelectorAll('.monaco-editor').length; const ta = doc.querySelector('.monaco-editor textarea'); log(`  -> .monaco-editor elements: ${editors}, textarea: ${!!ta}, active element: ${doc.activeElement && doc.activeElement.localName}`);
	const text = 'const x'; const typed = [];
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]; await measure(`type '${ch}'`, async () => { const t = doc.querySelector('.monaco-editor textarea') || target(doc); key(t, 'keydown', ch); const before = t.value || ''; t.value = before + ch; t.dispatchEvent(new InputEvent('input', { data: ch, inputType: 'insertText', bubbles: true })); key(t, 'keyup', ch); }, 6);
		typed.push(rows[rows.length - 1]);
	}
	const lines = doc.querySelectorAll('.monaco-editor .view-line'); log(`  -> editor text: ${JSON.stringify([...lines].map(l => l.textContent).join('|'))}`);
	const avg = (f) => (typed.reduce((a, r) => a + f(r), 0) / typed.length);
	log(`  typing, per character: ${avg(r => r.passes).toFixed(1)} passes, ${avg(r => r.ms).toFixed(0)} ms (style ${avg(r => r.styleMs).toFixed(0)}, layout ${avg(r => r.layoutMs).toFixed(0)}), element restyles now ${avg(r => r.restyleNow).toFixed(0)} vs ideal ${avg(r => r.restyleIdeal).toFixed(0)}`);
	await measure('F1 (command palette)', async () => { key(target(doc), 'keydown', 'F1'); key(target(doc), 'keyup', 'F1'); });
	log(`  -> quick input visible: ${!!doc.querySelector('.quick-input-widget') && doc.querySelector('.quick-input-widget').style.display !== 'none'}`);
	await measure('Escape', async () => { key(target(doc), 'keydown', 'Escape'); key(target(doc), 'keyup', 'Escape'); });
	const search = [...doc.querySelectorAll('.activitybar .action-label, .composite-bar .action-label')].find(e => /Search/.test(e.getAttribute('aria-label') || ''));
	if (search) { await measure('click Search (activity bar)', async () => { for (const t of ['mousedown', 'mouseup', 'click']) { search.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, button: 0, buttons: 1 })); } }); } else { log('  (Search action label not found)'); }
	ctx.scenarioRows = rows;
	if (doc.__verifyStyles) { log(`style verification against a full restyle, boot + scenario: ${(doc.__styleMismatches || []).length} mismatches`); }
}
