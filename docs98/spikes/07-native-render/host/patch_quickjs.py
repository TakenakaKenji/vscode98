#!/usr/bin/env python3
"""Writes a copy of QuickJS-ng's quickjs.c with the hooks of the sampling profiler (prof98.h, included at the end) and the collector's schedule (gc98.h). Usage: patch_quickjs.py <in> <out>
- the C call paths link a frame into rt->current_stack_frame only after its cur_func is set (stock QuickJS links it first), behind a compiler barrier, so a
  sample never reads a frame that is half set up;
- C function names are recorded where C functions are created, and the names methods and anonymous functions get at run time; bytecode about to be freed is reported (samples naming it are resolved first);
- labels for the garbage collector and the parser; the ring of raw samples is drained from js_poll_interrupts when half full; sampling stops before the
  runtime is freed."""
import sys
src = open(sys.argv[1]).read()
def definition(after):
    """index of the definition of `after` (a function head), skipping forward declarations"""
    i = src.index(after)
    while True:
        k = src.index(")", i)
        while src[k + 1:k + 2] != "\n" and src[k + 1:k + 2] != ";":
            k = src.index(")", k + 1)
        if src[k + 1:k + 3] == "\n{":
            return i
        i = src.index(after, i + 1)
def sub(old, new, after, count=1):
    global src
    i = definition(after) if after.endswith("(") else src.index(after)
    for _ in range(count):
        j = src.index(old, i)
        src = src[:j] + new + src[j + len(old):]
        i = j + len(new)
decl = ('#include "dtoa.h"\n'
        'struct JSFunctionBytecode;\n'
        'static void pf_reg(JSContext *ctx, const void *func, int magic, const char *name);\n'
        'static void pf_bytecode_freed(JSRuntime *rt, struct JSFunctionBytecode *b);\n'
        'static void pf_poll(JSContext *ctx);\n'
        'static void pf_name_hint(JSContext *ctx, JSValueConst func, JSAtom name, int flags);\n'
        'static void pf_runtime_freed(JSRuntime *rt);\n'
        'static inline void pf_barrier(void);\n'
        'int js98_pf_tag_push(const char *label);\n'
        'void js98_pf_tag_pop(int pushed);\n'
        'static void gc98_after(JSRuntime *rt);\n'
        'static void gc98_forced_run(void);\n'
        'static void gc98_census(JSRuntime *rt);\n')
assert src.count('#include "dtoa.h"\n') == 1
src = src.replace('#include "dtoa.h"\n', decl)
# the three C call paths: link the frame after cur_func and arg_count are set
push = "    prev_sf = rt->current_stack_frame;\n    sf->prev_frame = prev_sf;\n    rt->current_stack_frame = sf;\n"
for fn in ("static JSValue js_call_c_function_data(", "static JSValue js_call_c_closure(", "static JSValue js_call_c_function("):
    sub(push, "    prev_sf = rt->current_stack_frame;\n    sf->prev_frame = prev_sf;\n", fn)
    sub("    sf->arg_count = argc;\n", "    sf->arg_count = argc;\n    pf_barrier(); rt->current_stack_frame = sf;\n", fn)
assert src.count("pf_barrier(); rt->current_stack_frame = sf;") == 3
# bytecode frames: cur_func is set before the frame is linked; keep the compiler from moving it after
sub("    sf->prev_frame = rt->current_stack_frame;\n    rt->current_stack_frame = sf;\n    ctx = b->realm; /* set the current realm */",
    "    sf->prev_frame = rt->current_stack_frame;\n    pf_barrier(); rt->current_stack_frame = sf;\n    ctx = b->realm; /* set the current realm */", "static JSValue JS_CallInternal(")
sub("            sf->prev_frame = rt->current_stack_frame;\n            rt->current_stack_frame = sf;\n",
    "            sf->prev_frame = rt->current_stack_frame;\n            pf_barrier(); rt->current_stack_frame = sf;\n", "static JSValue JS_CallInternal(")
# names of C functions
sub("    p->u.cfunc.magic = magic;\n", "    p->u.cfunc.magic = magic;\n    pf_reg(ctx, (const void *)func, magic, name);\n", "JSValue JS_NewCFunction3(")
sub("    s->magic = magic;\n", "    s->magic = magic;\n    pf_reg(ctx, (const void *)func, magic, name);\n", "JSValue JS_NewCFunctionData2(")
sub("    s->magic = magic;\n", "    s->magic = magic;\n    pf_reg(ctx, (const void *)func, magic, name);\n", "JSValue JS_NewCClosure(")
# names that methods and anonymous functions get at run time (QuickJS leaves their bytecode unnamed)
sub("{\n    JSValue name_str;\n\n    name_str = js_get_function_name(ctx, name);\n", "{\n    JSValue name_str;\n\n    pf_name_hint(ctx, func_obj, name, flags);\n    name_str = js_get_function_name(ctx, name);\n", "static int js_method_set_properties(")
sub("{\n    if (name != JS_ATOM_NULL\n", "{\n    pf_name_hint(ctx, obj, name, 0);\n    if (name != JS_ATOM_NULL\n", "static int JS_DefineObjectName(")
sub("{\n    int i;\n\n", "{\n    int i;\n\n    pf_bytecode_freed(rt, b);\n", "static void free_function_bytecode(JSRuntime *rt, JSFunctionBytecode *b)\n{")
sub("    ctx->interrupt_counter = JS_INTERRUPT_COUNTER_INIT;\n", "    ctx->interrupt_counter = JS_INTERRUPT_COUNTER_INIT;\n    pf_poll(ctx);\n", "static no_inline __exception int __js_poll_interrupts(")
sub("    gc_decref(rt);\n", "    int pf_t = js98_pf_tag_push(\"[gc]\");\n    gc_decref(rt);\n", "void JS_RunGC(JSRuntime *rt)\n{")
sub("    gc_free_cycles(rt);\n}\n", "    gc98_census(rt);\n    gc_free_cycles(rt);\n    js98_pf_tag_pop(pf_t);\n}\n", "void JS_RunGC(JSRuntime *rt)\n{")
sub("    err = js_parse_program(s);\n", "    { int pf_t = js98_pf_tag_push(\"[compile]\"); err = js_parse_program(s); js98_pf_tag_pop(pf_t); }\n", "static JSValue __JS_EvalInternal(")
sub("    fun_obj = js_create_function(ctx, fd);\n", "    { int pf_t = js98_pf_tag_push(\"[compile]\"); fun_obj = js_create_function(ctx, fd); js98_pf_tag_pop(pf_t); }\n", "static JSValue __JS_EvalInternal(")
sub("    rt->in_free = true;\n", "    pf_runtime_freed(rt);\n    rt->in_free = true;\n", "void JS_FreeRuntime(JSRuntime *rt)\n{")
# the collector's schedule (gc98.h): the threshold after a collection is set by gc98_after (stock: 1.5 x the heap)
sub("        JS_RunGC(rt);\n        rt->malloc_gc_threshold = rt->malloc_state.malloc_size +\n            (rt->malloc_state.malloc_size >> 1);\n", "        gc98_forced_run();\n        JS_RunGC(rt);\n        gc98_after(rt);\n", "static void js_trigger_gc(")
src += '\n#include "prof98.h"\n#include "gc98.h"\n'
open(sys.argv[2], "w").write(src)
