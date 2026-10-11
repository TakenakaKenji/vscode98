// Small CDP helpers (keyboard/mouse input, waiting) for driver scripts. trace_scenarios.mjs keeps its own copy.
import { setTimeout as sleep } from 'node:timers/promises';
const NAMED = { enter: ['Enter', 'Enter', 13], escape: ['Escape', 'Escape', 27], f1: ['F1', 'F1', 112], down: ['ArrowDown', 'ArrowDown', 40], up: ['ArrowUp', 'ArrowUp', 38], end: ['End', 'End', 35], home: ['Home', 'Home', 36], '`': ['`', 'Backquote', 192] };
const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const PUNCT = { '.': ['Period', 190, 0], ',': ['Comma', 188, 0], '-': ['Minus', 189, 0], '/': ['Slash', 191, 0], ' ': ['Space', 32, 0], ':': ['Semicolon', 186, 8] };
export function makeInput(client) {
	const { Input, Runtime } = client;
	const ev = async (expression) => { const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) { throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); } return r.result.value; };
	const waitFor = async (expr, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(expr)) { return true; } } catch { /* not ready */ } await sleep(300); } return false; };
	async function press(combo, times = 1, gap = 40) {
		const parts = combo.toLowerCase().split('+'); const k = parts.pop(); let modifiers = 0; for (const p of parts) { modifiers |= MOD[p]; }
		const n = NAMED[k] ?? [(modifiers & 8) ? k.toUpperCase() : k, 'Key' + k.toUpperCase(), k.toUpperCase().charCodeAt(0)];
		for (let i = 0; i < times; i++) {
			await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: n[0], code: n[1], windowsVirtualKeyCode: n[2], nativeVirtualKeyCode: n[2], modifiers });
			await Input.dispatchKeyEvent({ type: 'keyUp', key: n[0], code: n[1], windowsVirtualKeyCode: n[2], nativeVirtualKeyCode: n[2], modifiers });
			await sleep(gap);
		}
	}
	async function typeText(text, gap = 8) {
		for (const ch of text) {
			const pu = PUNCT[ch]; const up = ch.toUpperCase();
			const code = pu ? pu[0] : /[a-z]/i.test(ch) ? 'Key' + up : /[0-9]/.test(ch) ? 'Digit' + ch : ''; const vk = pu ? pu[1] : up.charCodeAt(0); const modifiers = pu ? pu[2] : (ch !== ch.toLowerCase() ? 8 : 0);
			await Input.dispatchKeyEvent({ type: 'keyDown', key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, text: ch, unmodifiedText: ch });
			await Input.dispatchKeyEvent({ type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
			await sleep(gap);
		}
	}
	async function click(x, y) { await Input.dispatchMouseEvent({ type: 'mouseMoved', x, y }); await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }); }
	return { sleep, ev, waitFor, press, typeText, click };
}
