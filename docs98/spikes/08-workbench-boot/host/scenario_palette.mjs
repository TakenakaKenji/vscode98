import { runScenario } from './boot_common.js';
function key(target, type, k, kc, mods = {}) { const ev = new KeyboardEvent(type, { key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k, keyCode: kc, bubbles: true, cancelable: true, composed: true, ...mods }); ev.which = kc; target.dispatchEvent(ev); return ev; }
export async function run(ctx) {
	const { doc, log } = ctx; const skip = doc.querySelector('.onboarding-a-close-btn'); if (skip) { for (const ty of ['mousedown', 'mouseup', 'click']) { skip.dispatchEvent(new MouseEvent(ty, { bubbles: true, cancelable: true, button: 0, buttons: 1 })); } await runScenario(ctx, { seconds: 60, stableRounds: 8 }); }
	const t = doc.activeElement || doc.body; log(`active element: ${t.localName}.${t.className} (dialog ${doc.querySelector('.onboarding-a-close-btn') ? 'still open' : 'closed'})`);
	for (const [label, k, kc, mods] of [['F1', 'F1', 112, {}], ['Ctrl+Shift+P', 'p', 80, { ctrlKey: true, shiftKey: true }]]) {
		const before = doc.__passStats.length; const ev = key(t, 'keydown', k, kc, mods); key(t, 'keyup', k, kc, mods); await runScenario(ctx, { seconds: 30, stableRounds: 8 });
		const qi = doc.querySelector('.quick-input-widget'); log(`${label}: defaultPrevented=${ev.defaultPrevented}, passes ${doc.__passStats.length - before}, quick-input widget ${qi ? 'present display=' + qi.style.display : 'absent'}`);
		if (qi && qi.style.display !== 'none') { break; }
	}
}
