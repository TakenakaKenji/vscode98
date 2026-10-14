// Desktop scenario: open the File menu of the custom menu bar and dump the geometry/style of the menu's DOM.
import { runScenario } from '../../08-workbench-boot/host/boot_common.js';
export async function run(ctx) {
	const { doc, log, env } = ctx; const settle = (s = 20) => runScenario(ctx, { seconds: s, stableRounds: 40 });
	const MouseEvent = env.window.MouseEvent, PointerEvent = env.window.PointerEvent;
	const base = (x, y) => ({ clientX: x, clientY: y, screenX: x, screenY: y, bubbles: true, cancelable: true, composed: true, view: env.window, button: 0, buttons: 1, detail: 1 });
	await settle(15);
	const btn = doc.querySelector('.menubar-menu-button'); if (!btn) { log('menu: no menu button; menubar: ' + (doc.querySelector('.menubar') ? 'yes' : 'no')); return; }
	const r = btn.getBoundingClientRect(); log('menu: first button ' + btn.className + ' ' + JSON.stringify([r.left, r.top, r.width, r.height]));
	const x = r.left + 5, y = r.top + r.height / 2; const el = doc.elementFromPoint(x, y); log('menu: element under pointer ' + el.localName + '.' + el.className);
	const p0 = doc.__passStats.length, t0 = performance.now();
	el.dispatchEvent(new PointerEvent('pointerdown', { ...base(x, y), pointerId: 1, pointerType: 'mouse', isPrimary: true })); el.dispatchEvent(new MouseEvent('mousedown', base(x, y)));
	el.dispatchEvent(new PointerEvent('pointerup', { ...base(x, y), buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true })); el.dispatchEvent(new MouseEvent('mouseup', { ...base(x, y), buttons: 0 })); el.dispatchEvent(new MouseEvent('click', { ...base(x, y), buttons: 0 }));
	await settle(15); log('menu: opening took ' + Math.round(performance.now() - t0) + ' ms incl. settle, ' + (doc.__passStats.length - p0) + ' passes');
	{ const { paintDocument } = await import('../../06-rendering/host/dom/paint.js'); const { NativeBackend } = await import('../../07-native-render/host/native_backend.js'); const r = paintDocument(doc, ctx.W, ctx.H, new NativeBackend(ctx.W, ctx.H, {})); if (ctx.opt('ppm', '')) { const px = r.px; const out = new Uint8Array(ctx.W * ctx.H * 3); for (let i = 0, j = 0; i < px.length; i += 4) { out[j++] = px[i]; out[j++] = px[i + 1]; out[j++] = px[i + 2]; } const std = await import('qjs:std'); const f = std.open('/tmp/claude-0/menu.ppm', 'wb'); f.puts('P6\n' + ctx.W + ' ' + ctx.H + '\n255\n'); f.write(out.buffer, 0, out.length); f.close(); } }
	const mc = doc.querySelector('.monaco-menu-container'); log('menu: container ' + (mc ? mc.className + ' style=' + mc.getAttribute('style') : 'none'));
	const dump = (e, d) => { const rr = e.getBoundingClientRect(); const cs = env.window.getComputedStyle(e); log('menu: ' + ' '.repeat(d) + e.localName + '.' + String(e.className).slice(0, 50) + ' rect=' + JSON.stringify([Math.round(rr.left), Math.round(rr.top), Math.round(rr.width), Math.round(rr.height)]) + ' pos=' + cs.position + ' disp=' + cs.display + ' ov=' + cs.overflow + ' z=' + cs.zIndex + ' style=' + (e.getAttribute('style') || '')); if (d < 5) { for (const c of e.children) { dump(c, d + 1); } } };
	if (mc) { const chain = []; for (let e = mc; e && e !== doc.body; e = e.parentElement) { const cs = env.window.getComputedStyle(e); const rr = e.getBoundingClientRect(); chain.push(e.localName + '.' + String(e.className).slice(0, 40) + ' pos=' + cs.position + ' z=' + cs.zIndex + ' op=' + cs.opacity + ' tr=' + cs.transform + ' ov=' + cs.overflow + ' rect=' + [Math.round(rr.left), Math.round(rr.top), Math.round(rr.width), Math.round(rr.height)]); } log('menu: ancestors\n  ' + chain.join('\n  ')); const banner = doc.querySelector('.notifications-banner, .banner'); if (banner) { const cs = env.window.getComputedStyle(banner); log('menu: banner ' + banner.className + ' pos=' + cs.position + ' z=' + cs.zIndex); } }
	if (mc) { dump(mc, 0); } else { const any = [...doc.querySelectorAll('[class*=menu]')].slice(0, 12).map(e => e.localName + '.' + e.className); log('menu: elements with menu classes ' + JSON.stringify(any)); }
}
