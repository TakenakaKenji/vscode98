// CSS selector parser and matcher (Selectors Level 4 subset): type, universal, #id, .class, [attr op value i], combinators (descendant, >, +, ~), and the pseudo-classes
// VS Code's CSS uses (structural, :not/:is/:where/:has, state flags, :root, :empty). Pseudo-elements are parsed (so the cascade can route them) but matched against their host element.
const cache = new Map();
export function parseSelector(text) {
	let r = cache.get(text); if (r) { return r; }
	r = parseList(new Lexer(text)); if (cache.size > 20000) { cache.clear(); } cache.set(text, r); return r;
}
class Lexer { constructor(s) { this.s = s; this.i = 0; } peek() { return this.s[this.i]; } eof() { return this.i >= this.s.length; } }
const isIdent = (c) => c !== undefined && /[\w\-\u0080-￿\\]/.test(c);
function ident(L) { let o = ''; while (!L.eof()) { const c = L.peek(); if (c === '\\') { L.i++; if (/[0-9a-f]/i.test(L.peek())) { let h = ''; while (h.length < 6 && /[0-9a-f]/i.test(L.peek() ?? '')) { h += L.s[L.i++]; } if (L.peek() === ' ') { L.i++; } o += String.fromCodePoint(parseInt(h, 16)); } else { o += L.s[L.i++]; } } else if (isIdent(c)) { o += c; L.i++; } else { break; } } return o; }
function ws(L) { let n = 0; while (!L.eof() && /\s/.test(L.peek())) { L.i++; n++; } return n; }
function parseList(L, forgiving) {
	const list = []; ws(L);
	for (;;) { list.push(parseComplex(L)); ws(L); if (L.peek() === ',') { L.i++; ws(L); continue; } break; }
	return list;
}
function parseComplex(L) {
	const parts = []; let comb = ' ';   // each part: { comb, compound }
	for (;;) {
		const compound = parseCompound(L); parts.push({ comb, compound });
		const had = ws(L); const c = L.peek();
		if (c === '>' || c === '+' || c === '~') { comb = c; L.i++; ws(L); continue; }
		if (c === undefined || c === ',' || c === ')') { break; }
		if (had) { comb = ' '; continue; }
		break;
	}
	let spec = [0, 0, 0]; for (const p of parts) { addSpec(spec, p.compound.spec); }
	return { parts, spec };
}
function addSpec(a, b) { a[0] += b[0]; a[1] += b[1]; a[2] += b[2]; }
function parseCompound(L) {
	const c = { tag: null, id: null, classes: [], attrs: [], pseudos: [], pseudoElement: null, spec: [0, 0, 0] };
	let any = false;
	if (L.peek() === '*') { L.i++; any = true; if (L.peek() === '|') { L.i++; } }
	else if (isIdent(L.peek()) && L.peek() !== undefined) { c.tag = ident(L).toLowerCase(); any = true; c.spec[2]++; }
	for (;;) {
		const ch = L.peek();
		if (ch === '#') { L.i++; c.id = ident(L); c.spec[0]++; any = true; }
		else if (ch === '.') { L.i++; c.classes.push(ident(L)); c.spec[1]++; any = true; }
		else if (ch === '[') { L.i++; ws(L); const name = ident(L).toLowerCase(); ws(L); let op = null, value = '', flag = ''; if (L.peek() !== ']') { op = ''; while ('~|^$*='.includes(L.peek())) { op += L.s[L.i++]; } ws(L); if (L.peek() === '"' || L.peek() === "'") { const q = L.s[L.i++]; while (L.peek() !== q) { value += L.s[L.i++]; } L.i++; } else { value = ident(L); } ws(L); if (/[iIsS]/.test(L.peek())) { flag = L.s[L.i++].toLowerCase(); ws(L); } } L.i++; c.attrs.push({ name, op, value, flag }); c.spec[1]++; any = true; }
		else if (ch === ':') {
			L.i++; let pe = false; if (L.peek() === ':') { L.i++; pe = true; }
			const name = ident(L).toLowerCase(); let arg = null;
			if (L.peek() === '(') {
				L.i++; ws(L);
				if (['not', 'is', 'where', 'matches', 'has', '-webkit-any', 'any'].includes(name)) { arg = parseList(L); }
				else if (name.startsWith('nth-')) { arg = parseNth(L); }
				else { let depth = 1, s = ''; while (!L.eof() && depth) { const x = L.s[L.i++]; if (x === '(') { depth++; } else if (x === ')') { depth--; if (!depth) { break; } } s += x; } arg = s.trim(); L.i--; }
				ws(L); if (L.peek() === ')') { L.i++; }
			}
			if (pe || ['before', 'after', 'first-line', 'first-letter', 'selection', 'placeholder', 'marker', 'backdrop', '-webkit-scrollbar', '-webkit-scrollbar-thumb', '-webkit-scrollbar-track', '-webkit-scrollbar-corner', '-webkit-input-placeholder', '-moz-placeholder', 'cue', 'file-selector-button', '-webkit-file-upload-button', 'part', 'slotted', 'highlight'].includes(name)) { c.pseudoElement = name; c.spec[2]++; }
			else {
				c.pseudos.push({ name, arg });
				if (name === 'where') { /* zero */ } else if (name === 'not' || name === 'is' || name === 'matches' || name === 'has' || name === '-webkit-any' || name === 'any') { let best = [0, 0, 0]; for (const s of arg) { if (cmpSpec(s.spec, best) > 0) { best = s.spec; } } addSpec(c.spec, best); } else if (name.startsWith('nth-')) { c.spec[1]++; if (arg && arg.of) { addSpec(c.spec, arg.of[0].spec); } } else { c.spec[1]++; }
			}
			any = true;
		} else { break; }
	}
	if (!any) { throw new SyntaxError(`'${L.s}' is not a valid selector (at ${L.i})`); }
	return c;
}
export function cmpSpec(a, b) { return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; }
function parseNth(L) {
	let s = ''; let depth = 0; while (!L.eof()) { const c = L.peek(); if (c === ')' && depth === 0) { break; } if (c === '(') { depth++; } if (c === ')') { depth--; } s += c; L.i++; }
	let of = null; const m = /^(.*?)\s+of\s+(.+)$/i.exec(s); if (m) { s = m[1]; of = parseSelector(m[2]); }
	s = s.trim().toLowerCase().replace(/\s+/g, '');
	let a = 0, b = 0; if (s === 'odd') { a = 2; b = 1; } else if (s === 'even') { a = 2; b = 0; } else { const k = /^([+-]?\d*)n([+-]\d+)?$/.exec(s); if (k) { a = k[1] === '' || k[1] === '+' ? 1 : k[1] === '-' ? -1 : parseInt(k[1], 10); b = k[2] ? parseInt(k[2], 10) : 0; } else { a = 0; b = parseInt(s, 10); } }
	return { a, b, of };
}
function nthMatches(n, { a, b }) { if (a === 0) { return n === b; } const k = (n - b) / a; return Number.isInteger(k) && k >= 0; }

