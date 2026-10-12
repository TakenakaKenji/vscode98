// Prints the numeric RPC proxy ids (nid) VS Code assigns to MainContext.* / ExtHostContext.* so a fake renderer can decode and address RPC messages.
// Usage (repo root, after `npm run transpile-client`):  node docs98/spikes/03-extension-loading/dump_proxy_ids.mjs > proxy-ids.json
const m = await import(process.cwd() + '/out/vs/workbench/api/common/extHost.protocol.js');
const out = { main: {}, extHost: {} };
for (const [k, v] of Object.entries(m.MainContext)) { out.main[k] = v.nid; }
for (const [k, v] of Object.entries(m.ExtHostContext)) { out.extHost[k] = v.nid; }
console.log(JSON.stringify(out));
