// Minimal Chrome DevTools Protocol page driver (WebSocket + JSON), so the control benchmark drives every Electron version the same way
// (Playwright refuses Chromium 100, the runtime of VS Code 1.70.2). Subset of Playwright's page API: evaluate, waitForFunction (raf or ms polling),
// setViewportSize, mouse.click/dblclick/move, keyboard.press/type, title, url.
export async function connectPage(port, match) {
	let target = null; const t0 = Date.now();
	while (!target) { try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); target = list.find((t) => t.type === 'page' && match(t)) || null; } catch { } if (!target) { if (Date.now() - t0 > 180000) { throw new Error('no page'); } await new Promise((r) => setTimeout(r, 100)); } }
	const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
	let id = 0; const pending = new Map();
	ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) { p.j(new Error(m.error.message)); } else { p.r(m.result); } } };
	const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; pending.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params })); });
	const evaluate = async (fn, arg) => { const res = await send('Runtime.evaluate', { expression: `(${fn})(${JSON.stringify(arg ?? null)})`, returnByValue: true, awaitPromise: true }); if (res.exceptionDetails) { throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text); } return res.result.value; };
	// a reload of the page during the wait (VS Code reloads the window at some starts) destroys the evaluation: wait again in the new page, within the same timeout
	const waitForFunction = async (fn, arg, opts = {}) => { const t0 = Date.now(), timeout = opts.timeout ?? 30000; for (;;) { try { return await waitOnce(fn, arg, { ...opts, timeout: Math.max(1, timeout - (Date.now() - t0)) }); } catch (e) { if (!/context was destroyed|Cannot find context/i.test(e.message) || Date.now() - t0 > timeout) { throw e; } await new Promise((r) => setTimeout(r, 100)); } } };
	const waitOnce = (fn, arg, { polling = 'raf', timeout = 30000 } = {}) => evaluate(`(a) => new Promise((res, rej) => { const f = ${fn}; const t0 = performance.now(); const step = () => { let ok = false; try { ok = f(a); } catch (e) { } if (ok) { res(true); return; } if (performance.now() - t0 > ${timeout}) { rej(new Error('timeout')); return; } ${polling === 'raf' ? 'requestAnimationFrame(step)' : `setTimeout(step, ${Number(polling) || 100})`}; }; step(); })`, arg);
	const mouseEv = (type, x, y, o = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: o.button || 'none', buttons: o.buttons ?? 0, clickCount: o.clickCount || 0 });
	const KEYS = { Escape: [27, 'Escape'], Enter: [13, 'Enter'], Backspace: [8, 'Backspace'], Tab: [9, 'Tab'] };
	const keyInfo = (k) => { if (KEYS[k]) { return { key: k, code: KEYS[k][1], vk: KEYS[k][0], text: k === 'Enter' ? '\r' : '' }; } const up = k.toUpperCase(); return { key: k, code: /^[a-z]$/i.test(k) ? 'Key' + up : k, vk: up.charCodeAt(0), text: k }; };
	const press = async (combo) => { const parts = combo.split('+'); const k = parts.pop(); const mods = (parts.includes('Alt') ? 1 : 0) | (parts.includes('Control') ? 2 : 0) | (parts.includes('Meta') ? 4 : 0) | (parts.includes('Shift') ? 8 : 0); const i = keyInfo(k);
		const text = mods & 2 ? '' : i.text;
		await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', modifiers: mods, key: i.key, code: i.code, windowsVirtualKeyCode: i.vk, nativeVirtualKeyCode: i.vk, text: text || undefined, unmodifiedText: text || undefined });
		await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: mods, key: i.key, code: i.code, windowsVirtualKeyCode: i.vk, nativeVirtualKeyCode: i.vk }); };
	return {
		target, send, evaluate, waitForFunction,
		title: async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.id === target.id)?.title ?? '', url: () => target.url,
		setViewportSize: ({ width, height }) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }),
		mouse: {
			move: (x, y) => mouseEv('mouseMoved', x, y),
			click: async (x, y, o = {}) => { const button = o.button || 'left'; const buttons = button === 'right' ? 2 : 1; await mouseEv('mouseMoved', x, y); await mouseEv('mousePressed', x, y, { button, buttons, clickCount: 1 }); await mouseEv('mouseReleased', x, y, { button, clickCount: 1 }); },
			dblclick: async (x, y) => { await mouseEv('mouseMoved', x, y); for (const c of [1, 2]) { await mouseEv('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: c }); await mouseEv('mouseReleased', x, y, { button: 'left', clickCount: c }); } },
		},
		keyboard: { press, type: (s) => send('Input.insertText', { text: s }) },   // type: one text insertion (names); press: a real key, for key latency
		close: () => ws.close(),
	};
}
