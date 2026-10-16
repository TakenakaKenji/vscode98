/* spike:style - native selector matching for 06-rendering/host/dom (phase 1 of the native style engine; driver: native_style.js).
 *
 * Holds three things, all filled from JavaScript:
 *  - atoms: interned strings (tag names, ids, classes, attribute names, selector strings) with their ancestor-filter hashes;
 *  - a mirror of the element tree (per node: parent, element children, tag, id, classes, attributes, hover/active/checked/empty flags), updated in batches of
 *    node records by sync() from the nodes the DOM reported as changed (dom.js setNativeStyleSink);
 *  - rule indexes: the entries of css.js buildRuleIndex (compiled selector, pseudo-element, cascade order) and their id/class/tag/universal buckets, kept
 *    in step with the JavaScript index by the same push/pop/truncate operations.
 * match() returns the matched entries of one element and of its ::before/::after in cascade order, the same lists as css.js matchedDeclarationsAll; the
 * matching follows selectors.js matchComplex/matchCompound/matchPseudo case by case. Pure C99, no platform calls.
 */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "quickjs.h"

/* ---------------------------------------------------------------- atoms */
typedef struct { char *s; int len; uint32_t hT, hC, hI; } Atom;   /* hT/hC/hI: ancestor-filter hashes of the string as a tag, a class, an id */
static Atom *atoms; static int natoms, capatoms;
static int32_t *atab; static uint32_t atabcap;   /* open addressing, atom id + 1 (0: empty) */
static uint32_t fnv(uint32_t h, const char *s, int n) { for (int i = 0; i < n; i++) { h = (h ^ (uint8_t)s[i]) * 16777619u; } return h; }
static uint32_t hash_pre(char pre, const char *s, int n) { uint32_t h = 2166136261u; h = (h ^ (uint8_t)pre) * 16777619u; return fnv(h, s, n); }
static void atab_grow(void) {
	uint32_t nc = atabcap ? atabcap * 2 : 4096; int32_t *nt = calloc(nc, sizeof(int32_t));
	for (int a = 0; a < natoms; a++) { uint32_t h = fnv(2166136261u, atoms[a].s, atoms[a].len) & (nc - 1); while (nt[h]) { h = (h + 1) & (nc - 1); } nt[h] = a + 1; }
	free(atab); atab = nt; atabcap = nc;
}
static int intern(const char *s, int len) {
	if ((uint32_t)(natoms + 1) * 2 > atabcap) { atab_grow(); }
	uint32_t h = fnv(2166136261u, s, len) & (atabcap - 1);
	for (; atab[h]; h = (h + 1) & (atabcap - 1)) { const Atom *a = &atoms[atab[h] - 1]; if (a->len == len && memcmp(a->s, s, (size_t)len) == 0) { return atab[h] - 1; } }
	if (natoms == capatoms) { capatoms = capatoms ? capatoms * 2 : 4096; atoms = realloc(atoms, (size_t)capatoms * sizeof(Atom)); }
	Atom *a = &atoms[natoms]; a->s = malloc((size_t)len + 1); memcpy(a->s, s, (size_t)len); a->s[len] = 0; a->len = len;
	a->hT = hash_pre('T', s, len); a->hC = hash_pre('.', s, len); a->hI = hash_pre('#', s, len); atab[h] = natoms + 1; return natoms++;
}
static int A_DISABLED, A_HREF, A_READONLY, A_REQUIRED, A_INPUT, A_TEXTAREA, A_BUTTON, A_SELECT, A_A;

/* ---------------------------------------------------------------- element tree mirror */
enum { NF_ELEM = 1, NF_DOC = 2, NF_HOVER = 4, NF_ACTIVE = 8, NF_CHECKED = 16, NF_EMPTY = 32 };
#define BLOOM_WORDS 32
typedef struct {
	int32_t parent, idx;   /* parent node id (0: none) and position among its element children */
	uint32_t flags; int32_t tag, tagl, id;   /* tag: localName as is; tagl: lower case; id: the id attribute (-1: none) */
	int32_t ncls; int32_t *cls; int32_t nattr; int32_t *aname; char **aval; int32_t *alen;
	int32_t nkids, capk; int32_t *kids;   /* element children, in order */
	uint32_t mark, bstamp; uint32_t bloom[BLOOM_WORDS];   /* bloom: ancestor filter (own and ancestors' tag/id/class bits), valid while bstamp == bstampCur */
} Node;
static Node *nodes; static int capnodes;
static uint32_t markSeq, bstampCur = 1;
static int32_t focusNid; static int focusVisible;
static void ensure_nodes(int n) { if (n < capnodes) { return; } int nc = capnodes ? capnodes : 4096; while (nc <= n) { nc *= 2; } nodes = realloc(nodes, (size_t)nc * sizeof(Node)); memset(nodes + capnodes, 0, (size_t)(nc - capnodes) * sizeof(Node)); capnodes = nc; }
static void clear_attrs(Node *n) { for (int i = 0; i < n->nattr; i++) { free(n->aval[i]); } n->nattr = 0; }
static void free_node(Node *n) { clear_attrs(n); free(n->aname); free(n->aval); free(n->alen); free(n->cls); free(n->kids); memset(n, 0, sizeof *n); }
static inline int is_elem(int32_t nid) { return nid > 0 && nid < capnodes && (nodes[nid].flags & NF_ELEM); }
static const uint32_t *bloom_of(int32_t nid) {
	Node *n = &nodes[nid]; if (n->bstamp == bstampCur) { return n->bloom; }
	if (is_elem(n->parent)) { memcpy(n->bloom, bloom_of(n->parent), sizeof n->bloom); n = &nodes[nid]; } else { memset(n->bloom, 0, sizeof n->bloom); }
#define ADD(h) do { uint32_t h_ = (h); uint32_t b0 = h_ & 1023, b1 = ((h_ >> 10) ^ (h_ >> 20)) & 1023; n->bloom[b0 >> 5] |= 1u << (b0 & 31); n->bloom[b1 >> 5] |= 1u << (b1 & 31); } while (0)
	if (n->tagl >= 0) { ADD(atoms[n->tagl].hT); } if (n->id >= 0 && atoms[n->id].len) { ADD(atoms[n->id].hI); } for (int i = 0; i < n->ncls; i++) { ADD(atoms[n->cls[i]].hC); }
#undef ADD
	n->bstamp = bstampCur; return n->bloom;
}
static int has_attr(const Node *n, int32_t name) { for (int i = 0; i < n->nattr; i++) { if (n->aname[i] == name) { return 1; } } return 0; }

