// node run_utility_node.mjs <appRoot> <esmEntryPoint> : starts one utility entry exactly as the stub's utilityProcess.fork does and prints what it sends to "main"
import { fork } from 'node:child_process';
import path from 'node:path';
const [appRoot, entry] = [path.resolve(process.argv[2]), process.argv[3]];
const here = new URL('.', import.meta.url).pathname;
const child = fork(path.join(appRoot, 'out/bootstrap-fork.js'), [], { execArgv: ['--import', path.join(here, 'util_child_preload.mjs')], env: { ...process.env, VSCODE_ESM_ENTRYPOINT: entry, APP98_ROOT: appRoot, VSCODE_PARENT_PID: String(process.pid), UTIL_TRACE: '/tmp/claude-0/probe' }, serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
child.on('message', (m) => console.log('from child:', JSON.stringify(m)?.slice(0, 200)));
child.on('exit', (c) => { console.log('child exit', c); process.exit(0); });
setTimeout(() => { console.log('timeout; killing'); child.kill(); }, Number(process.argv[4] ?? 15000));
