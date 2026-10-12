// Minimal `os` for the spike (values are fixed or derived from the environment; real ones need host support, e.g. GetSystemInfo/GlobalMemoryStatus on Windows).
export const platform = () => process.platform; export const arch = () => 'x64'; export const type = () => 'Linux'; export const release = () => '6.0.0'; export const version = () => '#1';
export const homedir = () => process.env.HOME || '/root'; export const tmpdir = () => process.env.TMPDIR || '/tmp'; export const hostname = () => 'qjs-host';
export const totalmem = () => 8 * 1024 ** 3; export const freemem = () => 4 * 1024 ** 3; export const loadavg = () => [0, 0, 0]; export const cpus = () => [{ model: 'qjs', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }];
export const availableParallelism = () => 1; export const networkInterfaces = () => ({}); export const userInfo = () => ({ username: 'user', uid: 0, gid: 0, shell: null, homedir: homedir() });
export const endianness = () => 'LE'; export const EOL = '\n'; export const constants = { signals: {}, errno: {} };
export default { platform, arch, type, release, version, homedir, tmpdir, hostname, totalmem, freemem, loadavg, cpus, availableParallelism, networkInterfaces, userInfo, endianness, EOL, constants };
