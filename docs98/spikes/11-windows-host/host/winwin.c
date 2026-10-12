/* spike:win — a native Win32 window for the software renderer: blit the framebuffer with GDI, deliver mouse / keyboard / size events to JavaScript.
 * Only GDI and plain window messages (user32 + gdi32, Windows 95 era API surface, W-suffixed functions as on NT: Windows 9x would need the A variants). No D3D, no DWM, no Aero.
 *
 * The message pump runs inside QuickJS's event loop: the patched libc (patch_libc.py) waits with MsgWaitForMultipleObjects while a window exists and calls win_pump() when
 * messages arrive, so timers, pipes and window events interleave on one thread. JavaScript is called straight from the window procedure (never while JS is running: the
 * pump is only reached from the event loop).
 *
 * JS API (module spike:win):
 *   create(width, height, title) -> id           top-level window with a client area of exactly width x height
 *   setHandler(fn)                               fn(windowId, type, a, b, c, d, mods); mods: 1 shift, 2 ctrl, 4 alt, 8 win, 16 caps lock
 *   present(id, rgba:ArrayBuffer|TypedArray, w, h, x, y, rw, rh)   copy the rectangle (x,y,rw,rh) of an RGBA w*h image into the window and show it
 *   setTitle(id, s) / setCursor(id, name) / size(id) -> [w,h] / destroy(id) / screenSize() -> [w,h] / clipboardGet() / clipboardSet(s)
 * events: 'mousemove'(x,y,buttons) 'mousedown'(x,y,button,buttons) 'mouseup'(...) 'dblclick'(x,y,button) 'wheel'(x,y,delta,horizontal) 'keydown'(vk,scan,extended,repeat) 'keyup'(vk,scan,extended)
 *         'char'(codepoint) 'resize'(w,h) 'focus'(1|0) 'close' 'paint' 'leave' */
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <windowsx.h>
#include <stdlib.h>
#include <string.h>
#include "quickjs.h"
#include "quickjs-libc.h"
#include "winhook.h"

#define MAXWIN 16
typedef struct Win { HWND hwnd; HDC memdc; HBITMAP dib, old; uint32_t *bits; int w, h; int tracking; HCURSOR cursor; wchar_t high; } Win;
static Win *wins[MAXWIN];
static JSContext *g_ctx; static JSValue g_handler = JS_UNDEFINED;
static const wchar_t *CLASSNAME = L"vscode98.window";

static Win *by_hwnd(HWND h) { for (int i = 0; i < MAXWIN; i++) { if (wins[i] && wins[i]->hwnd == h) { return wins[i]; } } return NULL; }
static int id_of(Win *w) { for (int i = 0; i < MAXWIN; i++) { if (wins[i] == w) { return i + 1; } } return 0; }
static void emit(Win *w, const char *type, int a, int b, int c, int d) {
	if (JS_IsUndefined(g_handler)) { return; }
	int mods = ((GetKeyState(VK_SHIFT) & 0x8000) ? 1 : 0) | ((GetKeyState(VK_CONTROL) & 0x8000) ? 2 : 0) | ((GetKeyState(VK_MENU) & 0x8000) ? 4 : 0) | (((GetKeyState(VK_LWIN) | GetKeyState(VK_RWIN)) & 0x8000) ? 8 : 0) | ((GetKeyState(VK_CAPITAL) & 1) ? 16 : 0);
	JSValue args[7] = { JS_NewInt32(g_ctx, id_of(w)), JS_NewString(g_ctx, type), JS_NewInt32(g_ctx, a), JS_NewInt32(g_ctx, b), JS_NewInt32(g_ctx, c), JS_NewInt32(g_ctx, d), JS_NewInt32(g_ctx, mods) };
	JSValue r = JS_Call(g_ctx, g_handler, JS_UNDEFINED, 7, args);
	if (JS_IsException(r)) { js_std_dump_error(g_ctx); }
	JS_FreeValue(g_ctx, r); for (int i = 0; i < 7; i++) { JS_FreeValue(g_ctx, args[i]); }
}
static int buttons_state(WPARAM wp) { return (wp & MK_LBUTTON ? 1 : 0) | (wp & MK_RBUTTON ? 2 : 0) | (wp & MK_MBUTTON ? 4 : 0); }
static void alloc_dib(Win *w, int cw, int ch) {
	if (w->dib) { SelectObject(w->memdc, w->old); DeleteObject(w->dib); w->dib = NULL; }
	BITMAPINFO bi; memset(&bi, 0, sizeof bi); bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER); bi.bmiHeader.biWidth = cw; bi.bmiHeader.biHeight = -ch; bi.bmiHeader.biPlanes = 1; bi.bmiHeader.biBitCount = 32; bi.bmiHeader.biCompression = BI_RGB;
	void *bits = NULL; w->dib = CreateDIBSection(w->memdc, &bi, DIB_RGB_COLORS, &bits, NULL, 0); w->bits = bits; w->old = SelectObject(w->memdc, w->dib); w->w = cw; w->h = ch;
	if (w->bits) { memset(w->bits, 0x1f, (size_t)cw * ch * 4); }
}

