// Measurement helper, not a feature check: opens <workspace>/<--open-file> (default restored.js, created when missing) in an editor and waits for the
// language features to settle, so that the NEXT start restores that editor. That is the laptop's v22 second start: a restored JavaScript file loads the
// TypeScript extension (hundreds of CommonJS modules) in the extension host during the launch.
import { createRig } from './scenario_lib.mjs';
import * as std from 'qjs:std';
export async function run(ctx) { try { await run0(ctx); } catch (e) { ctx.log('openfile: failed ' + (e && e.stack || e)); } }
async function run0(ctx) {
	const rig = await createRig(ctx); const { check } = rig; const ws = ctx.opt('workspace', '/tmp/claude-0/ws98'); const name = ctx.opt('open-file', 'restored.js');
	{ const x = rig.$('.onboarding-a-close-btn'); if (x) { await rig.clickEl(x); } }
	if (!std.open(ws + '/' + name, 'r')) { const f = std.open(ws + '/' + name, 'w'); f.puts('function greet(name) {\n\treturn "hello " + name;\n}\nconsole.log(greet("world"));\n'); f.close(); }
	const row = await rig.waitFor(() => rig.$$('.explorer-folders-view .monaco-list-row').find((r) => (r.getAttribute('aria-label') || '').startsWith(name)));
	check(`explorer lists ${name}`, !!row); if (!row) { rig.summary(); return; }
	await rig.clickEl(row, { rounds: 40 }); await rig.settle(30, 40);
	check('the editor shows it', !!(await rig.waitFor(() => rig.$('.editor-instance .view-line'))));
	await rig.settle(60, 120);   // the extension host activates the language features; the workbench saves the open editor for the next start
	rig.summary();
}
