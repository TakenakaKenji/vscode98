// Minimal `url`: file URL conversion plus the WHATWG classes from globals.
import { fromFileUrl, toFileUrl } from './path.js';
export function fileURLToPath(u) { const s = typeof u === 'string' ? u : u.href; if (!s.startsWith('file:')) { throw new TypeError('The URL must be of scheme file'); } return fromFileUrl(s); }
export function pathToFileURL(p) { return new URL(toFileUrl(p)); }
export function format(u) { return typeof u === 'string' ? u : (u.href ?? String(u)); }
export function parse(s) { try { const u = new URL(s); return { protocol: u.protocol, host: u.host, hostname: u.hostname, port: u.port || null, pathname: u.pathname, search: u.search, query: u.search.slice(1), hash: u.hash, href: u.href, path: u.pathname + u.search, auth: null }; } catch { return { href: s, pathname: s, path: s }; } }
export const URL = globalThis.URL, URLSearchParams = globalThis.URLSearchParams;
export default { fileURLToPath, pathToFileURL, format, parse, URL, URLSearchParams };
