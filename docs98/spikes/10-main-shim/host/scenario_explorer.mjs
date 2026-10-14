// Feature scenario: explorer file operations through the UI: new file, new folder, rename, delete (all with typing into the inline input box).
import { createRig } from './scenario_lib.mjs';
import * as os from 'qjs:os';
export async function run(ctx) { try { await run0(ctx); } catch (e) { ctx.log('explorer: failed ' + (e && e.stack || e)); } }
const exists = (p) => { const [st, err] = os.stat(p); return err === 0 ? st : null; };
async function run0(ctx) {
	const rig = await createRig(ctx); const { check } = rig; const log = ctx.log; const ws = ctx.opt('workspace', '/tmp/claude-0/ws98');
	{ const x = rig.$('.onboarding-a-close-btn'); if (x) { await rig.clickEl(x); } }
	os.remove?.(ws + '/made.txt'); const toolbar = () => rig.$('.explorer-folders-view')?.closest('.pane')?.querySelector('.actions');
	const actionBtns = () => rig.$$('.pane-header .actions .action-item a, .explorer-viewlet .monaco-action-bar .action-label').map((a) => (a.getAttribute('aria-label') || a.title || '') + '|' + a.className.slice(0, 40));
	for (const sel of ['.pane-header .actions .action-item a', '.explorer-viewlet .monaco-action-bar .action-label', '.action-label']) { try { log('explorer: ' + sel + ' -> ' + rig.$$(sel).length); } catch (e) { log('explorer: selector failed ' + sel + ' ' + e.stack); } }
	for (const a of rig.$$('.action-label')) { const r = a.getBoundingClientRect(); log('explorer: label ' + (a.getAttribute('aria-label') || a.title || a.textContent.slice(0, 20)) + ' ' + JSON.stringify([Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]) + ' in ' + (a.closest('.pane-header') ? 'pane-header' : a.closest('.title-actions') ? 'title-actions' : a.parentElement.className.slice(0, 30))); }
	const newFile = rig.$$('.action-label').find((a) => /New File/i.test(a.getAttribute('aria-label') || ''));
	check('new file button found', !!newFile);
	{ const hdr = rig.$('.explorer-folders-view')?.closest('.pane')?.querySelector('.pane-header'); if (hdr) { const r = hdr.getBoundingClientRect(); await rig.hover(Math.round(r.left + 60), Math.round(r.top + r.height / 2)); } log('explorer: new file button rect ' + JSON.stringify(newFile && newFile.getBoundingClientRect())); }
	if (newFile) { await rig.clickEl(newFile); }
	const box = await rig.waitFor(() => rig.$('.explorer-item-edit-input input, .monaco-inputbox input.empty, .monaco-tl-contents .monaco-inputbox input'));
	check('inline input for the new file name appears', !!box, box ? rig.describe(box) : ''); rig.shot('explorer1');
	if (box) { check('input focused', rig.active === box, rig.describe(rig.active)); await rig.type('made.txt'); check('typed name', box.value === 'made.txt', JSON.stringify(box.value)); rig.shot('explorer2'); await rig.key('Enter', { rounds: 60 }); await rig.settle(30, 60); check('file created on disk', !!exists(ws + '/made.txt')); check('editor opened for it', rig.$$('.tab .label-name').some((t) => t.textContent === 'made.txt'), JSON.stringify(rig.$$('.tab .label-name').map((t) => t.textContent))); rig.shot('explorer3'); }
	// new folder
	{ os.remove?.(ws + '/madedir'); const hdr = rig.$('.explorer-folders-view')?.closest('.pane')?.querySelector('.pane-header'); const r = hdr.getBoundingClientRect(); await rig.hover(Math.round(r.left + 60), Math.round(r.top + r.height / 2));
	  const nf = rig.$$('.action-label').find((a) => /New Folder/i.test(a.getAttribute('aria-label') || '')); await rig.clickEl(nf); const b2 = await rig.waitFor(() => rig.$('.explorer-item-edit-input input, .monaco-tl-contents .monaco-inputbox input'));
	  check('new folder input appears', !!b2); if (b2) { await rig.type('madedir'); await rig.key('Enter', { rounds: 60 }); await rig.settle(30, 60); const st = exists(ws + '/madedir'); check('folder created on disk', !!st && (st.mode & 0o170000) === 0o040000); rig.shot('explorer4'); } }
	// rename with F2
	{ const row = rig.$$('.explorer-folders-view .monaco-list-row').find((r) => (r.getAttribute('aria-label') || '').startsWith('made.txt')); check('row for made.txt', !!row);
	  if (row) { await rig.clickEl(row); await rig.key('F2'); const b3 = await rig.waitFor(() => rig.$('.explorer-item-edit-input input, .monaco-tl-contents .monaco-inputbox input')); check('rename input appears', !!b3, b3 ? JSON.stringify(b3.value) : '');
	    if (b3) { await rig.key('a', { ctrl: true }); await rig.type('renamed.txt'); await rig.key('Enter', { rounds: 60 }); await rig.settle(30, 60); check('renamed on disk', !!exists(ws + '/renamed.txt') && !exists(ws + '/made.txt')); rig.shot('explorer5'); } } }
	// delete (Delete key: a confirmation dialog first)
	{ const row = rig.$$('.explorer-folders-view .monaco-list-row').find((r) => (r.getAttribute('aria-label') || '').startsWith('renamed.txt')); if (row) { await rig.clickEl(row); await rig.key('Delete', { rounds: 40 }); rig.shot('explorer6');
	    for (let i = 0; i < 3; i++) { const dlg = rig.$('.monaco-dialog-box'); if (!dlg) { break; } log('explorer: dialog: ' + dlg.textContent.slice(0, 100)); const btn = rig.$$('.monaco-dialog-box .dialog-buttons .monaco-button').find((b) => /Move to|Delete|OK|Yes/i.test(b.textContent)); if (!btn) { break; } await rig.clickEl(btn, { rounds: 40 }); } await rig.settle(10, 40); check('deleted on disk', !exists(ws + '/renamed.txt')); } }
	rig.summary();
}
