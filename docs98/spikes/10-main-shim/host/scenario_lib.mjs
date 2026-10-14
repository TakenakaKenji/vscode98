// A rig for feature scenarios: drives the booted workbench the way a user does (through the same input driver as the native window), waits for it to settle,
// reads the DOM, and writes screenshots. Use from a scenario module:  const rig = await createRig(ctx);  await rig.key('p', { ctrl: true, shift: true });  await rig.type('hello');
import { runScenario } from '../../08-workbench-boot/host/boot_common.js';
import { paintDocument, toPPM } from '../../06-rendering/host/dom/paint.js';
import { NativeBackend } from '../../07-native-render/host/native_backend.js';
import { createInputDriver } from '../../06-rendering/host/dom/input_driver.js';
import * as std from 'qjs:std';

const NAMED = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, ' ': 32, Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46 };
for (let i = 1; i <= 12; i++) { NAMED['F' + i] = 111 + i; }
const OEM_VK = { ';': [186, 0], ':': [186, 1], '=': [187, 0], '+': [187, 1], ',': [188, 0], '<': [188, 1], '-': [189, 0], '_': [189, 1], '.': [190, 0], '>': [190, 1], '/': [191, 0], '?': [191, 1], '`': [192, 0], '~': [192, 1], '[': [219, 0], '{': [219, 1], '\\': [220, 0], '|': [220, 1], ']': [221, 0], '}': [221, 1], "'": [222, 0], '"': [222, 1] };
const SHIFTED = ')!@#$%^&*(';
export const MOD = { shift: 1, ctrl: 2, alt: 4, meta: 8 };

/** [virtual-key code, needs shift] of one typed character */
function vkOf(ch) {
	if (/[a-z]/.test(ch)) { return [ch.toUpperCase().charCodeAt(0), 0]; } if (/[A-Z]/.test(ch)) { return [ch.charCodeAt(0), 1]; } if (/[0-9]/.test(ch)) { return [ch.charCodeAt(0), 0]; }
	const si = SHIFTED.indexOf(ch); if (si >= 0) { return [48 + si, 1]; } if (ch === ' ') { return [32, 0]; } return OEM_VK[ch] || [0, 0];
}

