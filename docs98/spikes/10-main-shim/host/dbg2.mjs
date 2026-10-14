import { createRig } from './scenario_lib.mjs';
export async function run(ctx) { try { const rig = await createRig(ctx); const { log } = ctx; const w = ctx.env.window;
	const a = rig.$$('.statusbar-item a')[1]; log('dbg: a=' + a.outerHTML.slice(0, 200));
	for (let e = a; e && e !== ctx.doc.body; e = e.parentElement) { const cs = w.getComputedStyle(e); log('dbg: ' + e.localName + '.' + String(e.className).slice(0, 40) + ' color=' + cs.color + ' ' + (e.__cs && e.__cs.vars ? '' : '')); }
	const root = ctx.doc.querySelector('.monaco-workbench'); log('dbg: statusBar fg var=' + (root.__cs.vars.get('--vscode-statusBar-foreground')) + ' link=' + root.__cs.vars.get('--vscode-textLink-foreground'));
} catch (e) { ctx.log('dbg failed ' + (e && e.stack || e)); } }