/* ---------------------------------------------------------------- compiled selectors (from native_style.js serialize()) */
enum { P_FALSE = 0, P_TRUE, P_ROOT, P_FIRST_CHILD, P_LAST_CHILD, P_ONLY_CHILD, P_FIRST_OF_TYPE, P_LAST_OF_TYPE, P_ONLY_OF_TYPE, P_NTH_CHILD, P_NTH_LAST_CHILD, P_NTH_OF_TYPE, P_NTH_LAST_OF_TYPE,
	P_EMPTY, P_NOT, P_IS, P_HAS, P_HOVER, P_ACTIVE, P_FOCUS, P_FOCUS_VISIBLE, P_FOCUS_WITHIN, P_CHECKED, P_DISABLED, P_ENABLED, P_LINK, P_READ_ONLY, P_READ_WRITE, P_REQUIRED, P_OPTIONAL };
enum { C_DESC = 0, C_CHILD = 1, C_ADJ = 2, C_SIB = 3 };
enum { O_EXISTS = 0, O_EQ, O_WORD, O_DASH, O_PREFIX, O_SUFFIX, O_SUBSTR, O_NEVER };
typedef struct Sel Sel;
typedef struct { int n; Sel **v; } SelList;
typedef struct { int code, a, b, hasOf; SelList list; } Pseudo;
typedef struct { int32_t name, op, val, ci; } AttrSel;
typedef struct { int32_t tag, id; int ncls; int32_t *cls; int nattr; AttrSel *attrs; int nps; Pseudo *ps; } Compound;
typedef struct { int comb; Compound c; } Part;
struct Sel { int np; Part *parts; };
static void free_sel(Sel *s);
static void free_list(SelList *l) { for (int i = 0; i < l->n; i++) { free_sel(l->v[i]); } free(l->v); }
static void free_sel(Sel *s) { if (!s) { return; } for (int i = 0; i < s->np; i++) { Compound *c = &s->parts[i].c; free(c->cls); free(c->attrs); for (int k = 0; k < c->nps; k++) { free_list(&c->ps[k].list); } free(c->ps); } free(s->parts); free(s); }
typedef struct { const int32_t *b; int i, n, bad; } Rd;
static int32_t rd(Rd *r) { if (r->i >= r->n) { r->bad = 1; return 0; } return r->b[r->i++]; }
static Sel *read_sel(Rd *r);
static void read_list(Rd *r, SelList *l, int n) { l->n = 0; l->v = NULL; if (n <= 0 || r->bad) { return; } l->v = calloc((size_t)n, sizeof(Sel *)); for (int i = 0; i < n && !r->bad; i++) { l->v[i] = read_sel(r); l->n = i + 1; } }
static int atom_ok(int32_t a) { return a >= -1 && a < natoms; }
static Sel *read_sel(Rd *r) {
	Sel *s = calloc(1, sizeof(Sel)); int np = rd(r); if (np <= 0 || np > 1000) { r->bad = 1; return s; } s->parts = calloc((size_t)np, sizeof(Part));
	for (int p = 0; p < np && !r->bad; p++) {
		s->np = p + 1; Part *pt = &s->parts[p]; pt->comb = rd(r); Compound *c = &pt->c;
		c->tag = rd(r); c->id = rd(r); if (!atom_ok(c->tag) || !atom_ok(c->id)) { r->bad = 1; return s; }
		c->ncls = rd(r); if (c->ncls < 0 || c->ncls > 1000) { r->bad = 1; return s; } c->cls = c->ncls ? malloc((size_t)c->ncls * sizeof(int32_t)) : NULL; for (int k = 0; k < c->ncls; k++) { c->cls[k] = rd(r); if (!atom_ok(c->cls[k]) || c->cls[k] < 0) { r->bad = 1; } }
		c->nattr = rd(r); if (c->nattr < 0 || c->nattr > 1000) { r->bad = 1; return s; } c->attrs = c->nattr ? calloc((size_t)c->nattr, sizeof(AttrSel)) : NULL;
		for (int k = 0; k < c->nattr; k++) { AttrSel *a = &c->attrs[k]; a->name = rd(r); a->op = rd(r); a->val = rd(r); a->ci = rd(r); if (a->name < 0 || !atom_ok(a->name) || a->val < 0 || !atom_ok(a->val)) { r->bad = 1; } }
		c->nps = rd(r); if (c->nps < 0 || c->nps > 1000) { r->bad = 1; return s; } c->ps = c->nps ? calloc((size_t)c->nps, sizeof(Pseudo)) : NULL;
		for (int k = 0; k < c->nps && !r->bad; k++) {
			Pseudo *ps = &c->ps[k]; ps->code = rd(r);
			if (ps->code == P_NOT || ps->code == P_IS || ps->code == P_HAS) { read_list(r, &ps->list, rd(r)); }
			else if (ps->code == P_NTH_CHILD || ps->code == P_NTH_LAST_CHILD) { ps->a = rd(r); ps->b = rd(r); int n = rd(r); ps->hasOf = n >= 0; read_list(r, &ps->list, n); }
			else if (ps->code == P_NTH_OF_TYPE || ps->code == P_NTH_LAST_OF_TYPE) { ps->a = rd(r); ps->b = rd(r); }
		}
	}
	return s;
}