static LRESULT CALLBACK wndproc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
	Win *w = by_hwnd(hwnd); if (!w) { return DefWindowProcW(hwnd, msg, wp, lp); }
	switch (msg) {
	case WM_PAINT: { PAINTSTRUCT ps; HDC dc = BeginPaint(hwnd, &ps); if (w->dib) { BitBlt(dc, ps.rcPaint.left, ps.rcPaint.top, ps.rcPaint.right - ps.rcPaint.left, ps.rcPaint.bottom - ps.rcPaint.top, w->memdc, ps.rcPaint.left, ps.rcPaint.top, SRCCOPY); } EndPaint(hwnd, &ps); emit(w, "paint", 0, 0, 0, 0); return 0; }
	case WM_ERASEBKGND: return 1;
	case WM_SIZE: if (wp != SIZE_MINIMIZED) { int cw = LOWORD(lp), ch = HIWORD(lp); if (cw > 0 && ch > 0 && (cw != w->w || ch != w->h)) { alloc_dib(w, cw, ch); emit(w, "resize", cw, ch, 0, 0); } } return 0;
	case WM_CLOSE: emit(w, "close", 0, 0, 0, 0); return 0;                                    /* JS decides (destroy) */
	case WM_SETFOCUS: emit(w, "focus", 1, 0, 0, 0); return 0;
	case WM_KILLFOCUS: emit(w, "focus", 0, 0, 0, 0); return 0;
	case WM_SETCURSOR: if (LOWORD(lp) == HTCLIENT && w->cursor) { SetCursor(w->cursor); return TRUE; } break;
	case WM_MOUSEMOVE: {
		if (!w->tracking) { TRACKMOUSEEVENT t = { sizeof t, TME_LEAVE, hwnd, 0 }; TrackMouseEvent(&t); w->tracking = 1; }
		emit(w, "mousemove", GET_X_LPARAM(lp), GET_Y_LPARAM(lp), buttons_state(wp), 0); return 0; }
	case WM_MOUSELEAVE: w->tracking = 0; emit(w, "leave", 0, 0, 0, 0); return 0;
	case WM_LBUTTONDOWN: case WM_RBUTTONDOWN: case WM_MBUTTONDOWN: SetCapture(hwnd); emit(w, "mousedown", GET_X_LPARAM(lp), GET_Y_LPARAM(lp), msg == WM_LBUTTONDOWN ? 0 : msg == WM_MBUTTONDOWN ? 1 : 2, buttons_state(wp)); return 0;
	case WM_LBUTTONUP: case WM_RBUTTONUP: case WM_MBUTTONUP: if (!(wp & (MK_LBUTTON | MK_RBUTTON | MK_MBUTTON))) { ReleaseCapture(); } emit(w, "mouseup", GET_X_LPARAM(lp), GET_Y_LPARAM(lp), msg == WM_LBUTTONUP ? 0 : msg == WM_MBUTTONUP ? 1 : 2, buttons_state(wp)); return 0;
	case WM_LBUTTONDBLCLK: case WM_RBUTTONDBLCLK: case WM_MBUTTONDBLCLK: SetCapture(hwnd); emit(w, "dblclick", GET_X_LPARAM(lp), GET_Y_LPARAM(lp), msg == WM_LBUTTONDBLCLK ? 0 : msg == WM_MBUTTONDBLCLK ? 1 : 2, buttons_state(wp)); return 0;
	case WM_MOUSEWHEEL: case WM_MOUSEHWHEEL: { POINT p = { GET_X_LPARAM(lp), GET_Y_LPARAM(lp) }; ScreenToClient(hwnd, &p); emit(w, "wheel", p.x, p.y, GET_WHEEL_DELTA_WPARAM(wp), msg == WM_MOUSEHWHEEL); return 0; }
	case WM_KEYDOWN: case WM_SYSKEYDOWN: emit(w, "keydown", (int)wp, (lp >> 16) & 0xff, (lp >> 24) & 1, (lp & 0x40000000) ? 1 : 0); if (msg == WM_SYSKEYDOWN && wp != VK_F10 && wp != VK_MENU) { /* Alt+key combos are the application's, but F4 closes */ if (wp == VK_F4) { break; } return 0; } return 0;
	case WM_KEYUP: case WM_SYSKEYUP: emit(w, "keyup", (int)wp, (lp >> 16) & 0xff, (lp >> 24) & 1, 0); return 0;
	case WM_CHAR: { wchar_t c = (wchar_t)wp; if (c >= 0xD800 && c < 0xDC00) { w->high = c; return 0; } int cp = c; if (c >= 0xDC00 && c < 0xE000 && w->high) { cp = 0x10000 + ((w->high - 0xD800) << 10) + (c - 0xDC00); } w->high = 0; if (cp >= 0x20 || cp == '\r' || cp == '\t' || cp == '\b') { emit(w, "char", cp, 0, 0, 0); } return 0; }
	case WM_SYSCHAR: return 0;
	case WM_DESTROY: for (int i = 0; i < MAXWIN; i++) { if (wins[i] == w) { if (w->dib) { SelectObject(w->memdc, w->old); DeleteObject(w->dib); } DeleteDC(w->memdc); free(w); wins[i] = NULL; } } return 0;
	}
	return DefWindowProcW(hwnd, msg, wp, lp);
}

