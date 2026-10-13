// Desktop scenario: open a file, then click into the editor text the way the window host does (pointer + mouse events at real coordinates) and report what got focus.
// Usage: boot_desktop_qjs.mjs ... --workspace <dir> --scenario scenario_click.mjs   (--edit-file <abs path of the file clicked>)
import { runScenario } from '../../08-workbench-boot/host/boot_common.js';
const d = (e) => e ? e.localName + '.' + String(e.className || '').slice(0, 50) : 'null';
export async function run(ctx) {
	const { doc, log, env } = ctx; const name = ctx.opt('edit-file', '/tmp/claude-0/ws98/hello.txt').split('/').pop();
	const settle = (s = 20) => runScenario(ctx, { seconds: s, stableRounds: 40 });
	const MouseEvent = env.window.MouseEvent, PointerEvent = env.window.PointerEvent;
	const base = (x, y) => ({ clientX: x, clientY: y, screenX: x, screenY: y, bubbles: true, cancelable: true, composed: true, view: env.window, button: 0, buttons: 1, detail: 1 });
	const press = (x, y) => {
		const el = doc.elementFromPoint(x, y) || doc.body; const out = { target: d(el) };
		out.pointerdownPrevented = !el.dispatchEvent(new PointerEvent('pointerdown', { ...base(x, y), pointerId: 1, pointerType: 'mouse', isPrimary: true }));
		out.mousedownPrevented = !el.dispatchEvent(new MouseEvent('mousedown', base(x, y)));
		out.active = d(doc.activeElement);
		el.dispatchEvent(new PointerEvent('pointerup', { ...base(x, y), buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true })); el.dispatchEvent(new MouseEvent('mouseup', { ...base(x, y), buttons: 0 })); el.dispatchEvent(new MouseEvent('click', { ...base(x, y), buttons: 0 }));
		return out;
	};
	{ const x = doc.querySelector('.onboarding-a-close-btn'); if (x) { for (const t of ['mousedown', 'mouseup', 'click']) { x.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, button: 0, buttons: 1, detail: 1 })); } await settle(10); } }
	const row = [...doc.querySelectorAll('.explorer-folders-view .monaco-list-row')].find(r => (r.getAttribute('aria-label') || '').startsWith(name));
	if (!row) { log('scenario: row for ' + name + ' not found'); return; }
	{ const r = row.getBoundingClientRect(); log('scenario: row click ' + JSON.stringify(press(r.left + 20, r.top + r.height / 2))); await settle(); }
	const line = doc.querySelector('.view-line'); if (!line) { log('scenario: no view-line'); return; }
	const r = line.getBoundingClientRect(); log('scenario: view-line rect ' + JSON.stringify([r.left, r.top, r.width, r.height]));
	const cr = doc.caretRangeFromPoint(r.left + 20, r.top + r.height / 2); log('scenario: caretRange ' + (cr ? d(cr.startContainer) + ' ' + cr.startContainer.nodeType + ' @' + cr.startOffset : 'null'));
	{ let e = doc.elementFromPoint(r.left + 20, r.top + r.height / 2), chain = []; for (; e && e !== doc.body; e = e.parentElement) { chain.push(d(e) + '[' + e.getAttribute('data-mprt') + ']'); } log('scenario: target chain ' + chain.join(' < ')); }
	log('scenario: editor click ' + JSON.stringify(press(r.left + 20, r.top + r.height / 2))); await settle(5);
	log('scenario: active after settle ' + d(doc.activeElement)); log('scenario: mouse-handler calls ' + JSON.stringify(globalThis.__mh || null));
}