// ---- matching -------------------------------------------------------------------------------------------------------------------------------
export function matches(el, list, ctx) { for (const s of list) { if (matchComplex(el, s, s.parts.length - 1, ctx)) { return true; } } return false; }
export function matchesComplex(el, complex, ctx) { return matchComplex(el, complex, complex.parts.length - 1, ctx); }
export function closestMatch(el, list) { for (let n = el; n && n.nodeType === 1; n = n.parentNode) { if (matches(n, list)) { return n; } } return null; }
function matchComplex(el, s, i, ctx) {
	const part = s.parts[i]; if (!matchCompound(el, part.compound, ctx)) { return false; } if (i === 0) { return true; }
	const comb = part.comb;
	if (comb === '>') { const p = el.parentNode; return !!p && p.nodeType === 1 && matchComplex(p, s, i - 1, ctx); }
	if (comb === ' ') { for (let p = el.parentNode; p && p.nodeType === 1; p = p.parentNode) { if (matchComplex(p, s, i - 1, ctx)) { return true; } } return false; }
	if (comb === '+') { let p = el.previousSibling; while (p && p.nodeType !== 1) { p = p.previousSibling; } return !!p && matchComplex(p, s, i - 1, ctx); }
	for (let p = el.previousSibling; p; p = p.previousSibling) { if (p.nodeType === 1 && matchComplex(p, s, i - 1, ctx)) { return true; } } return false;
}
function elementSiblings(el) { const p = el.parentNode; return p ? p.__children.filter(c => c.nodeType === 1) : [el]; }
function matchCompound(el, c, ctx) {
	if (c.tag && el.localName !== c.tag && el.localName.toLowerCase() !== c.tag) { return false; }
	if (c.id !== null && el.getAttribute('id') !== c.id) { return false; }
	if (c.classes.length) { const set = el.classes(); if (!set.length) { return false; } for (const k of c.classes) { if (!set.includes(k)) { return false; } } }
	for (const a of c.attrs) {
		const v = el.getAttribute(a.name); if (v === null) { return false; } if (!a.op) { continue; }
		const l = a.flag === 'i' ? v.toLowerCase() : v, w = a.flag === 'i' ? a.value.toLowerCase() : a.value;
		switch (a.op) { case '=': if (l !== w) { return false; } break; case '~=': if (!l.split(/\s+/).includes(w)) { return false; } break; case '|=': if (l !== w && !l.startsWith(w + '-')) { return false; } break; case '^=': if (!w || !l.startsWith(w)) { return false; } break; case '$=': if (!w || !l.endsWith(w)) { return false; } break; case '*=': if (!w || !l.includes(w)) { return false; } break; default: return false; }
	}
	for (const p of c.pseudos) { if (!matchPseudo(el, p, ctx)) { return false; } }
	return true;
}
function matchPseudo(el, { name, arg }, ctx) {
	switch (name) {
		case 'root': return el.parentNode && el.parentNode.nodeType === 9;
		case 'first-child': return elementSiblings(el)[0] === el; case 'last-child': { const s = elementSiblings(el); return s[s.length - 1] === el; } case 'only-child': return elementSiblings(el).length === 1;
		case 'first-of-type': return elementSiblings(el).find(x => x.localName === el.localName) === el; case 'last-of-type': { const s = elementSiblings(el).filter(x => x.localName === el.localName); return s[s.length - 1] === el; }
		case 'only-of-type': return elementSiblings(el).filter(x => x.localName === el.localName).length === 1;
		case 'nth-child': case 'nth-last-child': { let s = elementSiblings(el); if (arg.of) { s = s.filter(x => matches(x, arg.of, ctx)); if (!s.includes(el)) { return false; } } const i = name === 'nth-child' ? s.indexOf(el) + 1 : s.length - s.indexOf(el); return nthMatches(i, arg); }
		case 'nth-of-type': case 'nth-last-of-type': { const s = elementSiblings(el).filter(x => x.localName === el.localName); const i = name === 'nth-of-type' ? s.indexOf(el) + 1 : s.length - s.indexOf(el); return nthMatches(i, arg); }
		case 'empty': return el.__children.every(c => c.nodeType === 8 || (c.nodeType === 3 && c.__data === ''));
		case 'not': return !matches(el, arg, ctx);
		case 'is': case 'where': case 'matches': case '-webkit-any': case 'any': return matches(el, arg, ctx);
		case 'has': { const walk = (n) => { for (const ch of n.__children) { if (ch.nodeType !== 1) { continue; } if (matches(ch, arg, ctx) || walk(ch)) { return true; } } return false; }; return walk(el); }
		case 'hover': return !!el.__hover; case 'active': return !!el.__active;
		case 'focus': return el.ownerDocument.__activeElement === el; case 'focus-visible': return el.ownerDocument.__activeElement === el && !!el.ownerDocument.__focusVisible;
		case 'focus-within': { const a = el.ownerDocument.__activeElement; return !!a && el.contains(a); }
		case 'checked': return el.hasAttribute('checked') || !!el.checked; case 'disabled': return el.hasAttribute('disabled'); case 'enabled': return !el.hasAttribute('disabled') && ['input', 'button', 'select', 'textarea'].includes(el.localName);
		case 'link': case 'any-link': return el.localName === 'a' && el.hasAttribute('href'); case 'visited': return false;
		case 'read-only': return !(el.localName === 'input' || el.localName === 'textarea') || el.hasAttribute('readonly'); case 'read-write': return (el.localName === 'input' || el.localName === 'textarea') && !el.hasAttribute('readonly');
		case 'placeholder-shown': return false; case 'required': return el.hasAttribute('required'); case 'optional': return !el.hasAttribute('required'); case 'target': return false;
		case 'dir': case 'lang': return true;
		case 'host': case 'host-context': case 'defined': return true;
		case 'fullscreen': case 'modal': case 'popover-open': case 'user-invalid': case 'indeterminate': case 'default': case 'valid': case 'invalid': case 'in-range': case 'out-of-range': return false;
		default: return false;
	}
}
