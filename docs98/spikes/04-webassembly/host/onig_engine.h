#ifndef ONIG_ENGINE_H
#define ONIG_ENGINE_H
/* The matching engine behind the JS OnigScanner. Two implementations exist: native libonig (onig_native.c) and the same onig.wasm
 * that ships with VS Code translated to C by wasm2c (onig_w2c.c). The JS layer (onig_js.c) is shared, so both expose identical behaviour. */
typedef struct OnigEngine {
	const char *name;
	int  (*init)(void);                                            /* one-time setup; 0 on success */
	/* patterns are UTF-8; returns an opaque scanner handle, or NULL with a message in err */
	void *(*create_scanner)(const unsigned char **patterns, const int *lengths, int count, char *err, int errlen);
	void (*free_scanner)(void *scanner);
	/* Finds the earliest-matching pattern at/after `position` (byte offset). Returns NULL if none, else a pointer to
	 * [patternIndex, numRegs, beg0, end0, beg1, end1, ...] valid until the next call. Options: 1 NOT_BEGIN_STRING, 2 NOT_END_STRING, 4 NOT_BEGIN_POSITION. */
	const int *(*find)(void *scanner, int strCacheId, const unsigned char *data, int length, int position, int option);
} OnigEngine;
extern const OnigEngine onig_engine_native;
extern const OnigEngine onig_engine_wasm2c;
#endif