/* ---------------------------------------------------------------- matching (selectors.js) */
static int match_complex(int32_t nid, const Sel *s, int i);
static int match_list(int32_t nid, const SelList *l) { for (int k = 0; k < l->n; k++) { if (l->v[k]->np && match_complex(nid, l->v[k], l->v[k]->np - 1)) { return 1; } } return 0; }
static int32_t prev_sib(int32_t nid) { const Node *n = &nodes[nid]; if (n->parent <= 0 || n->idx <= 0) { return 0; } const Node *p = &nodes[n->parent]; return n->idx - 1 < p->nkids ? p->kids[n->idx - 1] : 0; }
static int nth(int n, int a, int b) { if (a == 0) { return n == b; } long d = (long)n - b; if (d % a != 0) { return 0; } return d / a >= 0; }
static inline int lc(int c) { return c >= 'A' && c <= 'Z' ? c + 32 : c; }
static int eq_n(const char *a, const char *b, int n, int ci) { if (!ci) { return memcmp(a, b, (size_t)n) == 0; } for (int i = 0; i < n; i++) { if (lc((uint8_t)a[i]) != lc((uint8_t)b[i])) { return 0; } } return 1; }
static inline int is_ws(int c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'; }
static int match_attr_value(const char *l, int ll, const AttrSel *a) {
	const char *w = atoms[a->val].s; int wl = atoms[a->val].len; const int ci = a->ci;
	switch (a->op) {
		case O_EQ: return ll == wl && eq_n(l, w, wl, ci);
		case O_WORD: { int st = 0; for (int i = 0; i <= ll; i++) { if (i == ll || is_ws((uint8_t)l[i])) { if (i - st == wl && eq_n(l + st, w, wl, ci)) { return 1; } if (i == ll) { break; } while (i + 1 < ll && is_ws((uint8_t)l[i + 1])) { i++; } st = i + 1; } } return 0; }   /* JS: l.split(/\s+/).includes(w) */
		case O_DASH: return (ll == wl && eq_n(l, w, wl, ci)) || (ll > wl && eq_n(l, w, wl, ci) && l[wl] == '-');
		case O_PREFIX: return wl > 0 && ll >= wl && eq_n(l, w, wl, ci);
		case O_SUFFIX: return wl > 0 && ll >= wl && eq_n(l + ll - wl, w, wl, ci);
		case O_SUBSTR: { if (wl == 0 || ll < wl) { return 0; } for (int i = 0; i + wl <= ll; i++) { if (eq_n(l + i, w, wl, ci)) { return 1; } } return 0; }
		default: return 0;
	}
}
static int has_desc(int32_t nid, const SelList *l) { const Node *n = &nodes[nid]; for (int k = 0; k < n->nkids; k++) { int32_t c = n->kids[k]; if (!is_elem(c)) { continue; } if (match_list(c, l) || has_desc(c, l)) { return 1; } } return 0; }
static int match_pseudo(int32_t nid, const Pseudo *ps) {
	const Node *n = &nodes[nid]; const Node *p = n->parent > 0 ? &nodes[n->parent] : NULL;
	switch (ps->code) {
		case P_TRUE: return 1;
		case P_ROOT: return p && (p->flags & NF_DOC);
		case P_FIRST_CHILD: return !p || n->idx == 0;
		case P_LAST_CHILD: return !p || n->idx == p->nkids - 1;
		case P_ONLY_CHILD: return !p || p->nkids == 1;
		case P_FIRST_OF_TYPE: case P_LAST_OF_TYPE: case P_ONLY_OF_TYPE: case P_NTH_OF_TYPE: case P_NTH_LAST_OF_TYPE: {
			if (!p) { return ps->code == P_NTH_OF_TYPE || ps->code == P_NTH_LAST_OF_TYPE ? nth(1, ps->a, ps->b) : 1; }
			int before = 0, after = 0; for (int k = 0; k < p->nkids; k++) { int32_t c = p->kids[k]; if (c == nid || !is_elem(c) || nodes[c].tag != n->tag) { continue; } if (k < n->idx) { before++; } else { after++; } }
			switch (ps->code) { case P_FIRST_OF_TYPE: return before == 0; case P_LAST_OF_TYPE: return after == 0; case P_ONLY_OF_TYPE: return before == 0 && after == 0; case P_NTH_OF_TYPE: return nth(before + 1, ps->a, ps->b); default: return nth(after + 1, ps->a, ps->b); }
		}
		case P_NTH_CHILD: case P_NTH_LAST_CHILD: {
			if (ps->hasOf && !match_list(nid, &ps->list)) { return 0; }
			if (!p) { return nth(1, ps->a, ps->b); }
			int before = 0, after = 0; for (int k = 0; k < p->nkids; k++) { int32_t c = p->kids[k]; if (c == nid || !is_elem(c)) { continue; } if (ps->hasOf && !match_list(c, &ps->list)) { continue; } if (k < n->idx) { before++; } else { after++; } }
			return nth(ps->code == P_NTH_CHILD ? before + 1 : after + 1, ps->a, ps->b);
		}
		case P_EMPTY: return (n->flags & NF_EMPTY) != 0;
		case P_NOT: return !match_list(nid, &ps->list);
		case P_IS: return match_list(nid, &ps->list);
		case P_HAS: return has_desc(nid, &ps->list);
		case P_HOVER: return (n->flags & NF_HOVER) != 0;
		case P_ACTIVE: return (n->flags & NF_ACTIVE) != 0;
		case P_FOCUS: return nid == focusNid;
		case P_FOCUS_VISIBLE: return nid == focusNid && focusVisible;
		case P_FOCUS_WITHIN: { for (int32_t a = focusNid, guard = 0; a > 0 && a < capnodes && guard < 100000; a = nodes[a].parent, guard++) { if (a == nid) { return 1; } } return 0; }
		case P_CHECKED: return (n->flags & NF_CHECKED) != 0;
		case P_DISABLED: return has_attr(n, A_DISABLED);
		case P_ENABLED: return !has_attr(n, A_DISABLED) && (n->tag == A_INPUT || n->tag == A_BUTTON || n->tag == A_SELECT || n->tag == A_TEXTAREA);
		case P_LINK: return n->tag == A_A && has_attr(n, A_HREF);
		case P_READ_ONLY: return !(n->tag == A_INPUT || n->tag == A_TEXTAREA) || has_attr(n, A_READONLY);
		case P_READ_WRITE: return (n->tag == A_INPUT || n->tag == A_TEXTAREA) && !has_attr(n, A_READONLY);
		case P_REQUIRED: return has_attr(n, A_REQUIRED);
		case P_OPTIONAL: return !has_attr(n, A_REQUIRED);
		default: return 0;
	}
}
static int match_compound(int32_t nid, const Compound *c) {
	const Node *n = &nodes[nid];
	if (c->tag >= 0 && n->tagl != c->tag) { return 0; }
	if (c->id >= 0 && n->id != c->id) { return 0; }
	for (int k = 0; k < c->ncls; k++) { int ok = 0; for (int j = 0; j < n->ncls; j++) { if (n->cls[j] == c->cls[k]) { ok = 1; break; } } if (!ok) { return 0; } }
	for (int k = 0; k < c->nattr; k++) {
		const AttrSel *a = &c->attrs[k]; int j = 0; for (; j < n->nattr; j++) { if (n->aname[j] == a->name) { break; } } if (j == n->nattr) { return 0; }
		if (a->op != O_EXISTS && !match_attr_value(n->aval[j], n->alen[j], a)) { return 0; }
	}
	for (int k = 0; k < c->nps; k++) { if (!match_pseudo(nid, &c->ps[k])) { return 0; } }
	return 1;
}
static int match_complex(int32_t nid, const Sel *s, int i) {
	if (!match_compound(nid, &s->parts[i].c)) { return 0; } if (i == 0) { return 1; }
	switch (s->parts[i].comb) {
		case C_CHILD: { int32_t p = nodes[nid].parent; return is_elem(p) && match_complex(p, s, i - 1); }
		case C_DESC: { for (int32_t p = nodes[nid].parent; is_elem(p); p = nodes[p].parent) { if (match_complex(p, s, i - 1)) { return 1; } } return 0; }
		case C_ADJ: { int32_t p = prev_sib(nid); return p > 0 && match_complex(p, s, i - 1); }
		default: { for (int32_t p = prev_sib(nid); p > 0; p = prev_sib(p)) { if (is_elem(p) && match_complex(p, s, i - 1)) { return 1; } } return 0; }
	}
}

/* ---------------------------------------------------------------- rule indexes (css.js buildRuleIndex) */
typedef struct { Sel *sel; int pk, ua, order, s0, s1, s2, multi; uint32_t mk; int nneed; uint16_t *need; int32_t *any; } Entry;   /* pk: 0 element, 1 ::before, 2 ::after, 3 other pseudo-element */
typedef struct { int n, cap; int32_t *v; } Vec;
typedef struct { int32_t *keys, *vals; uint32_t cap, n; } IMap;   /* atom -> bucket */
typedef struct { int used; Entry *ents; int nents, capents; Vec *bk; int nb, capb; IMap maps[3]; int universal; uint32_t tok; } Index;
static Index *idxs; static int nidxs;
static void vpush(Vec *v, int32_t x) { if (v->n == v->cap) { v->cap = v->cap ? v->cap * 2 : 8; v->v = realloc(v->v, (size_t)v->cap * sizeof(int32_t)); } v->v[v->n++] = x; }
static int imap_get(const IMap *m, int32_t k) { if (!m->cap) { return -1; } uint32_t h = ((uint32_t)k * 2654435761u) & (m->cap - 1); for (; m->keys[h] != -1; h = (h + 1) & (m->cap - 1)) { if (m->keys[h] == k) { return m->vals[h]; } } return -1; }
static void imap_put(IMap *m, int32_t k, int32_t v) {
	if ((m->n + 1) * 2 > m->cap) {
		uint32_t nc = m->cap ? m->cap * 2 : 64; int32_t *nk = malloc(nc * sizeof(int32_t)), *nv = malloc(nc * sizeof(int32_t)); memset(nk, 0xff, nc * sizeof(int32_t));
		for (uint32_t i = 0; i < m->cap; i++) { if (m->keys[i] != -1) { uint32_t h = ((uint32_t)m->keys[i] * 2654435761u) & (nc - 1); while (nk[h] != -1) { h = (h + 1) & (nc - 1); } nk[h] = m->keys[i]; nv[h] = m->vals[i]; } }
		free(m->keys); free(m->vals); m->keys = nk; m->vals = nv; m->cap = nc;
	}
	uint32_t h = ((uint32_t)k * 2654435761u) & (m->cap - 1); while (m->keys[h] != -1 && m->keys[h] != k) { h = (h + 1) & (m->cap - 1); } if (m->keys[h] == -1) { m->n++; } m->keys[h] = k; m->vals[h] = v;
}
static void free_entry(Entry *e) { free_sel(e->sel); free(e->need); free(e->any); memset(e, 0, sizeof *e); }
static int new_bucket(Index *x) { if (x->nb == x->capb) { x->capb = x->capb ? x->capb * 2 : 256; x->bk = realloc(x->bk, (size_t)x->capb * sizeof(Vec)); } memset(&x->bk[x->nb], 0, sizeof(Vec)); return x->nb++; }
static Index *get_index(JSContext *ctx, JSValueConst v) { int32_t h; if (JS_ToInt32(ctx, &h, v) || h < 0 || h >= nidxs || !idxs[h].used) { return NULL; } return &idxs[h]; }
/* the ancestor-filter requirements of a selector (css.js needOf / needAnyOf): bits that must be set in the element's filter, and "one of" groups */
static void hashes_of(const Compound *c, uint32_t *hs, int *n, int cap) { *n = 0; if (c->id >= 0 && atoms[c->id].len && *n < cap) { hs[(*n)++] = atoms[c->id].hI; } for (int k = 0; k < c->ncls && *n < cap; k++) { hs[(*n)++] = atoms[c->cls[k]].hC; } if (c->tag >= 0 && *n < cap) { hs[(*n)++] = atoms[c->tag].hT; } }
static void compute_need(Entry *e) {
	const Sel *s = e->sel; Vec need = { 0 }, any = { 0 }; int ngroups = 0; vpush(&any, 0);
	for (int k = s->np - 1; k >= 1; k--) {
		if (s->parts[k].comb != C_DESC && s->parts[k].comb != C_CHILD) { break; }
		const Compound *c = &s->parts[k - 1].c; uint32_t hs[64]; int nh; hashes_of(c, hs, &nh, 64);
		for (int j = 0; j < nh; j++) { vpush(&need, hs[j] & 1023); vpush(&need, ((hs[j] >> 10) ^ (hs[j] >> 20)) & 1023); }
		for (int q = 0; q < c->nps; q++) {
			const Pseudo *ps = &c->ps[q]; if (ps->code != P_IS || ps->list.n == 0) { continue; }
			int start = any.n, ok = 1; vpush(&any, ps->list.n);
			for (int a = 0; a < ps->list.n && ok; a++) { const Sel *alt = ps->list.v[a]; if (!alt->np) { ok = 0; break; } hashes_of(&alt->parts[alt->np - 1].c, hs, &nh, 64); if (!nh) { ok = 0; break; } vpush(&any, nh * 2); for (int j = 0; j < nh; j++) { vpush(&any, hs[j] & 1023); vpush(&any, ((hs[j] >> 10) ^ (hs[j] >> 20)) & 1023); } }
			if (ok) { ngroups++; } else { any.n = start; }
		}
	}
	e->nneed = need.n; e->need = NULL; if (need.n) { e->need = malloc((size_t)need.n * sizeof(uint16_t)); for (int i = 0; i < need.n; i++) { e->need[i] = (uint16_t)need.v[i]; } } free(need.v);
	if (ngroups) { any.v[0] = ngroups; e->any = any.v; } else { free(any.v); e->any = NULL; }
}
static inline int bit(const uint32_t *f, int b) { return (f[b >> 5] >> (b & 31)) & 1; }
static int any_rejects(const uint32_t *f, const int32_t *g) {
	int ng = g[0], i = 1;
	for (int q = 0; q < ng; q++) {
		int nalt = g[i++], found = 0;
		for (int a = 0; a < nalt; a++) { int nb = g[i++]; int ok = 1; for (int j = 0; j < nb; j++) { if (ok && !bit(f, g[i + j])) { ok = 0; } } i += nb; if (ok) { found = 1; } }
		if (!found) { return 1; }
	}
	return 0;
}

/* ---------------------------------------------------------------- JS API */
static int32_t *outBuf; static int outCap;   /* the Int32Array of setOut(); native_style.js keeps it alive */
static int get_i32(JSContext *ctx, JSValueConst v, int32_t **p, int *n) {
	size_t off, len, bpe; JSValue buf = JS_GetTypedArrayBuffer(ctx, v, &off, &len, &bpe); if (JS_IsException(buf)) { return -1; }
	size_t sz; uint8_t *b = JS_GetArrayBuffer(ctx, &sz, buf); JS_FreeValue(ctx, buf); if (!b || bpe != 4) { return -1; } *p = (int32_t *)(b + off); *n = (int)(len / 4); return 0;
}
static JSValue js_atom(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) { size_t len; const char *s = JS_ToCStringLen(ctx, &len, argv[0]); if (!s) { return JS_EXCEPTION; } int a = intern(s, (int)len); JS_FreeCString(ctx, s); return JS_NewInt32(ctx, a); }
/* sync(buf, len, vals, maxNid): node records [nid, flags, tag, tagl, id, ncls, cls..., nattr, names..., nkids, kids...]; attribute values in `vals`, in order.
 * Children that left a node (and were not placed elsewhere in the batch) are freed with their subtrees; returns the freed node ids. */
static JSValue js_sync(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	int32_t *b; int cap; int32_t len, maxNid; if (get_i32(ctx, argv[0], &b, &cap) || JS_ToInt32(ctx, &len, argv[1]) || JS_ToInt32(ctx, &maxNid, argv[3])) { return JS_ThrowTypeError(ctx, "sync: bad arguments"); }
	if (len > cap) { len = cap; } ensure_nodes(maxNid + 1); bstampCur++;
	Vec orphans = { 0 }; int i = 0; uint32_t vi = 0;
#define NEXT() (i < len ? b[i++] : 0)
	while (i < len) {
		int32_t nid = NEXT(); if (nid <= 0 || nid > maxNid) { free(orphans.v); return JS_ThrowRangeError(ctx, "sync: bad node id %d", nid); }
		Node *n = &nodes[nid]; n->flags = (uint32_t)NEXT(); n->tag = NEXT(); n->tagl = NEXT(); n->id = NEXT();
		int nc = NEXT(); if (nc < 0) { nc = 0; } n->cls = realloc(n->cls, (size_t)(nc ? nc : 1) * sizeof(int32_t)); n->ncls = nc; for (int k = 0; k < nc; k++) { n->cls[k] = NEXT(); }
		clear_attrs(n); int na = NEXT(); if (na < 0) { na = 0; }
		n->aname = realloc(n->aname, (size_t)(na ? na : 1) * sizeof(int32_t)); n->aval = realloc(n->aval, (size_t)(na ? na : 1) * sizeof(char *)); n->alen = realloc(n->alen, (size_t)(na ? na : 1) * sizeof(int32_t));
		for (int k = 0; k < na; k++) {
			n->aname[k] = NEXT(); JSValue v = JS_GetPropertyUint32(ctx, argv[2], vi++); size_t sl; const char *s = JS_ToCStringLen(ctx, &sl, v); JS_FreeValue(ctx, v);
			n->aval[k] = malloc(sl + 1); if (s) { memcpy(n->aval[k], s, sl); JS_FreeCString(ctx, s); } else { sl = 0; } n->aval[k][sl] = 0; n->alen[k] = (int32_t)sl; n->nattr = k + 1;
		}
		int nk = NEXT(); if (nk < 0) { nk = 0; } uint32_t m = ++markSeq; int k0 = i;
		for (int k = 0; k < nk && k0 + k < len; k++) { int32_t c = b[k0 + k]; if (c > 0 && c <= maxNid) { nodes[c].mark = m; } }
		for (int k = 0; k < n->nkids; k++) { int32_t c = n->kids[k]; if (c > 0 && c < capnodes && nodes[c].mark != m && nodes[c].parent == nid) { nodes[c].parent = 0; vpush(&orphans, c); } }
		if (nk > n->capk) { n->capk = nk; n->kids = realloc(n->kids, (size_t)nk * sizeof(int32_t)); }
		n->nkids = 0; for (int k = 0; k < nk; k++) { int32_t c = NEXT(); if (c <= 0 || c > maxNid) { continue; } n->kids[n->nkids] = c; nodes[c].parent = nid; nodes[c].idx = n->nkids++; }
	}
#undef NEXT
	JSValue freed = JS_NewArray(ctx); uint32_t nf = 0; Vec stack = { 0 };
	for (int k = 0; k < orphans.n; k++) {
		int32_t o = orphans.v[k]; if (nodes[o].parent != 0 || nodes[o].flags == 0) { continue; }
		stack.n = 0; vpush(&stack, o);
		while (stack.n) { int32_t x = stack.v[--stack.n]; Node *xn = &nodes[x]; for (int j = 0; j < xn->nkids; j++) { int32_t c = xn->kids[j]; if (c > 0 && c < capnodes && nodes[c].parent == x) { vpush(&stack, c); } } free_node(&nodes[x]); JS_SetPropertyUint32(ctx, freed, nf++, JS_NewInt32(ctx, x)); }
	}
	free(stack.v); free(orphans.v); return freed;
}
static JSValue js_pass(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) { int32_t f, v; if (JS_ToInt32(ctx, &f, argv[0]) || JS_ToInt32(ctx, &v, argv[1])) { return JS_EXCEPTION; } focusNid = f > 0 && f < capnodes ? f : 0; focusVisible = v != 0; bstampCur++; return JS_UNDEFINED; }
static JSValue js_idx_new(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	int h = 0; for (; h < nidxs; h++) { if (!idxs[h].used) { break; } } if (h == nidxs) { idxs = realloc(idxs, (size_t)(nidxs + 1) * sizeof(Index)); nidxs++; }
	Index *x = &idxs[h]; memset(x, 0, sizeof *x); x->used = 1; x->universal = new_bucket(x); return JS_NewInt32(ctx, h);
}
static JSValue js_idx_free(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	Index *x = get_index(ctx, argv[0]); if (!x) { return JS_UNDEFINED; }
	for (int i = 0; i < x->nents; i++) { free_entry(&x->ents[i]); } free(x->ents); for (int i = 0; i < x->nb; i++) { free(x->bk[i].v); } free(x->bk); for (int k = 0; k < 3; k++) { free(x->maps[k].keys); free(x->maps[k].vals); }
	memset(x, 0, sizeof *x); return JS_UNDEFINED;
}
/* bucket(h, kind, keyAtom): the bucket of an id (0), class (1) or tag (2) key, created on first use; kind 3: the universal bucket */
static JSValue js_bucket(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	Index *x = get_index(ctx, argv[0]); int32_t kind, key; if (!x || JS_ToInt32(ctx, &kind, argv[1]) || JS_ToInt32(ctx, &key, argv[2])) { return JS_ThrowTypeError(ctx, "bucket: bad arguments"); }
	if (kind == 3) { return JS_NewInt32(ctx, x->universal); } if (kind < 0 || kind > 2) { return JS_ThrowRangeError(ctx, "bucket: bad kind"); }
	int b = imap_get(&x->maps[kind], key); if (b < 0) { b = new_bucket(x); imap_put(&x->maps[kind], key, b); } return JS_NewInt32(ctx, b);
}
/* entry(h, ser, pk, ua, order, s0, s1, s2, multi): appends an entry (its id is the entry count before the call, as css.js index.count) */
static JSValue js_entry(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	Index *x = get_index(ctx, argv[0]); int32_t *ser; int sn; int32_t a[7]; if (!x || get_i32(ctx, argv[1], &ser, &sn)) { return JS_ThrowTypeError(ctx, "entry: bad arguments"); }
	for (int k = 0; k < 7; k++) { if (JS_ToInt32(ctx, &a[k], argv[2 + k])) { return JS_EXCEPTION; } }
	Rd r = { ser, 0, sn, 0 }; Sel *s = read_sel(&r); if (r.bad || s->np == 0) { free_sel(s); return JS_ThrowSyntaxError(ctx, "entry: bad serialized selector"); }
	if (x->nents == x->capents) { x->capents = x->capents ? x->capents * 2 : 1024; x->ents = realloc(x->ents, (size_t)x->capents * sizeof(Entry)); }
	Entry *e = &x->ents[x->nents]; memset(e, 0, sizeof *e); e->sel = s; e->pk = a[0]; e->ua = a[1]; e->order = a[2]; e->s0 = a[3]; e->s1 = a[4]; e->s2 = a[5]; e->multi = a[6]; compute_need(e);
	return JS_NewInt32(ctx, x->nents++);
}
static JSValue js_push(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) { Index *x = get_index(ctx, argv[0]); int32_t b, e; if (!x || JS_ToInt32(ctx, &b, argv[1]) || JS_ToInt32(ctx, &e, argv[2]) || b < 0 || b >= x->nb || e < 0 || e >= x->nents) { return JS_ThrowRangeError(ctx, "push: bad arguments"); } vpush(&x->bk[b], e); return JS_UNDEFINED; }
static JSValue js_pop(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) { Index *x = get_index(ctx, argv[0]); int32_t b; if (!x || JS_ToInt32(ctx, &b, argv[1]) || b < 0 || b >= x->nb) { return JS_ThrowRangeError(ctx, "pop: bad arguments"); } if (x->bk[b].n) { x->bk[b].n--; } return JS_UNDEFINED; }
static JSValue js_truncate(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) { Index *x = get_index(ctx, argv[0]); int32_t n; if (!x || JS_ToInt32(ctx, &n, argv[1])) { return JS_ThrowTypeError(ctx, "truncate: bad arguments"); } while (x->nents > n && x->nents > 0) { free_entry(&x->ents[--x->nents]); } return JS_UNDEFINED; }
static JSValue js_set_out(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) { int32_t *p; int n; if (get_i32(ctx, argv[0], &p, &n)) { return JS_ThrowTypeError(ctx, "setOut: Int32Array expected"); } outBuf = p; outCap = n; return JS_UNDEFINED; }
/* cascade order (css.js): user-agent rules first, then by specificity, then by source order; stable */
static int cmp_ent(const Entry *a, const Entry *b) { if (a->ua != b->ua) { return a->ua ? -1 : 1; } if (a->s0 != b->s0) { return a->s0 - b->s0; } if (a->s1 != b->s1) { return a->s1 - b->s1; } if (a->s2 != b->s2) { return a->s2 - b->s2; } return a->order - b->order; }
static Vec res[3]; static long statConsidered, statMatched, statCalls;
static void consider(Index *x, const Vec *bk, const uint32_t *f, int32_t nid) {
	for (int k = 0; k < bk->n; k++) {
		Entry *e = &x->ents[bk->v[k]]; if (e->multi) { if (e->mk == x->tok) { continue; } e->mk = x->tok; }
		if (e->pk > 2) { continue; } statConsidered++;
		int ok = 1; for (int j = 0; j < e->nneed; j++) { if (!bit(f, e->need[j])) { ok = 0; break; } } if (!ok) { continue; }
		if (e->any && any_rejects(f, e->any)) { continue; }
		statMatched++; if (match_complex(nid, e->sel, e->sel->np - 1)) { vpush(&res[e->pk], bk->v[k]); }
	}
}
/* match(h, nid): writes [n0, n1, n2, ids of the element's entries..., of ::before..., of ::after...] to the out buffer; returns the number of ints, or -needed */
static JSValue js_match(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	Index *x = get_index(ctx, argv[0]); int32_t nid; if (!x || JS_ToInt32(ctx, &nid, argv[1]) || !is_elem(nid)) { return JS_ThrowRangeError(ctx, "match: bad arguments"); }
	statCalls++; res[0].n = res[1].n = res[2].n = 0; x->tok++; if (x->tok == 0) { for (int i = 0; i < x->nents; i++) { x->ents[i].mk = 0; } x->tok = 1; }
	const uint32_t *f = bloom_of(nid); const Node *n = &nodes[nid]; int b;
	if (n->id >= 0 && atoms[n->id].len && (b = imap_get(&x->maps[0], n->id)) >= 0) { consider(x, &x->bk[b], f, nid); }
	for (int k = 0; k < nodes[nid].ncls; k++) { if ((b = imap_get(&x->maps[1], nodes[nid].cls[k])) >= 0) { consider(x, &x->bk[b], f, nid); } }
	if ((b = imap_get(&x->maps[2], nodes[nid].tag)) >= 0) { consider(x, &x->bk[b], f, nid); }
	consider(x, &x->bk[x->universal], f, nid);
	int total = 3 + res[0].n + res[1].n + res[2].n; if (total > outCap) { return JS_NewInt32(ctx, -total); }
	int o = 3;
	for (int q = 0; q < 3; q++) {
		Vec *v = &res[q]; outBuf[q] = v->n;
		for (int i = 1; i < v->n; i++) { int32_t t = v->v[i]; int j = i - 1; while (j >= 0 && cmp_ent(&x->ents[v->v[j]], &x->ents[t]) > 0) { v->v[j + 1] = v->v[j]; j--; } v->v[j + 1] = t; }
		memcpy(outBuf + o, v->v, (size_t)v->n * sizeof(int32_t)); o += v->n;
	}
	return JS_NewInt32(ctx, total);
}
static JSValue js_stats(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	JSValue r = JS_NewObject(ctx); JS_SetPropertyStr(ctx, r, "calls", JS_NewFloat64(ctx, (double)statCalls)); JS_SetPropertyStr(ctx, r, "considered", JS_NewFloat64(ctx, (double)statConsidered)); JS_SetPropertyStr(ctx, r, "matched", JS_NewFloat64(ctx, (double)statMatched)); JS_SetPropertyStr(ctx, r, "atoms", JS_NewInt32(ctx, natoms));
	int live = 0; for (int i = 1; i < capnodes; i++) { if (nodes[i].flags) { live++; } } JS_SetPropertyStr(ctx, r, "nodes", JS_NewInt32(ctx, live)); return r;
}
/* parentOf(nid) and kidsOf(nid): for tests of the mirror */
static JSValue js_parent_of(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) { int32_t nid; if (JS_ToInt32(ctx, &nid, argv[0]) || nid <= 0 || nid >= capnodes) { return JS_NewInt32(ctx, -1); } return JS_NewInt32(ctx, nodes[nid].flags ? nodes[nid].parent : -1); }
static JSValue js_kids_of(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) { int32_t nid; JSValue a = JS_NewArray(ctx); if (JS_ToInt32(ctx, &nid, argv[0]) || nid <= 0 || nid >= capnodes) { return a; } for (int k = 0; k < nodes[nid].nkids; k++) { JS_SetPropertyUint32(ctx, a, (uint32_t)k, JS_NewInt32(ctx, nodes[nid].kids[k])); } return a; }

#include "style_compute.c"   /* phase 2: the computed-value step */

static const JSCFunctionListEntry sfuncs[] = {
	JS_CFUNC_DEF("atom", 1, js_atom), JS_CFUNC_DEF("sync", 4, js_sync), JS_CFUNC_DEF("pass", 2, js_pass), JS_CFUNC_DEF("idxNew", 0, js_idx_new), JS_CFUNC_DEF("idxFree", 1, js_idx_free),
	JS_CFUNC_DEF("bucket", 3, js_bucket), JS_CFUNC_DEF("entry", 9, js_entry), JS_CFUNC_DEF("push", 3, js_push), JS_CFUNC_DEF("pop", 2, js_pop), JS_CFUNC_DEF("truncate", 2, js_truncate),
	JS_CFUNC_DEF("setOut", 1, js_set_out), JS_CFUNC_DEF("match", 2, js_match), JS_CFUNC_DEF("stats", 0, js_stats), JS_CFUNC_DEF("parentOf", 1, js_parent_of), JS_CFUNC_DEF("kidsOf", 1, js_kids_of),
	STYLE_COMPUTE_FUNCS
};
static int style_init(JSContext *ctx, JSModuleDef *m) { return JS_SetModuleExportList(ctx, m, sfuncs, sizeof sfuncs / sizeof sfuncs[0]); }
void spike_init_style(JSContext *ctx) {
	if (!natoms) {
#define I(v, s) v = intern(s, (int)strlen(s))
		I(A_DISABLED, "disabled"); I(A_HREF, "href"); I(A_READONLY, "readonly"); I(A_REQUIRED, "required"); I(A_INPUT, "input"); I(A_TEXTAREA, "textarea"); I(A_BUTTON, "button"); I(A_SELECT, "select"); I(A_A, "a");
#undef I
	}
	JSModuleDef *m = JS_NewCModule(ctx, "spike:style", style_init); if (m) { JS_AddModuleExportList(ctx, m, sfuncs, sizeof sfuncs / sizeof sfuncs[0]); }
}
