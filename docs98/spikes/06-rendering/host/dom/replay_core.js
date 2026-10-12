// Static replay of a captured page (see host/capture_workbench.mjs): rebuild the DOM from outerHTML, attach the captured CSS, restore scroll offsets, then the
// caller lays out / paints / dumps. Platform independent (Node and QuickJS).
import { parseFragment } from './dom.js';
export function replayPage(env, data) {
	const doc = env.document; const htmlTag = /^<html([^>]*)>/i.exec(data.html);
	if (htmlTag) { const re = /([^\s=]+)(?:="([^"]*)")?/g; let m; while ((m = re.exec(htmlTag[1]))) { doc.documentElement.setAttribute(m[1], (m[2] ?? '').replace(/&quot;/g, '"').replace(/&amp;/g, '&')); } }
	const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(data.html), body = /<body([^>]*)>([\s\S]*)<\/body>/i.exec(data.html);
	if (body) { const re = /([^\s=]+)(?:="([^"]*)")?/g; let m; while ((m = re.exec(body[1]))) { doc.body.setAttribute(m[1], (m[2] ?? '').replace(/&quot;/g, '"').replace(/&amp;/g, '&')); } }
	const mount = (el, markup) => { const f = parseFragment(doc, markup.replace(/<script([^>]*)>[\s\S]*?<\/script>/gi, '<script$1></script>'), el); for (const c of [...f.__children]) { el.appendChild(c); } };
	// stylesheets first (captured text), then the page's own <style>/<link> elements are dropped to avoid double application
	let headHtml = head ? head[1] : ''; headHtml = headHtml.replace(/<style([^>]*)>[\s\S]*?<\/style>/gi, '<style$1></style>').replace(/<link[^>]*>/gi, '<link>');
	mount(doc.head, headHtml); if (body) { let b = body[2].replace(/<style([^>]*)>[\s\S]*?<\/style>/gi, '<style$1></style>'); mount(doc.body, b); }
	for (const s of data.sheets) { if (!s.text) { continue; } const st = doc.createElement('style'); st.textContent = s.text; doc.head.appendChild(st); }
	return doc;
}
export function applyScrolls(doc, rows) {
	const byPath = new Map(rows.map(r => [r.path, r])); const walk = (el, path) => { const r = byPath.get(path); if (r) { if (r.st) { el.__scrollTop = r.st; } if (r.sl) { el.__scrollLeft = r.sl; } } let i = 0; for (const c of el.children) { walk(c, path + '/' + c.localName + '[' + (i++) + ']'); } }; walk(doc.documentElement, 'html');
}
export function dumpRows(root, rootPath) {
	const rows = []; const walk = (el, depth, p) => { const r = el.getBoundingClientRect(); rows.push({ path: p, tag: el.localName, cls: el.getAttribute('class') || '', x: r.x, y: r.y, w: r.width, h: r.height, depth, text: el.children.length === 0 ? (el.textContent || '').slice(0, 60) : undefined, inlineStyle: el.getAttribute('style') || '', offsetW: el.offsetWidth, offsetH: el.offsetHeight, scrollW: el.scrollWidth, scrollH: el.scrollHeight }); let i = 0; for (const c of el.children) { walk(c, depth + 1, p + '/' + c.localName + '[' + (i++) + ']'); } };
	walk(root, 0, rootPath); return rows;
}
