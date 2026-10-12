// No-op stand-in for @vscode/proxy-agent (HTTP(S)/WebSocket proxy resolution and certificate loading). Real HTTP support is a separate piece of work.
export const LogLevel = { Trace: 0, Debug: 1, Info: 2, Warning: 3, Error: 4, Critical: 5, Off: 6 };
export const ProxySupportSetting = { Off: 'off', On: 'on', Fallback: 'fallback', Override: 'override' };
const none = async () => undefined;
export function createProxyResolver() { return { resolveProxyWithRequest: none, resolveProxyURL: none, resolveProxyByURL: none }; }
export function createProxyAuthorizationLookup() { return none; }
export function createHttpPatch(_params, originals) { return originals; }
export function createNetPatch(_params, original) { return original; }
export function createTlsPatch(_params, original) { return original; }
export function createFetchPatch(_params, originalFetch) { return originalFetch ?? (() => Promise.reject(new Error('fetch is not available in this host'))); }
export function createWebSocketPatch() { return undefined; }
export function patchUndici() { }
export async function loadSystemCertificates() { return []; }
export default { LogLevel, ProxySupportSetting, createProxyResolver, createProxyAuthorizationLookup, createHttpPatch, createNetPatch, createTlsPatch, createFetchPatch, createWebSocketPatch, patchUndici, loadSystemCertificates };
