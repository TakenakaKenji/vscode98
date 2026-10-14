// Loads an HTML page into the environment: parses head/body, applies <link rel=stylesheet> and <style>, and runs <script> in order (src or inline).
// Platform hooks come from the caller: readText(path) and evalScript(text, name).
import { parseFragment } from './dom.js';
export function loadPage(doc, html, baseDir, { readText, evalScript, join }) {
	html = html.replace(/<!doctype[^>]*>/i, '');
	const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html), body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
	const scripts = []; doc.__scanScripts = () => { };   // this loader runs the page's scripts itself, in order: no running on insertion
	const mount = (el, markup) => { const frag = parseFragment(doc, markup, el); for (const c of [...frag.__children]) { el.appendChild(c); } };
	if (head) { mount(doc.head, head[1]); } if (body) { mount(doc.body, body[1]); }
	const walk = (n) => { for (const c of n.__children) { if (c.nodeType !== 1) { continue; } if (c.localName === 'link' && (c.getAttribute('rel') || '').toLowerCase() === 'stylesheet') { c.__linkText = readText(join(baseDir, c.getAttribute('href'))); } if (c.localName === 'script') { scripts.push(c); } walk(c); } };
	walk(doc.documentElement);
	for (const s of scripts) { s.__ran = true; }
	delete doc.__scanScripts;
	for (const s of scripts) { const src = s.getAttribute('src'); evalScript(src ? readText(join(baseDir, src)) : s.textContent, src || 'inline'); }
}
