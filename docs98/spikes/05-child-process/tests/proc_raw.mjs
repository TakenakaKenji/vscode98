// Raw smoke test of spike:proc + qjs:os: spawn with pipes, async read via setReadHandler, exit code via waitpid, exec failure, fd 3 extra pipe.
import '../../02-node-shim/host/globals.js';
import * as os from 'qjs:os';
import * as p from 'spike:proc';
const [r, w] = p.pipe();
const [er, ew] = p.pipe();
const pid = p.spawn({ file: 'sh', args: ['sh', '-c', 'echo out; echo err >&2; echo three >&3; exit 7'], env: ['PATH=/usr/bin:/bin'], fds: [-1, w, ew, ew] });
console.log('pid', pid > 0);
os.close(w); os.close(ew);
const chunks = [];
const buf = new ArrayBuffer(4096);
function drain(fd, tag, done) { os.setReadHandler(fd, () => { const n = os.read(fd, buf, 0, 4096); if (n <= 0) { os.setReadHandler(fd, null); os.close(fd); done(); return; } chunks.push(tag + ':' + new TextDecoder().decode(new Uint8Array(buf, 0, n)).trim()); }); }
let open = 2; const fin = () => { if (--open === 0) { const [rp, st] = os.waitpid(pid, 0); console.log(chunks.sort().join(' | '), 'wait', rp === pid, st >> 8); console.log('enoent', p.errname(p.spawn({ file: 'no-such-prog', args: ['x'], fds: [-1, -1, -1] }))); console.log('badcwd', p.errname(p.spawn({ file: 'true', args: ['true'], cwd: '/nonexistent', fds: [-1, -1, -1] }))); } };
drain(r, 'o', fin); drain(er, 'e', fin);