export async function createRig(ctx, { settleRounds = 12 } = {}) {
	const { doc, log, env } = ctx; const W = ctx.W, H = ctx.H; const backend = new NativeBackend(W, H, {});
	globalThis.__tcLog = ctx.log; globalThis.__clipboard98 = { text: '', readText() { return this.text; }, writeText(t) { this.text = String(t); } };   // the system clipboard of the window host
	const driver = createInputDriver(ctx, {}); let shots = 0; const failures = [];
	const settle = (s = 20, rounds = settleRounds) => runScenario(ctx, { seconds: s, stableRounds: rounds });
	const rig = {
		doc, env, ctx, failures, settle, driver,
		/** one input message, then settle */
		async send(type, a = 0, b = 0, c = 0, d = 0, mods = 0, rounds) { driver.handle(type, a, b, c, d, mods); await settle(20, rounds); },
		/** a key chord: key('z', { ctrl: true }), key('ArrowLeft', { shift: true }), key('F1') */
		async key(name, { ctrl = false, shift = false, alt = false, rounds } = {}) {
			let vk = NAMED[name]; let needShift = 0; if (vk === undefined) { [vk, needShift] = vkOf(name); } let mods = (ctrl ? 2 : 0) | (shift || needShift ? 1 : 0) | (alt ? 4 : 0);
			if (ctrl) { driver.handle('keydown', 17, 0, 0, 0, 2); } if (shift) { driver.handle('keydown', 16, 0, 0, 0, mods); } if (alt) { driver.handle('keydown', 18, 0, 0, 0, mods); }
			driver.handle('keydown', vk, 0, 0, 0, mods);
			if (!ctrl && !alt && name.length === 1) { driver.handle('char', name.codePointAt(0), 0, 0, 0, mods); } else if (name === 'Enter' && !ctrl && !alt) { driver.handle('char', 13, 0, 0, 0, mods); }
			driver.handle('keyup', vk, 0, 0, 0, mods); if (alt) { driver.handle('keyup', 18, 0, 0, 0, mods & ~4); } if (shift) { driver.handle('keyup', 16, 0, 0, 0, mods & ~1); } if (ctrl) { driver.handle('keyup', 17, 0, 0, 0, 0); }
			await settle(20, rounds);
		},
		/** types text character by character (one settle at the end) */
		async type(text, { rounds } = {}) {
			for (const ch of text) { if (ch === '\n') { await rig.key('Enter', { rounds: 2 }); continue; } const [vk, sh] = vkOf(ch); const mods = sh ? 1 : 0; driver.handle('keydown', vk, 0, 0, 0, mods); driver.handle('char', ch.codePointAt(0), 0, 0, 0, mods); driver.handle('keyup', vk, 0, 0, 0, mods); await settle(5, 2); }
			await settle(20, rounds);
		},
		async click(x, y, { detail = 1, button = 0, shift = false, ctrl = false, rounds } = {}) {
			const mods = (shift ? 1 : 0) | (ctrl ? 2 : 0); driver.handle('mousemove', x, y, 0, 0, mods); await settle(5, 2);
			if (detail === 2) { driver.handle('dblclick', x, y, button, 1, mods); } else { driver.handle('mousedown', x, y, button, 1, mods); driver.handle('mouseup', x, y, button, 0, mods); }
			await settle(20, rounds);
		},
		/** clicks the center of an element (or the point at fractions fx, fy of it) */
		async clickEl(el, opts = {}) { const r = el.getBoundingClientRect(); return rig.click(Math.round(r.left + r.width * (opts.fx ?? 0.5)), Math.round(r.top + r.height * (opts.fy ?? 0.5)), opts); },
		async hover(x, y) { driver.handle('mousemove', x, y, 0, 0, 0); await settle(10, 4); },
		async drag(x0, y0, x1, y1, steps = 6) {
			driver.handle('mousemove', x0, y0, 0, 0, 0); driver.handle('mousedown', x0, y0, 0, 1, 0);
			for (let i = 1; i <= steps; i++) { driver.handle('mousemove', Math.round(x0 + (x1 - x0) * i / steps), Math.round(y0 + (y1 - y0) * i / steps), 1, 1, 0); await settle(2, 1); }
			driver.handle('mouseup', x1, y1, 0, 0, 0); await settle(20);
		},
		async wheel(x, y, delta) { driver.handle('wheel', x, y, delta, 0, 0); await settle(20); },
		$: (sel) => doc.querySelector(sel), $$: (sel) => [...doc.querySelectorAll(sel)],
		/** visible text of the first element matching, or '' */
		text: (sel) => { const e = doc.querySelector(sel); return e ? e.textContent : ''; },
		get active() { return doc.activeElement; },
		describe(e) { return e ? e.localName + (e.id ? '#' + e.id : '') + '.' + String(e.className).trim().split(/\s+/).slice(0, 3).join('.') : 'null'; },
		/** waits until fn() is truthy (settling in between); returns its value or null */
		async waitFor(fn, seconds = 15) { const end = performance.now() + seconds * 1000; for (;;) { let v = null; try { v = fn(); } catch { v = null; } if (v) { return v; } if (performance.now() > end) { return null; } await settle(2, 6); } },
		/** records a check: prints PASS/FAIL and remembers failures */
		check(name, ok, detail = '') { log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`); if (!ok) { failures.push(name); } return ok; },
		shot(name) { doc.__ensureLayout(); backend.reset(); const r = paintDocument(doc, W, H, backend); const dir = ctx.opt('shot-dir', '/tmp/claude-0/shots'); const f = std.open(`${dir}/${name}.ppm`, 'wb'); if (!f) { log(`shot: cannot write ${dir}/${name}.ppm`); return; } const ppm = toPPM(r.px, W, H); f.write(ppm.buffer, 0, ppm.length); f.close(); shots++; },
		summary() { log(`SUMMARY ${failures.length ? failures.length + ' FAILED: ' + failures.join('; ') : 'all passed'}`); },
	};
	await settle(40, 40); return rig;
}
