// Drives the REAL tsserver exactly as VS Code's typescript-language-features does (child_process.fork, stdio ['pipe','pipe','pipe','ipc'], --useNodeIpc),
// over the IPC channel, on a small TypeScript project. Same script runs under Node and under qjs-spike5; prints one JSON result line.
//   TSSERVER=.../tsserver.js PROJECT=<dir with .ts files> node ts_parent.cjs   |   qjs-spike5 fork_main.mjs <shims> ts_parent.cjs
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const tsserver = process.env.TSSERVER, project = process.env.PROJECT;
const files = fs.readdirSync(project).filter(f => f.endsWith('.ts')).sort().map(f => path.join(project, f));
const target = path.join(project, process.env.TARGET || 'strings.ts');
const t0 = Date.now(); const timings = {}; const mark = (k) => { timings[k] = Date.now() - t0; };
const child = cp.fork(tsserver, ['--useInferredProjectPerProjectRoot', '--disableAutomaticTypingAcquisition', '--locale', 'en', '--noGetErrOnBackgroundUpdate', '--useNodeIpc'], { silent: true, execArgv: ['--max-old-space-size=3072'], stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: { ...process.env, TSS_LOG: undefined } });
let seq = 0, errText = ''; const waiters = new Map(), events = [];
child.stderr.on('data', d => errText += d);
child.on('message', (m) => { if (m.type === 'response') { const w = waiters.get(m.request_seq); if (w) { waiters.delete(m.request_seq); w(m); } } else if (m.type === 'event') { events.push(m.event); } });
const request = (command, args) => new Promise(res => { const s = ++seq; waiters.set(s, res); child.send({ seq: s, type: 'request', command, arguments: args }); });
const result = { runtime: typeof process.versions.quickjs === 'string' ? 'quickjs' : 'node', files: files.length };
child.on('exit', (c, sig) => { if (!result.done) { console.log(JSON.stringify({ ...result, error: 'tsserver exited early', code: c, signal: sig, stderr: errText.slice(0, 500) })); } });
(async () => {
	mark('forked');
	let r = await request('configure', { hostInfo: 'vscode98-spike', preferences: { includePackageJsonAutoImports: 'off' } }); mark('configure'); result.configureOk = r.success;
	r = await request('compilerOptionsForInferredProjects', { options: { module: 'esnext', target: 'es2022', allowJs: true, moduleResolution: 'bundler', strict: true } }); mark('compilerOptions');
	for (const f of files.slice(0, 40)) { await request('open', { file: f, projectRootPath: project }); }
	mark('open40');
	r = await request('semanticDiagnosticsSync', { file: target }); mark('semanticDiagnosticsSync'); result.semanticDiagnostics = (r.body || []).length;
	r = await request('syntacticDiagnosticsSync', { file: target }); mark('syntactic'); result.syntacticDiagnostics = (r.body || []).length;
	const text = fs.readFileSync(target, 'utf8'); const idx = text.indexOf('export function ') + 'export function '.length; const before = text.slice(0, idx).split('\n');
	r = await request('quickinfo', { file: target, line: before.length, offset: before[before.length - 1].length + 1 }); mark('quickinfo'); result.quickinfo = r.body && String(r.body.displayString).slice(0, 80);
	const line = text.split('\n').findIndex(l => l.includes('const ')) + 1;
	r = await request('completionInfo', { file: target, line, offset: 1, includeExternalModuleExports: false, triggerKind: 1 }); mark('completionInfo'); result.completionCount = r.body && r.body.entries && r.body.entries.length;
	r = await request('navtree', { file: target }); mark('navtree'); result.navtreeChildren = r.body && r.body.childItems && r.body.childItems.length;
	r = await request('references', { file: target, line: before.length, offset: before[before.length - 1].length + 1 }); mark('references'); result.references = r.body && r.body.refs && r.body.refs.length;
	result.events = [...new Set(events)].sort(); result.timingsMs = timings; result.done = true;
	console.log(JSON.stringify(result));
	child.send({ seq: ++seq, type: 'request', command: 'exit' });
	setTimeout(() => { child.kill(); process.exit(0); }, 1500);
})().catch(e => { console.log('FAILED ' + (e && e.stack || e)); child.kill(); process.exit(1); });