static wchar_t *wide(const char *s) { int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0); wchar_t *w = malloc((n + 1) * sizeof(wchar_t)); MultiByteToWideChar(CP_UTF8, 0, s, -1, w, n + 1); return w; }
static char *narrow(const wchar_t *w) { int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL); char *s = malloc(n + 1); WideCharToMultiByte(CP_UTF8, 0, w, -1, s, n + 1, NULL, NULL); return s; }
static Win *get_win(JSContext *ctx, JSValueConst v) { int id = 0; JS_ToInt32(ctx, &id, v); return id >= 1 && id <= MAXWIN ? wins[id - 1] : NULL; }
static int registered;

static JSValue js_create(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	int cw = 1280, ch = 800; JS_ToInt32(ctx, &cw, argv[0]); JS_ToInt32(ctx, &ch, argv[1]); const char *t = argc > 2 ? JS_ToCString(ctx, argv[2]) : NULL; wchar_t *title = wide(t ? t : "vscode98"); if (t) { JS_FreeCString(ctx, t); }
	if (!registered) {
		typedef BOOL (WINAPI *SetDpiAware)(void); SetDpiAware f = (SetDpiAware)GetProcAddress(GetModuleHandleW(L"user32.dll"), "SetProcessDPIAware"); if (f) { f(); }   /* Vista+: no bitmap scaling of our pixels */
		WNDCLASSEXW wc; memset(&wc, 0, sizeof wc); wc.cbSize = sizeof wc; wc.style = CS_DBLCLKS; wc.lpfnWndProc = wndproc; wc.hInstance = GetModuleHandleW(NULL); wc.hCursor = LoadCursor(NULL, IDC_ARROW); wc.lpszClassName = CLASSNAME;
		if (!RegisterClassExW(&wc)) { free(title); return JS_ThrowInternalError(ctx, "RegisterClassEx failed (%lu)", GetLastError()); } registered = 1;
	}
	int slot = -1; for (int i = 0; i < MAXWIN; i++) { if (!wins[i]) { slot = i; break; } } if (slot < 0) { free(title); return JS_ThrowInternalError(ctx, "too many windows"); }
	Win *w = calloc(1, sizeof(Win)); wins[slot] = w; g_ctx = ctx;
	RECT r = { 0, 0, cw, ch }; DWORD style = WS_OVERLAPPEDWINDOW; AdjustWindowRectEx(&r, style, FALSE, 0);
	w->hwnd = CreateWindowExW(0, CLASSNAME, title, style, CW_USEDEFAULT, CW_USEDEFAULT, r.right - r.left, r.bottom - r.top, NULL, NULL, GetModuleHandleW(NULL), NULL); free(title);
	if (!w->hwnd) { DWORD e = GetLastError(); wins[slot] = NULL; free(w); return JS_ThrowInternalError(ctx, "CreateWindow failed (%lu)", e); }
	HDC dc = GetDC(w->hwnd); w->memdc = CreateCompatibleDC(dc); ReleaseDC(w->hwnd, dc); alloc_dib(w, cw, ch);
	ShowWindow(w->hwnd, SW_SHOW); UpdateWindow(w->hwnd);
	return JS_NewInt32(ctx, slot + 1);
}
static JSValue js_set_handler(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) { JS_FreeValue(ctx, g_handler); g_handler = JS_IsFunction(ctx, argv[0]) ? JS_DupValue(ctx, argv[0]) : JS_UNDEFINED; g_ctx = ctx; return JS_UNDEFINED; }
static JSValue js_present(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	Win *w = get_win(ctx, argv[0]); if (!w || !w->bits) { return JS_NewInt32(ctx, -1); }
	size_t size = 0, off = 0, len = 0, bpe = 0; uint8_t *src; JSValue ab = JS_GetTypedArrayBuffer(ctx, argv[1], &off, &len, &bpe);
	if (!JS_IsException(ab)) { src = JS_GetArrayBuffer(ctx, &size, ab); JS_FreeValue(ctx, ab); if (!src) { return JS_EXCEPTION; } src += off; } else { JS_FreeValue(ctx, JS_GetException(ctx)); src = JS_GetArrayBuffer(ctx, &size, argv[1]); if (!src) { return JS_EXCEPTION; } }
	int iw, ih, x, y, rw, rh; JS_ToInt32(ctx, &iw, argv[2]); JS_ToInt32(ctx, &ih, argv[3]); JS_ToInt32(ctx, &x, argv[4]); JS_ToInt32(ctx, &y, argv[5]); JS_ToInt32(ctx, &rw, argv[6]); JS_ToInt32(ctx, &rh, argv[7]);
	if (x < 0) { rw += x; x = 0; } if (y < 0) { rh += y; y = 0; } if (x + rw > iw) { rw = iw - x; } if (y + rh > ih) { rh = ih - y; } if (x + rw > w->w) { rw = w->w - x; } if (y + rh > w->h) { rh = w->h - y; }
	if (rw <= 0 || rh <= 0) { return JS_NewInt32(ctx, 0); }
	for (int j = 0; j < rh; j++) {                                                                  /* RGBA -> 0x00RRGGBB (little-endian BGRA in memory) */
		const uint8_t *s = src + ((size_t)(y + j) * iw + x) * 4; uint32_t *d = w->bits + (size_t)(y + j) * w->w + x;
		for (int i = 0; i < rw; i++, s += 4) { d[i] = ((uint32_t)s[0] << 16) | ((uint32_t)s[1] << 8) | s[2]; }
	}
	RECT rc = { x, y, x + rw, y + rh }; InvalidateRect(w->hwnd, &rc, FALSE); UpdateWindow(w->hwnd);
	return JS_NewInt32(ctx, 0);
}
static JSValue js_set_title(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) { Win *w = get_win(ctx, argv[0]); const char *s = JS_ToCString(ctx, argv[1]); if (w && s) { wchar_t *t = wide(s); SetWindowTextW(w->hwnd, t); free(t); } if (s) { JS_FreeCString(ctx, s); } return JS_UNDEFINED; }
static JSValue js_set_cursor(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	Win *w = get_win(ctx, argv[0]); const char *s = JS_ToCString(ctx, argv[1]); if (!w || !s) { if (s) { JS_FreeCString(ctx, s); } return JS_UNDEFINED; }
	LPCTSTR id = IDC_ARROW; if (!strcmp(s, "pointer")) { id = IDC_HAND; } else if (!strcmp(s, "text")) { id = IDC_IBEAM; } else if (!strcmp(s, "ew-resize") || !strcmp(s, "col-resize")) { id = IDC_SIZEWE; } else if (!strcmp(s, "ns-resize") || !strcmp(s, "row-resize")) { id = IDC_SIZENS; }
	else if (!strcmp(s, "move") || !strcmp(s, "grab")) { id = IDC_SIZEALL; } else if (!strcmp(s, "wait")) { id = IDC_WAIT; } else if (!strcmp(s, "not-allowed")) { id = IDC_NO; } else if (!strcmp(s, "crosshair")) { id = IDC_CROSS; }
	JS_FreeCString(ctx, s); w->cursor = LoadCursor(NULL, id); POINT p; GetCursorPos(&p); if (WindowFromPoint(p) == w->hwnd) { SetCursor(w->cursor); } return JS_UNDEFINED;
}
static JSValue js_size(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) { Win *w = get_win(ctx, argv[0]); JSValue a = JS_NewArray(ctx); JS_SetPropertyUint32(ctx, a, 0, JS_NewInt32(ctx, w ? w->w : 0)); JS_SetPropertyUint32(ctx, a, 1, JS_NewInt32(ctx, w ? w->h : 0)); return a; }
static JSValue js_destroy(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) { Win *w = get_win(ctx, argv[0]); if (w) { DestroyWindow(w->hwnd); } return JS_UNDEFINED; }
static JSValue js_screen_size(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) { JSValue a = JS_NewArray(ctx); JS_SetPropertyUint32(ctx, a, 0, JS_NewInt32(ctx, GetSystemMetrics(SM_CXSCREEN))); JS_SetPropertyUint32(ctx, a, 1, JS_NewInt32(ctx, GetSystemMetrics(SM_CYSCREEN))); return a; }
static JSValue js_clipboard_get(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	if (!OpenClipboard(NULL)) { return JS_NULL; } JSValue r = JS_NULL; HANDLE h = GetClipboardData(CF_UNICODETEXT);
	if (h) { wchar_t *p = GlobalLock(h); if (p) { char *s = narrow(p); r = JS_NewString(ctx, s); free(s); GlobalUnlock(h); } } CloseClipboard(); return r;
}
static JSValue js_clipboard_set(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	const char *s = JS_ToCString(ctx, argv[0]); if (!s) { return JS_EXCEPTION; } wchar_t *w = wide(s); JS_FreeCString(ctx, s); size_t n = (wcslen(w) + 1) * sizeof(wchar_t);
	HGLOBAL g = GlobalAlloc(GMEM_MOVEABLE, n); if (g) { memcpy(GlobalLock(g), w, n); GlobalUnlock(g); if (OpenClipboard(NULL)) { EmptyClipboard(); SetClipboardData(CF_UNICODETEXT, g); CloseClipboard(); } else { GlobalFree(g); } } free(w); return JS_UNDEFINED;
}

