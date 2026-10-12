/* Native Oniguruma engine: a C port of vscode-oniguruma's src/onig.cc (Microsoft, MIT) without the Emscripten parts.
 * Built against Oniguruma 6.9.8, the exact commit vscode-oniguruma 1.7.0 compiled to onig.wasm, so matching behaviour is the same code. */
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include "oniguruma.h"
#include "onig_engine.h"

typedef struct { unsigned char *strData; int strLength; regex_t *regex; OnigRegion *region; int hasGAnchor; int lastSearchStrCacheId; int lastSearchPosition; int lastSearchOnigOption; int lastSearchMatched; } OnigRegExp;
typedef struct { OnigRegSet *rset; OnigRegExp **regexes; int count; } OnigScanner;

#define MAX_REGIONS 1000
static const int *encode_region(OnigRegion *result, int index) {
	static int encoded[2 * (1 + MAX_REGIONS)];
	if (result == NULL || result->num_regs > MAX_REGIONS) { return NULL; }
	encoded[0] = index; encoded[1] = result->num_regs;
	for (int i = 0; i < result->num_regs; i++) { encoded[2 * i + 2] = result->beg[i]; encoded[2 * i + 3] = result->end[i]; }
	return encoded;
}
static int has_g_anchor(const unsigned char *s, int len) { for (int p = 0; p < len; p++) { if (s[p] == '\\' && p + 1 < len && s[p + 1] == 'G') { return 1; } } return 0; }

static OnigRegExp *create_regexp(const unsigned char *data, int length, char *err, int errlen) {
	regex_t *regex; OnigErrorInfo info;
	int status = onig_new(&regex, data, data + length, ONIG_OPTION_CAPTURE_GROUP, ONIG_ENCODING_UTF8, ONIG_SYNTAX_DEFAULT, &info);
	if (status != ONIG_NORMAL) {
		UChar buf[ONIG_MAX_ERROR_MESSAGE_LEN]; onig_error_code_to_str(buf, status, &info);
		snprintf(err, errlen, "%s", (char *)buf); return NULL;
	}
	OnigRegExp *r = calloc(1, sizeof *r);
	r->strLength = length; r->strData = malloc(length ? length : 1); memcpy(r->strData, data, length);
	r->regex = regex; r->region = onig_region_new(); r->hasGAnchor = has_g_anchor(data, length);
	r->lastSearchOnigOption = ONIG_OPTION_NONE;
	return r;
}
static void free_regexp(OnigRegExp *r) { free(r->strData); onig_region_free(r->region, 1); free(r); }

static OnigRegion *search_one(OnigRegExp *r, const unsigned char *str, int len, int pos, OnigOptionType opt) {
	int status = onig_search(r->regex, str, str + len, str + pos, str + len, r->region, opt);
	if (status == ONIG_MISMATCH || status < 0) { r->lastSearchMatched = 0; return NULL; }
	r->lastSearchMatched = 1; return r->region;
}
static OnigRegion *search_cached(OnigRegExp *r, int cacheId, const unsigned char *str, int len, int pos, OnigOptionType opt) {
	if (r->hasGAnchor) { return search_one(r, str, len, pos, opt); }          /* \G depends on the position: never cache */
	if (r->lastSearchStrCacheId == cacheId && r->lastSearchOnigOption == (int)opt && r->lastSearchPosition <= pos) {
		if (!r->lastSearchMatched) { return NULL; }
		if (r->region->beg[0] >= pos) { return r->region; }
	}
	r->lastSearchStrCacheId = cacheId; r->lastSearchPosition = pos; r->lastSearchOnigOption = (int)opt;
	return search_one(r, str, len, pos, opt);
}

static int n_init(void) { return 0; }
static void *n_create(const unsigned char **patterns, const int *lengths, int count, char *err, int errlen) {
	OnigRegExp **regexes = malloc(sizeof(OnigRegExp *) * (count ? count : 1)); regex_t **regs = malloc(sizeof(regex_t *) * (count ? count : 1));
	for (int i = 0; i < count; i++) {
		regexes[i] = create_regexp(patterns[i], lengths[i], err, errlen);
		if (!regexes[i]) { for (int j = 0; j < i; j++) { free_regexp(regexes[j]); } free(regexes); free(regs); return NULL; }
		regs[i] = regexes[i]->regex;
	}
	OnigScanner *s = malloc(sizeof *s);
	onig_regset_new(&s->rset, count, regs); free(regs);
	s->regexes = regexes; s->count = count; return s;
}
static void n_free(void *h) { OnigScanner *s = h; for (int i = 0; i < s->count; i++) { free_regexp(s->regexes[i]); } free(s->regexes); onig_regset_free(s->rset); free(s); }

static OnigOptionType to_onig_option(int o) {
	OnigOptionType r = ONIG_OPTION_NONE;
	if (o & 1) { r |= ONIG_OPTION_NOT_BEGIN_STRING; } if (o & 2) { r |= ONIG_OPTION_NOT_END_STRING; } if (o & 4) { r |= ONIG_OPTION_NOT_BEGIN_POSITION; }
	return r;
}
static const int *n_find(void *h, int cacheId, const unsigned char *str, int len, int position, int option) {
	OnigScanner *s = h; OnigOptionType opt = to_onig_option(option);
	if (len < 1000) {                                                /* short strings: the RegSet API is faster; long ones benefit from caching */
		int bestLoc = 0;
		int idx = onig_regset_search(s->rset, str, str + len, str + position, str + len, ONIG_REGSET_POSITION_LEAD, opt, &bestLoc);
		if (idx < 0) { return NULL; }
		return encode_region(onig_regset_get_region(s->rset, idx), idx);
	}
	int bestLoc = 0, bestIdx = 0; OnigRegion *best = NULL;
	for (int i = 0; i < s->count; i++) {
		OnigRegion *r = search_cached(s->regexes[i], cacheId, str, len, position, opt);
		if (r != NULL && r->num_regs > 0) {
			int loc = r->beg[0];
			if (best == NULL || loc < bestLoc) { bestLoc = loc; best = r; bestIdx = i; }
			if (loc == position) { break; }
		}
	}
	return best ? encode_region(best, bestIdx) : NULL;
}
const OnigEngine onig_engine_native = { "native libonig 6.9.8", n_init, n_create, n_free, n_find };
