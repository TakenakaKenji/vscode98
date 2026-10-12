// Minimal `os` for the spike (values are fixed or derived from the environment; real ones need host support, e.g. GetSystemInfo/GlobalMemoryStatus on Windows).
const WIN = () => process.platform === 'win32';
export const platform = () => process.platform; export const arch = () => process.arch || 'x64'; export const type = () => WIN() ? 'Windows_NT' : 'Linux'; export const release = () => WIN() ? '6.1.7601' : '6.0.0'; export const version = () => WIN() ? 'Windows 7 Professional' : '#1';
export const homedir = () => WIN() ? (process.env.USERPROFILE || 'C:\\Users\\user') : (process.env.HOME || '/root'); export const tmpdir = () => WIN() ? (process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp') : (process.env.TMPDIR || '/tmp'); export const hostname = () => 'qjs-host';
export const totalmem = () => 8 * 1024 ** 3; export const freemem = () => 4 * 1024 ** 3; export const loadavg = () => [0, 0, 0]; export const cpus = () => [{ model: 'qjs', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }];
export const availableParallelism = () => 1; export const networkInterfaces = () => ({}); export const userInfo = () => ({ username: 'user', uid: 0, gid: 0, shell: null, homedir: homedir() });
export const endianness = () => 'LE'; export const EOL = WIN() ? '\r\n' : '\n'; export const constants = { signals: {}, errno: {} };
export default { platform, arch, type, release, version, homedir, tmpdir, hostname, totalmem, freemem, loadavg, cpus, availableParallelism, networkInterfaces, userInfo, endianness, EOL, constants };