/* event loop hooks (winhook.h) */
static int win_wants_messages(void) { for (int i = 0; i < MAXWIN; i++) { if (wins[i]) { return 1; } } return 0; }
static void win_pump(JSContext *ctx) { MSG m; g_ctx = ctx; while (PeekMessageW(&m, NULL, 0, 0, PM_REMOVE)) { if (m.message == WM_QUIT) { continue; } TranslateMessage(&m); DispatchMessageW(&m); } }

static const JSCFunctionListEntry funcs[] = {
	JS_CFUNC_DEF("create", 3, js_create), JS_CFUNC_DEF("setHandler", 1, js_set_handler), JS_CFUNC_DEF("present", 8, js_present), JS_CFUNC_DEF("setTitle", 2, js_set_title), JS_CFUNC_DEF("setCursor", 2, js_set_cursor),
	JS_CFUNC_DEF("size", 1, js_size), JS_CFUNC_DEF("destroy", 1, js_destroy), JS_CFUNC_DEF("screenSize", 0, js_screen_size), JS_CFUNC_DEF("clipboardGet", 0, js_clipboard_get), JS_CFUNC_DEF("clipboardSet", 1, js_clipboard_set),
};
static int win_init(JSContext *ctx, JSModuleDef *m) { return JS_SetModuleExportList(ctx, m, funcs, sizeof funcs / sizeof funcs[0]); }
void spike_init_win(JSContext *ctx) {
	js_win_waiter.wants_messages = win_wants_messages; js_win_waiter.pump = win_pump;
	JSModuleDef *m = JS_NewCModule(ctx, "spike:win", win_init); if (m) { JS_AddModuleExportList(ctx, m, funcs, sizeof funcs / sizeof funcs[0]); }
}
