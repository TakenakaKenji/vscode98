// Desktop scenario: latency of editor interaction. Opens a file, clicks into the text and types, and for each action reports the busy time split into
// event handling, frame callbacks (flushFrames), style, layout and paint, the way the window host drives the document (no idle waits counted).
// Usage: boot_desktop_qjs.mjs ... --workspace <dir> --scenario scenario_keys.mjs   (--edit-file <abs path>, --keys N)
import { runScenario } from '../../08-workbench-boot/host/boot_common.js';
import { paintDocument } from '../../06-rendering/host/dom/paint.js';
import { NativeBackend } from '../../07-native-render/host/native_backend.js';
import * as os from 'qjs:os';
const sleep = (ms) => new Promise((r) => os.setTimeout(r, ms));
export async function run(ctx) { try { await run0(ctx); } catch (e) { ctx.log('keys: failed ' + (e && e.stack || e)); } }
async function run0(ctx) {
	const { doc, log, env } = ctx; const name = ctx.opt('edit-file', '/tmp/claude-0/ws98/hello.txt').split('/').pop(); const W = ctx.W, H = ctx.H;
	const settle = (s = 20) => runScenario(ctx, { seconds: s, stableRounds: 40 });
	const backend = new NativeBackend(W, H, {}); let painted = -1;
	const MouseEvent = env.window.MouseEvent, PointerEvent = env.window.PointerEvent, KeyboardEvent = env.window.KeyboardEvent, InputEvent = env.window.InputEvent;
	const base = (x, y) => ({ clientX: x, clientY: y, screenX: x, screenY: y, bubbles: true, cancelable: true, composed: true, view: env.window, button: 0, buttons: 1, detail: 1 });
	const press = (x, y) => {
		const el = doc.elementFromPoint(x, y) || doc.body; el.dispatchEvent(new PointerEvent('pointerdown', { ...base(x, y), pointerId: 1, pointerType: 'mouse', isPrimary: true }));
		if (el.dispatchEvent(new MouseEvent('mousedown', base(x, y)))) { /* default action: none needed */ }
		el.dispatchEvent(new PointerEvent('pointerup', { ...base(x, y), buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true })); el.dispatchEvent(new MouseEvent('mouseup', { ...base(x, y), buttons: 0 })); el.dispatchEvent(new MouseEvent('click', { ...base(x, y), buttons: 0 }));
	};
	const key = (target, type, k) => { const ev = new KeyboardEvent(type, { key: k, code: 'Key' + k.toUpperCase(), keyCode: k.toUpperCase().charCodeAt(0), bubbles: true, cancelable: true, composed: true }); ev.which = ev.keyCode; target.dispatchEvent(ev); };
	// runs the window host's tick until nothing changes for a few ticks; returns the busy time split
	async function drive(act) {
		const p0 = doc.__passStats.length; const r = { event: 0, frames: 0, paint: 0, ticks: 0 }; let t = performance.now(); act(); r.event = performance.now() - t; let quiet = 0;
		while (quiet < 6) {
			await sleep(1); t = performance.now(); env.flushFrames?.(); r.frames += performance.now() - t; const passes = doc.__passStats.length;
			if (doc.__dirty || passes !== painted) { t = performance.now(); doc.__ensureLayout(); painted = doc.__passStats.length; backend.reset(); const px = paintDocument(doc, W, H, backend); r.paint += performance.now() - t; quiet = 0; } else { quiet++; }
			r.ticks++;
		}
		const ps = doc.__passStats.slice(p0); r.passes = ps.length; r.style = ps.reduce((a, x) => a + x.styleMs, 0); r.layout = ps.reduce((a, x) => a + x.layoutMs, 0); r.restyled = ps.reduce((a, x) => a + ((x.style && x.style.recomputed) || 0), 0); return r;
	}
	const fmt = (r) => `event ${r.event.toFixed(0)} ms, frames+layout ${r.frames.toFixed(0)} ms (${r.passes} passes: style ${r.style.toFixed(0)}, layout ${r.layout.toFixed(0)}, ${r.restyled} elements restyled), paint ${r.paint.toFixed(0)} ms`;
	{ const x = doc.querySelector('.onboarding-a-close-btn'); if (x) { x.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); await settle(10); } }
	const row = [...doc.querySelectorAll('.explorer-folders-view .monaco-list-row')].find(r => (r.getAttribute('aria-label') || '').startsWith(name)); if (!row) { log('keys: row not found'); return; }
	{ const rr = row.getBoundingClientRect(); log('keys: open file: ' + fmt(await drive(() => press(rr.left + 20, rr.top + rr.height / 2)))); await settle(); }
	const line = doc.querySelector('.view-line'); const lr = line.getBoundingClientRect();
	log('keys: click in text: ' + fmt(await drive(() => press(lr.left + 20, lr.top + lr.height / 2)))); await settle(5);
	const ta = doc.activeElement; if (!ta || ta.localName !== 'textarea') { log('keys: no textarea focused'); return; }
	for (const ch of 'abcdefgh'.slice(0, Number(ctx.opt('keys', 6)))) {
		const r = await drive(() => { key(ta, 'keydown', ch); ta.value = (ta.value || '') + ch; ta.dispatchEvent(new InputEvent('input', { data: ch, inputType: 'insertText', bubbles: true })); key(ta, 'keyup', ch); });
		log(`keys: key '${ch}': ${fmt(r)}`); if (ch === 'e') { log('keys: last pass ' + JSON.stringify(doc.__passStats.slice(-2).map(x => ({ total: x.total, mut: x.mutations, counts: x.counts, styleMs: x.styleMs, layoutMs: x.layoutMs, ms: x.ms, style: x.style })))); }
	}
}
