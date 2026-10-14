import { createRig } from './scenario_lib.mjs';
export async function run(ctx) { try { const rig = await createRig(ctx); const { log } = ctx; const w = ctx.env.window;
	const R = (e) => { const r = e.getBoundingClientRect(); return JSON.stringify([Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]); };
	const D = (e) => { const cs = w.getComputedStyle(e); return e.localName + '.' + String(e.className).slice(0, 40) + ' ' + R(e) + ' disp=' + cs.display + ' pos=' + cs.position + ' z=' + cs.zIndex; };
	const dr = rig.$('.titlebar-drag-region'); log('dbg6: drag ' + D(dr)); log('dbg6: drag parent ' + D(dr.parentElement));
	const btn = rig.$('.menubar-menu-button'); for (let e = btn; e && e !== ctx.doc.body; e = e.parentElement) { log('dbg6: chain ' + D(e)); if (e.classList.contains('titlebar-container')) { break; } }
} catch (e) { ctx.log('dbg failed ' + (e && e.stack || e)); } }
