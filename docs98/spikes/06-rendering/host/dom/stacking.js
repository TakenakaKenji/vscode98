// Stacking contexts for painting and hit testing (CSS 2.1 appendix E, as far as VS Code needs it).
//
// A box that creates a stacking context (z-index on a positioned box or on a flex/grid item, position:fixed or sticky, opacity < 1, a transform) and every positioned box with
// z-index:auto are not painted inside their parent's flow: they belong to the nearest enclosing stacking context, which paints, in this order, its own decorations,
// the contexts with negative z-index, its in-flow content, the positioned boxes and contexts at z-index 0/auto (tree order), then the positive z-index contexts (by z-index).
// The painter and the hit tester take the lists from here, so what is on top is also what a click reaches.
const numZ = (b) => (b.v && typeof b.v['z-index'] === 'number' ? b.v['z-index'] : null);
const FLEXISH = /^(flex|inline-flex|grid|inline-grid)$/;
const isFlexItem = (c) => !!c.el && !!c.parent && !!c.parent.v && FLEXISH.test(String(c.parent.v.display));
/** does this box start a stacking context for its descendants? z-index counts on positioned boxes and on the items of a flex/grid container (the title bar's menu relies on that) */
export function createsContext(b) {
	if (!b.el || !b.v) { return false; } const v = b.v; const z = numZ(b);
	return b.pos === 'fixed' || b.pos === 'sticky' || (z !== null && (b.pos !== 'static' || isFlexItem(b))) || (typeof v.opacity === 'number' && v.opacity < 1) || !!b.matrix;
}
/** 'ctx': creates a stacking context; 'pos': positioned with z-index:auto (painted atomically in the z-index 0 layer); null: part of the in-flow content of its parent. Inline boxes stay with their line. */
export function hoistKind(c) {
	if (c.kind === 'text' || c.kind === 'inline' || !c.v) { return null; } if (createsContext(c)) { return 'ctx'; } return c.pos !== 'static' && c.pos !== undefined ? 'pos' : null;
}
export const isHoisted = (c) => hoistKind(c) !== null;
/** layout -> Map(stacking context root box -> { neg, zero, pos } lists of the boxes it paints in the order described above, each in tree order); cached on the layout */
export function contextItems(lay) {
	if (lay.__ctxItems) { return lay.__ctxItems; } const map = new Map(); const root = lay.rootBox;
	const listsOf = (ctx) => { let l = map.get(ctx); if (!l) { l = { neg: [], zero: [], pos: [] }; map.set(ctx, l); } return l; };
	const walk = (b, ctx) => {
		for (const c of b.children) {
			if (c.kind === 'text') { continue; } const k = hoistKind(c);
			if (k === 'ctx') { const z = numZ(c); const l = listsOf(ctx); (z !== null && z < 0 ? l.neg : z !== null && z > 0 ? l.pos : l.zero).push(c); walk(c, c); }
			else if (k === 'pos') { listsOf(ctx).zero.push(c); walk(c, ctx); }
			else { walk(c, ctx); }
		}
	};
	if (root) { walk(root, root); } return (lay.__ctxItems = map);
}
const EMPTY = { neg: [], zero: [], pos: [] };
export function itemsOf(lay, b) { return (b === lay.rootBox || createsContext(b) ? contextItems(lay).get(b) : null) || EMPTY; }
/** is `box` an ancestor of `node` (or the same box)? */
function contains(box, node) { for (let n = node; n; n = n.parent) { if (n === box) { return true; } } return false; }
/** does the overflow clip and scroll offset of ancestor `a` apply to `item`? Not to a fixed box; to an absolute box only when `a` is its containing block or above it */
export function clipApplies(a, item) {
	if (item.pos === 'fixed') { return false; } if (item.pos !== 'absolute') { return true; }
	let cb = null; for (let p = item.parent; p; p = p.parent) { if (p.el && (p.pos !== 'static' || p.matrix)) { cb = p; break; } }
	return cb === null ? true : contains(a, cb);
}
/** the boxes that sit between a stacking context root and one of its items, outermost first (the root included) */
export function pathBetween(root, item) { const path = []; for (let a = item.parent; a; a = a.parent) { path.push(a); if (a === root) { break; } } return path.reverse(); }
