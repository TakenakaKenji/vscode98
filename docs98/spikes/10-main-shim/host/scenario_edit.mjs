// Desktop scenario: with a folder open, click a file in the Explorer, type into the editor, save with Ctrl+S, and check the file on disk.
// Usage: boot_desktop_node.mjs ... --workspace <dir> --scenario scenario_edit.mjs   (--edit-file <abs path of the file clicked>)
import fs from 'node:fs';
import { runScenario } from '../../08-workbench-boot/host/boot_common.js';
const KEYS = { s: 83, Enter: 13 };
function key(target, type, k, mods = {}) { const ev = new KeyboardEvent(type, { key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k, keyCode: KEYS[k] ?? (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0), bubbles: true, cancelable: true, composed: true, ...mods }); ev.which = ev.keyCode; target.dispatchEvent(ev); return ev; }
const click = (el) => { for (const t of ['mousedown', 'mouseup', 'click']) { el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, button: 0, buttons: 1, detail: 1 })); } };
export async function run(ctx) {
	const { doc, log } = ctx; const file = ctx.opt('edit-file', '/tmp/claude-0/ws98/hello.txt'); const name = file.split('/').pop();
	const settle = (s = 20) => runScenario(ctx, { seconds: s, stableRounds: 40 });
	{ const x = doc.querySelector('.onboarding-a-close-btn'); if (x) { click(x); await settle(10); log('scenario: closed the onboarding dialog'); } }
	log('scenario: explorer rows = ' + JSON.stringify([...doc.querySelectorAll('.explorer-folders-view .monaco-list-row')].map(r => r.getAttribute('aria-label'))));
	const row = [...doc.querySelectorAll('.explorer-folders-view .monaco-list-row')].find(r => (r.getAttribute('aria-label') || '').startsWith(name));
	if (!row) { log('scenario: row for ' + name + ' not found'); return; }
	const t0 = performance.now(), p0 = doc.__passStats.length; click(row); await settle(); { const ps = doc.__passStats.slice(p0); log(`scenario: open file: ${ps.length} layout passes, style ${ps.reduce((a, x) => a + x.styleMs, 0).toFixed(0)} ms, layout ${ps.reduce((a, x) => a + x.layoutMs, 0).toFixed(0)} ms`); }
	const ed = doc.querySelector('.editor-instance .monaco-editor') || doc.querySelector('.monaco-editor');
	log(`scenario: clicked ${name}, ${(performance.now() - t0).toFixed(0)} ms, editor lines: ${JSON.stringify([...(ed || doc).querySelectorAll('.view-line')].map(l => l.textContent))}`);
	const ta0 = ed && ed.querySelector('textarea'); if (ta0) { ta0.focus(); await settle(5); }
	const ta = (doc.activeElement && doc.activeElement.localName === 'textarea') ? doc.activeElement : ed && ed.querySelector('textarea'); if (!ta) { log('scenario: no editor textarea'); return; }
	log('scenario: typing into ' + ta.className + ' (active=' + (doc.activeElement === ta) + ')');
	const text = ' EDITED'; for (const ch of text) { key(ta, 'keydown', ch); ta.value = (ta.value || '') + ch; ta.dispatchEvent(new InputEvent('input', { data: ch, inputType: 'insertText', bubbles: true })); key(ta, 'keyup', ch); const before = doc.__passStats.length, t1 = performance.now(); await settle(5); const ps = doc.__passStats.slice(before); log(`scenario: key '${ch}': ${ps.length} layout passes, style ${ps.reduce((a, x) => a + x.styleMs, 0).toFixed(0)} ms, layout ${ps.reduce((a, x) => a + x.layoutMs, 0).toFixed(0)} ms, wall ${(performance.now() - t1).toFixed(0)} ms`); }
	log(`scenario: editor lines after typing: ${JSON.stringify([...(ed || doc).querySelectorAll('.view-line')].map(l => l.textContent))}`);
	const before = fs.readFileSync(file, 'utf8'); key(ta, 'keydown', 's', { ctrlKey: true }); key(ta, 'keyup', 's', { ctrlKey: true }); await settle(20);
	const after = fs.readFileSync(file, 'utf8'); log(`scenario: file on disk ${before === after ? 'UNCHANGED' : 'CHANGED'}: ${JSON.stringify(after)}`);
}
