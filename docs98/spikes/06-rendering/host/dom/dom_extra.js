// DOM traversal and document-creation APIs that sanitizers and renderers lean on: NodeFilter, NodeIterator (with the spec's pre-removing steps, which DOMPurify relies on
// while it deletes nodes during iteration), TreeWalker, document.implementation and a DOMParser that builds a separate document.
export const NodeFilter = { FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3, SHOW_ALL: 0xFFFFFFFF, SHOW_ELEMENT: 0x1, SHOW_ATTRIBUTE: 0x2, SHOW_TEXT: 0x4, SHOW_CDATA_SECTION: 0x8, SHOW_ENTITY_REFERENCE: 0x10, SHOW_ENTITY: 0x20, SHOW_PROCESSING_INSTRUCTION: 0x40, SHOW_COMMENT: 0x80, SHOW_DOCUMENT: 0x100, SHOW_DOCUMENT_TYPE: 0x200, SHOW_DOCUMENT_FRAGMENT: 0x400, SHOW_NOTATION: 0x800 };

const children = (n) => n.__children || [];
const firstChild = (n) => children(n)[0] ?? null, lastChild = (n) => { const c = children(n); return c[c.length - 1] ?? null; };
const nextSibling = (n) => { const p = n.parentNode; if (!p) { return null; } const c = children(p); return c[c.indexOf(n) + 1] ?? null; };
const prevSibling = (n) => { const p = n.parentNode; if (!p) { return null; } const c = children(p); const i = c.indexOf(n); return i > 0 ? c[i - 1] : null; };
const lastDescendant = (n) => { while (lastChild(n)) { n = lastChild(n); } return n; };
/** the node after `node` in tree order within `root` (not entering `skipDescendantsOf` if given) */
function following(node, root, skipChildren = false) { if (!skipChildren && firstChild(node)) { return firstChild(node); } for (let n = node; n && n !== root; n = n.parentNode) { const s = nextSibling(n); if (s) { return s; } } return null; }
function preceding(node, root) { if (node === root) { return null; } const p = prevSibling(node); return p ? lastDescendant(p) : node.parentNode; }
const contains = (a, b) => { for (let n = b; n; n = n.parentNode) { if (n === a) { return true; } } return false; };

function accept(it, node) {
	if (!(it.whatToShow & (1 << (node.nodeType - 1)))) { return NodeFilter.FILTER_SKIP; } const f = it.filter; if (!f) { return NodeFilter.FILTER_ACCEPT; }
	return typeof f === 'function' ? f(node) : f.acceptNode(node);
}
export class NodeIterator {
	constructor(doc, root, whatToShow = 0xFFFFFFFF, filter = null) { this.root = root; this.referenceNode = root; this.pointerBeforeReferenceNode = true; this.whatToShow = whatToShow >>> 0; this.filter = filter; this.__doc = doc; (doc.__iterators ??= new Set()).add(this); }
	__traverse(forward) {
		let node = this.referenceNode, before = this.pointerBeforeReferenceNode;
		for (;;) {
			if (forward) { if (!before) { const next = following(node, this.root); if (!next) { return null; } node = next; } else { before = false; } }
			else if (before) { const prev = preceding(node, this.root); if (!prev) { return null; } node = prev; } else { before = true; }
			if (accept(this, node) === NodeFilter.FILTER_ACCEPT) { break; }
		}
		this.referenceNode = node; this.pointerBeforeReferenceNode = before; return node;
	}
	nextNode() { return this.__traverse(true); } previousNode() { return this.__traverse(false); } detach() { this.__doc.__iterators.delete(this); }
	/** the DOM spec's "NodeIterator pre-removing steps": keep the iterator's position valid when the node it stands on (or inside) is removed */
	__preRemove(removed) {
		if (!contains(removed, this.referenceNode) || removed === this.root) { return; }
		if (this.pointerBeforeReferenceNode) { const next = following(removed, this.root, true); if (next) { this.referenceNode = next; return; } this.pointerBeforeReferenceNode = false; }
		const p = prevSibling(removed); this.referenceNode = p ? lastDescendant(p) : removed.parentNode;
	}
}
export class TreeWalker {
	constructor(root, whatToShow = 0xFFFFFFFF, filter = null) { this.root = root; this.currentNode = root; this.whatToShow = whatToShow >>> 0; this.filter = filter; }
	__ok(n) { return accept(this, n); }
	parentNode() { let n = this.currentNode; while (n && n !== this.root) { n = n.parentNode; if (n && this.__ok(n) === 1) { this.currentNode = n; return n; } } return null; }
	__child(first) {
		let node = first ? firstChild(this.currentNode) : lastChild(this.currentNode);
		while (node) { const r = this.__ok(node); if (r === 1) { this.currentNode = node; return node; } if (r === 3) { const c = first ? firstChild(node) : lastChild(node); if (c) { node = c; continue; } }
			for (;;) { const s = first ? nextSibling(node) : prevSibling(node); if (s) { node = s; break; } const p = node.parentNode; if (!p || p === this.root || p === this.currentNode) { return null; } node = p; } }
		return null;
	}
	firstChild() { return this.__child(true); } lastChild() { return this.__child(false); }
	__sibling(next) {
		let node = this.currentNode; if (node === this.root) { return null; }
		for (;;) { let s = next ? nextSibling(node) : prevSibling(node); while (s) { const r = this.__ok(s); if (r === 1) { this.currentNode = s; return s; } const c = r === 3 ? (next ? firstChild(s) : lastChild(s)) : null; s = c || (next ? nextSibling(s) : prevSibling(s)); }
			node = node.parentNode; if (!node || node === this.root) { return null; } if (this.__ok(node) === 1) { return null; } }
	}
	nextSibling() { return this.__sibling(true); } previousSibling() { return this.__sibling(false); }
	nextNode() { let node = this.currentNode, r = 1; for (;;) { while (r !== 2 && firstChild(node)) { node = firstChild(node); r = this.__ok(node); if (r === 1) { this.currentNode = node; return node; } } let n = node, s = null; while (n) { if (n === this.root) { return null; } s = nextSibling(n); if (s) { break; } n = n.parentNode; } if (!s) { return null; } node = s; r = this.__ok(node); if (r === 1) { this.currentNode = node; return node; } } }
	previousNode() { let node = this.currentNode; while (node !== this.root) { let s = prevSibling(node); while (s) { node = s; let r = this.__ok(node); while (r !== 2 && lastChild(node)) { node = lastChild(node); r = this.__ok(node); } if (r === 1) { this.currentNode = node; return node; } s = prevSibling(node); } if (node === this.root || !node.parentNode) { return null; } node = node.parentNode; if (this.__ok(node) === 1) { this.currentNode = node; return node; } } return null; }
}
/** the node-iterator hook of Node.__removeChild: iterators of the document must see the node while it is still in the tree */
export function notifyRemoval(doc, node) { if (doc && doc.__iterators && doc.__iterators.size) { for (const it of doc.__iterators) { it.__preRemove(node); } } }
