// spike:win smoke test: opens a window, paints a gradient + a moving box through present(), logs every event. Exits after `--seconds` (default 6) or on close.
import * as std from 'qjs:std';
import * as os from 'qjs:os';
import * as win from 'spike:win';
const secs = Number(scriptArgs[scriptArgs.indexOf('--seconds') + 1]) || 6; const W = 480, H = 300;
const px = new Uint8Array(W * H * 4);
const draw = (t) => { for (let y = 0; y < H; y++) { for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; px[i] = x * 255 / W; px[i + 1] = y * 255 / H; px[i + 2] = 128; px[i + 3] = 255; } } const bx = 20 + (t * 40) % (W - 100); for (let y = 100; y < 160; y++) { for (let x = bx; x < bx + 80; x++) { const i = (y * W + x) * 4; px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; } } };
const id = win.create(W, H, 'vscode98 GDI test'); const log = (s) => { std.out.puts(s + '\n'); std.out.flush(); };
log('created window ' + id + ' size ' + JSON.stringify(win.size(id)) + ' screen ' + JSON.stringify(win.screenSize()));
win.setHandler((wid, type, a, b, c, d) => { if (type !== 'mousemove' && type !== 'paint') { log(`event ${type} ${a} ${b} ${c} ${d}`); } else if (type === 'mousemove' && !globalThis.__mm) { globalThis.__mm = 1; log(`event mousemove ${a} ${b}`); } if (type === 'close') { win.destroy(wid); std.exit(0); } if (type === 'mousedown') { win.setCursor(wid, 'pointer'); } });
let t = 0; const tick = () => { draw(t++); win.present(id, px, W, H, 0, 0, W, H); os.setTimeout(tick, 100); }; tick();
os.setTimeout(() => { log('done'); std.exit(0); }, secs * 1000);
