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
	globalThis.__rasterProfile = true; const backend = new NativeBackend(W, H, {}); let painted = -1;
	const MouseEvent = env.window.MouseEvent, PointerEvent = env.window.PointerEvent, KeyboardEvent = env.window.KeyboardEvent, InputEvent = env.window.InputEvent;
	const base = (x, y) => ({ clientX: x, clientY: y, screenX: x, screenY: y, bubbles: true, cancelable: true, composed: true, view: env.window, button: 0, buttons: 1, detail: 1 });
	const press = (x, y) => {
		const el = doc.elementFromPoint(x, y) || doc.body; el.dispatchEvent(new PointerEvent('pointerdown', { ...base(x, y), pointerId: 1, pointerType: 'mouse', isPrimary: true }));
		if (el.dispatchEvent(new MouseEvent('mousedown', base(x, y)))) { /* default action: none needed */ }
		el.dispatchEvent(new PointerEvent('pointerup', { ...base(x, y), buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true })); el.dispatchEvent(new MouseEvent('mouseup', { ...base(x, y), buttons: 0 })); el.dispatchEvent(new MouseEvent('click', { ...base(x, y), buttons: 0 }));
	};
	const key = (target, type, k) => { const ev = new KeyboardEvent(type, { key: k, code: k === 'F1' ? 'F1' : 'Key' + k.toUpperCase(), keyCode: k === 'F1' ? 112 : k.toUpperCase().charCodeAt(0), bubbles: true, cancelable: true, composed: true }); ev.which = ev.keyCode; target.dispatchEvent(ev); };
	// runs the window host's tick until nothing changes for a few ticks; returns the busy time split
	async function drive(act) {
		const p0 = doc.__passStats.length; const r = { event: 0, frames: 0, paint: 0, ticks: 0 }; let t = performance.now(); act(); r.event = performance.now() - t; let quiet = 0;
		while (quiet < 6) {
			await sleep(1); t = performance.now(); env.flushFrames?.(); r.frames += performance.now() - t; const passes = doc.__passStats.length;
			if (doc.__dirty || passes !== painted) { t = performance.now(); doc.__ensureLayout(); painted = doc.__passStats.length; backend.reset(); const px = paintDocument(doc, W, H, backend); r.paint += performance.now() - t; r.exec = (r.exec || 0) + backend.execMs; r.cmds = backend.commands; quiet = 0; } else { quiet++; }
			r.ticks++;
		}
		const ps = doc.__passStats.slice(p0); r.passes = ps.length; r.style = ps.reduce((a, x) => a + x.styleMs, 0); r.layout = ps.reduce((a, x) => a + x.layoutMs, 0); r.restyled = ps.reduce((a, x) => a + ((x.style && x.style.recomputed) || 0), 0); return r;
	}
	const fmt = (r) => `event ${r.event.toFixed(0)} ms, frames+layout ${r.frames.toFixed(0)} ms (${r.passes} passes: style ${r.style.toFixed(0)}, layout ${r.layout.toFixed(0)}, ${r.restyled} elements restyled), paint ${r.paint.toFixed(0)} ms (raster ${(r.exec || 0).toFixed(0)} ms, ${r.cmds} commands)`;
	{ const x = doc.querySelector('.onboarding-a-close-btn'); if (x) { x.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); await settle(10); } }
	const row = [...doc.querySelectorAll('.explorer-folders-view .monaco-list-row')].find(r => (r.getAttribute('aria-label') || '').startsWith(name)); if (!row) { log('keys: row not found'); return; }
	{ const rr = row.getBoundingClientRect(); log('keys: open file: ' + fmt(await drive(() => press(rr.left + 20, rr.top + rr.height / 2)))); await settle(); }
	const line = doc.querySelector('.view-line'); const lr = line.getBoundingClientRect();
	{ const why = {}; globalThis.__styleDebug = (plan, lg) => { const per = {}; for (const [el, w] of plan.why) { const k = (w || '').slice(0, 60); per[k] = (per[k] || 0) + 1; } for (const [k, n] of Object.entries(per)) { why[k] = (why[k] || 0) + n; } const ch = lg.filter(x => x[1] === 'attr' && x[3] === 'class').map(x => x[2].localName + '.' + String(x[2].getAttribute('class') || '').split(' ').slice(0, 2).join('.')); (why.__classChanged ??= []).push(...ch.slice(0, 6)); };
	log('keys: click in text: ' + fmt(await drive(() => press(lr.left + 20, lr.top + lr.height / 2)))); log('keys: click marks ' + JSON.stringify(Object.entries(why).filter(([k]) => k !== '__classChanged').sort((a, b) => b[1] - a[1]).slice(0, 12)) + ' classChanged ' + JSON.stringify(why.__classChanged)); globalThis.__styleDebug = undefined; } await settle(5);
	const ta = doc.activeElement; if (!ta || ta.localName !== 'textarea') { log('keys: no textarea focused'); return; }
	globalThis.__pl = {};
	for (const ch of 'abcdefgh'.slice(0, Number(ctx.opt('keys', 6)))) {
		const r = await drive(() => { key(ta, 'keydown', ch); ta.value = (ta.value || '') + ch; ta.dispatchEvent(new InputEvent('input', { data: ch, inputType: 'insertText', bubbles: true })); key(ta, 'keyup', ch); });
		log(`keys: key '${ch}': ${fmt(r)}`); if (ch === 'f') { log('keys: layout per run [pack, native, apply, boxes] ' + JSON.stringify(ctx.layoutTiming.perRun.slice(-3)) + ' layoutMs ' + JSON.stringify(doc.__passStats.slice(-3).map(x => +x.layoutMs.toFixed(1)))); } if (ch === 'e') { log('keys: last pass ' + JSON.stringify(doc.__passStats.slice(-2).map(x => ({ total: x.total, mut: x.mutations, counts: x.counts, styleMs: x.styleMs, layoutMs: x.layoutMs, ms: x.ms, style: x.style })))); }
	}
	// drag-select: press at the start of the first line, move right in 8 px steps with the button down, release
	{ const lr2 = doc.querySelector('.view-line').getBoundingClientRect(); const y = lr2.top + lr2.height / 2; const x0 = lr2.left + 2;
		const mv = (x, name) => { const el = doc.elementFromPoint(x, y) || doc.body; el.dispatchEvent(new PointerEvent('pointermove', { ...base(x, y), pointerId: 1, pointerType: 'mouse', isPrimary: true })); el.dispatchEvent(new MouseEvent('mousemove', base(x, y))); };
		log('keys: drag press: ' + fmt(await drive(() => { const el = doc.elementFromPoint(x0, y); el.dispatchEvent(new PointerEvent('pointerdown', { ...base(x0, y), pointerId: 1, pointerType: 'mouse', isPrimary: true })); el.dispatchEvent(new MouseEvent('mousedown', base(x0, y))); })));
		const rs = []; for (let k = 1; k <= 8; k++) { rs.push(await drive(() => mv(x0 + k * 8))); } const tot = rs.map(r => r.event + r.frames + r.paint); log('keys: raster profile ' + JSON.stringify(globalThis.__lastRasterProfile)); log('keys: drag move detail ' + rs.slice(3).map(fmt).join(' | ')); log('keys: drag moves (ms each, busy): ' + JSON.stringify(tot.map(x => Math.round(x))) + ' passes ' + JSON.stringify(rs.map(r => r.passes)) + ' restyled ' + JSON.stringify(rs.map(r => r.restyled)));
		await drive(() => { const el = doc.elementFromPoint(x0 + 64, y); el.dispatchEvent(new PointerEvent('pointerup', { ...base(x0 + 64, y), buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true })); el.dispatchEvent(new MouseEvent('mouseup', { ...base(x0 + 64, y), buttons: 0 })); }); }
	// F1: the command palette
	{ const p0 = doc.__passStats.length; log('keys: F1: ' + fmt(await drive(() => { key(ta, 'keydown', 'F1'); key(ta, 'keyup', 'F1'); }))); log('keys: F1 passes [mutations, ins, rem, class, style, other, restyled, styleMs, layoutMs, elements]: ' + JSON.stringify(doc.__passStats.slice(p0).map(x => [x.mutations, x.counts.ins, x.counts.rem, x.counts['attr:class'], x.counts['attr:style'], x.counts['attr:other'], x.style && x.style.recomputed, Math.round(x.styleMs), Math.round(x.layoutMs), x.total]))); } await settle(5);
	{ let h = 2166136261; const px = backend.pixels; for (let i = 0; i < px.length; i += 7) { h = Math.imul(h ^ px[i], 16777619); } log('keys: frame checksum ' + (h >>> 0).toString(16)); }
	log('keys: palette rows ' + doc.querySelectorAll('.quick-input-list .monaco-list-row').length + ', active ' + (doc.activeElement && doc.activeElement.localName));
}
