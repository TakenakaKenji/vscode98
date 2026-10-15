/* spike:proc for Windows: the native layer under child_process / net / process.stdin on QuickJS (same module name and the same JS-visible conventions as the POSIX
 * proc.c of spike 5: file descriptors are small integers, errors are negative errno values with LINUX numbering, EAGAIN = -11).
 *
 * What is different, and why (see ../README.md):
 *  - The stock QuickJS event loop on Windows cannot wait on pipes (docs98/spikes/05-child-process). Here the loop is extended (patch_libc.py / winhook.h): this module
 *    hands it extra HANDLEs to wait on, and is called back when one is signalled.
 *  - Pipes are NAMED pipes opened FILE_FLAG_OVERLAPPED (anonymous pipes cannot do overlapped I/O). Reads are overlapped reads into a buffer owned here and completed by the
 *    loop; writes are copied into a queue and written by overlapped WriteFile. `pipe(childEnd)` makes the child's end NON-overlapped, because a foreign process (git.exe) does
 *    synchronous I/O on its standard handles. Handles that are not overlapped (inherited std handles, console) are read by a helper thread: this also works on Windows 9x.
 *  - There are no fd numbers in a child: descriptors beyond 2 are passed by value in the environment (QJS98_FDMAP="3:<handle>:<overlapped>,...") and adopted on first use.
 *  - Child exit is a waitable process HANDLE (no SIGCHLD); kill is TerminateProcess.
 * Not done yet: TCP / unix sockets / named-pipe servers (net.js), CreateProcess for .cmd/.bat, Unicode paths on Windows 9x (needs the A APIs), more than 64 waitable handles. */
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <mmsystem.h>
#include <stdio.h>
#include <io.h>
#include <tlhelp32.h>
#include <psapi.h>
#include <stdlib.h>
#include <string.h>
#include "quickjs.h"
#include "quickjs-libc.h"
#include "winhook.h"

/* errno values as JS sees them (Linux numbering, matching the constants hard-coded in fdstreams.js) */
enum { E_NOENT = 2, E_2BIG = 7, E_NOEXEC = 8, E_IO = 5, E_BADF = 9, E_AGAIN = 11, E_NOMEM = 12, E_ACCES = 13, E_EXIST = 17, E_NOTDIR = 20, E_ISDIR = 21, E_INVAL = 22, E_MFILE = 24,
       E_PIPE = 32, E_NAMETOOLONG = 36, E_NOSYS = 38, E_ADDRINUSE = 98, E_CONNRESET = 104, E_TIMEDOUT = 110, E_CONNREFUSED = 111, E_SRCH = 3 };
static int errno_from_win(DWORD e) {
	switch (e) {
	case ERROR_FILE_NOT_FOUND: case ERROR_PATH_NOT_FOUND: case ERROR_INVALID_DRIVE: return E_NOENT;
	case ERROR_ACCESS_DENIED: case ERROR_SHARING_VIOLATION: return E_ACCES;
	case ERROR_BAD_EXE_FORMAT: case ERROR_BAD_FORMAT: return E_NOEXEC;
	case ERROR_BROKEN_PIPE: case ERROR_NO_DATA: case ERROR_PIPE_NOT_CONNECTED: return E_PIPE;
	case ERROR_NOT_ENOUGH_MEMORY: case ERROR_OUTOFMEMORY: return E_NOMEM;
	case ERROR_INVALID_HANDLE: return E_BADF;
	case ERROR_ALREADY_EXISTS: case ERROR_FILE_EXISTS: return E_EXIST;
	case ERROR_BAD_PATHNAME: case ERROR_INVALID_NAME: case ERROR_DIRECTORY: return E_NOTDIR;
	case ERROR_FILENAME_EXCED_RANGE: return E_NAMETOOLONG;
	case ERROR_TOO_MANY_OPEN_FILES: return E_MFILE;
	case ERROR_INVALID_PARAMETER: return E_INVAL;
	default: return E_IO;
	}
}

#define CHUNK 65536
#define WCAP (1024 * 1024)
#define MAXSLOT 1024
#define FIRST_FD 100

typedef struct Fd Fd;
struct Fd {
	int num; HANDLE h; int ovl;                 /* ovl: opened FILE_FLAG_OVERLAPPED (reads/writes completed by the event loop) */
	JSValue on_read, on_write;                  /* JS_UNDEFINED when unset */
	/* read side */
	uint8_t *rbuf; DWORD rlen, roff; int rpending, reof, rerr;
	OVERLAPPED rov; HANDLE rev;                 /* manual-reset: signalled when a chunk / EOF / error is ready to be taken by read() */
	HANDLE thread, twake; volatile LONG tstate; /* thread backend: 0 idle, 1 reading, 2 result ready */
	wchar_t *pipename; int is_server; int server_of;   /* shadow instances (a backlog, so that clients connecting in the same tick find a free instance) point at the listening fd */
	           /* named-pipe server: `h` is the instance waiting for a client; reads mean ConnectNamedPipe, not data */
	/* write side (overlapped handles only; others write synchronously) */
	uint8_t *wbuf; DWORD wlen; uint8_t *wq; DWORD wqlen, wqcap; int wpending, werr;
	OVERLAPPED wov; HANDLE wev; int shutting;   /* shutdown(SHUT_WR) requested: close the handle once the queued writes are out */
};
static void shutdown_finish(Fd *f);
static Fd *slots[MAXSLOT];
static JSContext *g_ctx;
static HANDLE ready_ev;                         /* kept signalled while a write handler can fire immediately */
static int next_fd = FIRST_FD;
static char *fdmap_env;                         /* QJS98_FDMAP of this process, parsed lazily */

typedef struct Proc { DWORD pid; HANDLE h; JSValue on_exit; int watching, killed; struct Proc *next; } Proc;
static Proc *procs;

/* ------------------------------------------------------------------------------------------------------------------------------------ strings */
static wchar_t *wide(const char *s) {
	int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0); wchar_t *w = malloc((n + 1) * sizeof(wchar_t)); MultiByteToWideChar(CP_UTF8, 0, s, -1, w, n + 1); return w;
}
static char *narrow(const wchar_t *w) {
	int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL); char *s = malloc(n + 1); WideCharToMultiByte(CP_UTF8, 0, w, -1, s, n + 1, NULL, NULL); return s;
}

/* ------------------------------------------------------------------------------------------------------------------------------------ slots */
static Fd *slot_new(int num, HANDLE h, int ovl) {
	if (num < 0 || num >= MAXSLOT || slots[num]) { return NULL; }
	Fd *f = calloc(1, sizeof(Fd)); f->num = num; f->server_of = -1; f->h = h; f->ovl = ovl; f->on_read = f->on_write = JS_UNDEFINED;
	f->rev = CreateEvent(NULL, TRUE, FALSE, NULL); f->wev = CreateEvent(NULL, TRUE, FALSE, NULL); f->twake = NULL;
	slots[num] = f; return f;
}
static int alloc_fd(HANDLE h, int ovl) {
	for (int i = 0; i < MAXSLOT - FIRST_FD; i++) {
		int n = FIRST_FD + (next_fd - FIRST_FD + i) % (MAXSLOT - FIRST_FD);
		if (!slots[n]) { next_fd = n + 1; if (!slot_new(n, h, ovl)) { return -E_MFILE; } return n; }
	}
	return -E_MFILE;
}
/* looks up fd; descriptors 0..2 and those listed in QJS98_FDMAP are adopted on first use */
static Fd *lookup(int fd) {
	if (fd < 0 || fd >= MAXSLOT) { return NULL; }
	if (slots[fd]) { return slots[fd]; }
	if (fd < FIRST_FD) {
		if (!fdmap_env) { const char *e = getenv("QJS98_FDMAP"); fdmap_env = _strdup(e ? e : ""); }
		char *copy = _strdup(fdmap_env), *save = NULL;
		for (char *tok = strtok_s(copy, ",", &save); tok; tok = strtok_s(NULL, ",", &save)) {
			int num = -1, ovl = 0; unsigned long long hv = 0;
			if (sscanf(tok, "%d:%llu:%d", &num, &hv, &ovl) >= 2 && num == fd) { free(copy); return slot_new(fd, (HANDLE)(ULONG_PTR)hv, ovl); }
		}
		free(copy);
		if (fd <= 2) { HANDLE h = GetStdHandle(fd == 0 ? STD_INPUT_HANDLE : fd == 1 ? STD_OUTPUT_HANDLE : STD_ERROR_HANDLE); if (h && h != INVALID_HANDLE_VALUE) { return slot_new(fd, h, 0); } }
	}
	return NULL;
}

/* ------------------------------------------------------------------------------------------------------------------------------------ reading */
static DWORD WINAPI reader_thread(LPVOID arg) {
	Fd *f = arg;
	for (;;) {
		WaitForSingleObject(f->twake, INFINITE);
		DWORD n = 0; BOOL ok = ReadFile(f->h, f->rbuf, CHUNK, &n, NULL); DWORD err = ok ? 0 : GetLastError();
		if (!ok) { if (err == ERROR_BROKEN_PIPE || err == ERROR_HANDLE_EOF || err == ERROR_PIPE_NOT_CONNECTED) { f->reof = 1; } else { f->rerr = -errno_from_win(err); } }
		else if (n == 0) { f->reof = 1; }
		else { f->rlen = n; f->roff = 0; }
		InterlockedExchange(&f->tstate, 2); SetEvent(f->rev);
	}
	return 0;
}
static void start_read(Fd *f) {
	if (f->rpending || f->rlen > f->roff || f->reof || f->rerr || f->h == INVALID_HANDLE_VALUE) { return; }
	if (f->is_server) {
		ResetEvent(f->rev); memset(&f->rov, 0, sizeof f->rov); f->rov.hEvent = f->rev;
		if (ConnectNamedPipe(f->h, &f->rov)) { f->rpending = 1; return; }
		DWORD err = GetLastError();
		if (err == ERROR_IO_PENDING) { f->rpending = 1; return; }
		if (err == ERROR_PIPE_CONNECTED) { f->rlen = 1; SetEvent(f->rev); return; }      /* a client was faster than we were */
		f->rerr = -errno_from_win(err); SetEvent(f->rev); return;
	}
	if (!f->rbuf) { f->rbuf = malloc(CHUNK); }
	ResetEvent(f->rev);
	if (!f->ovl) {                                           /* helper thread does the blocking read */
		if (!f->thread) { f->twake = CreateEvent(NULL, FALSE, FALSE, NULL); f->thread = CreateThread(NULL, 0, reader_thread, f, 0, NULL); }
		f->rpending = 1; InterlockedExchange(&f->tstate, 1); SetEvent(f->twake); return;
	}
	memset(&f->rov, 0, sizeof f->rov); f->rov.hEvent = f->rev;
	if (ReadFile(f->h, f->rbuf, CHUNK, NULL, &f->rov)) { f->rpending = 1; return; }          /* completed at once: the event is signalled, harvest() takes it */
	DWORD err = GetLastError();
	if (err == ERROR_IO_PENDING) { f->rpending = 1; return; }
	if (err == ERROR_BROKEN_PIPE || err == ERROR_HANDLE_EOF || err == ERROR_PIPE_NOT_CONNECTED) { f->reof = 1; } else { f->rerr = -errno_from_win(err); }
	SetEvent(f->rev);
}
/* moves a finished read into rlen/reof/rerr */
static void harvest(Fd *f) {
	if (!f->rpending) { return; }
	if (f->is_server) { DWORD n; if (GetOverlappedResult(f->h, &f->rov, &n, FALSE)) { f->rpending = 0; f->rlen = 1; } else if (GetLastError() != ERROR_IO_INCOMPLETE) { f->rpending = 0; f->rerr = -E_IO; } return; }
	if (!f->ovl) { if (f->tstate != 2) { return; } f->rpending = 0; return; }
	DWORD n = 0;
	if (GetOverlappedResult(f->h, &f->rov, &n, FALSE)) { f->rpending = 0; if (n == 0) { f->reof = 1; } else { f->rlen = n; f->roff = 0; } }
	else { DWORD err = GetLastError(); if (err == ERROR_IO_INCOMPLETE) { return; } f->rpending = 0; if (err == ERROR_BROKEN_PIPE || err == ERROR_HANDLE_EOF || err == ERROR_PIPE_NOT_CONNECTED) { f->reof = 1; } else { f->rerr = -errno_from_win(err); } }
}

/* ------------------------------------------------------------------------------------------------------------------------------------ writing */
static void write_kick(Fd *f) {                          /* start the next overlapped write from the queue */
	if (f->wpending || !f->wqlen) { return; }
	free(f->wbuf); f->wbuf = f->wq; f->wlen = f->wqlen; f->wq = NULL; f->wqlen = f->wqcap = 0;
	ResetEvent(f->wev); memset(&f->wov, 0, sizeof f->wov); f->wov.hEvent = f->wev;
	if (WriteFile(f->h, f->wbuf, f->wlen, NULL, &f->wov)) { f->wpending = 1; return; }
	DWORD err = GetLastError();
	if (err == ERROR_IO_PENDING) { f->wpending = 1; return; }
	f->werr = -errno_from_win(err); f->wlen = 0; SetEvent(f->wev);
}
static void write_harvest(Fd *f) {
	if (!f->wpending) { return; }
	DWORD n = 0;
	if (GetOverlappedResult(f->h, &f->wov, &n, FALSE)) { f->wpending = 0; f->wlen = 0; }
	else { DWORD err = GetLastError(); if (err == ERROR_IO_INCOMPLETE) { return; } f->wpending = 0; f->werr = -errno_from_win(err); }
	write_kick(f);
	shutdown_finish(f);
}
static int write_has_room(Fd *f) { return f->wqlen < WCAP / 2; }
/* A pipe has no half-close: shutdown(SHUT_WR) becomes "send what is queued, then close the handle"; the peer sees EOF, and so does our own reader. */
static void shutdown_finish(Fd *f) {
	if (!f->shutting || f->wpending || f->wqlen || f->h == INVALID_HANDLE_VALUE) { return; }
	if (f->ovl && f->rpending) { CancelIo(f->h); DWORD n; GetOverlappedResult(f->h, &f->rov, &n, TRUE); f->rpending = 0; }
	if (f->num > 2) { CloseHandle(f->h); } f->h = INVALID_HANDLE_VALUE; f->reof = 1; SetEvent(f->rev);
}

/* ------------------------------------------------------------------------------------------------------------------------------------ JS: descriptors */
static int arg_fd(JSContext *ctx, JSValueConst v) { int fd = -1; JS_ToInt32(ctx, &fd, v); return fd; }

static JSValue js_read(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	int fd = arg_fd(ctx, argv[0]); Fd *f = lookup(fd); if (!f) { return JS_NewInt32(ctx, -E_BADF); }
	size_t size; uint8_t *buf = JS_GetArrayBuffer(ctx, &size, argv[1]); if (!buf) { return JS_EXCEPTION; }
	int64_t off = 0, len = 0; JS_ToInt64(ctx, &off, argv[2]); JS_ToInt64(ctx, &len, argv[3]); if (off < 0 || len < 0 || (size_t)(off + len) > size) { return JS_ThrowRangeError(ctx, "read: out of range"); }
	if (f->rpending) { harvest(f); }
	if (f->rlen > f->roff) {
		DWORD n = f->rlen - f->roff; if ((int64_t)n > len) { n = (DWORD)len; }
		memcpy(buf + off, f->rbuf + f->roff, n); f->roff += n;
		if (f->roff == f->rlen) { f->rlen = f->roff = 0; if (!JS_IsUndefined(f->on_read)) { start_read(f); } else { ResetEvent(f->rev); } }
		return JS_NewInt32(ctx, (int)n);
	}
	if (f->rerr) { return JS_NewInt32(ctx, f->rerr); }
	if (f->reof) { return JS_NewInt32(ctx, 0); }
	if (!f->ovl && f->thread == NULL && GetFileType(f->h) != FILE_TYPE_PIPE) {      /* plain blocking read (files, console) when nobody asked for events */
		DWORD n = 0; if (!ReadFile(f->h, buf + off, (DWORD)len, &n, NULL)) { DWORD e = GetLastError(); return JS_NewInt32(ctx, (e == ERROR_BROKEN_PIPE || e == ERROR_HANDLE_EOF) ? 0 : -errno_from_win(e)); } return JS_NewInt32(ctx, (int)n);
	}
	start_read(f);
	return JS_NewInt32(ctx, -E_AGAIN);
}
static JSValue js_write(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	int fd = arg_fd(ctx, argv[0]); Fd *f = lookup(fd); if (!f) { return JS_NewInt32(ctx, -E_BADF); }
	size_t size; uint8_t *buf = JS_GetArrayBuffer(ctx, &size, argv[1]); if (!buf) { return JS_EXCEPTION; }
	int64_t off = 0, len = 0; JS_ToInt64(ctx, &off, argv[2]); JS_ToInt64(ctx, &len, argv[3]); if (off < 0 || len < 0 || (size_t)(off + len) > size) { return JS_ThrowRangeError(ctx, "write: out of range"); }
	if (!f->ovl) {                                                                 /* synchronous handle: write it all now */
		int64_t done = 0; while (done < len) { DWORD n = 0; if (!WriteFile(f->h, buf + off + done, (DWORD)(len - done > 1 << 20 ? 1 << 20 : len - done), &n, NULL)) { return JS_NewInt32(ctx, done ? (int)done : -errno_from_win(GetLastError())); } done += n; }
		return JS_NewInt32(ctx, (int)done);
	}
	if (f->h == INVALID_HANDLE_VALUE) { return JS_NewInt32(ctx, -E_PIPE); }
	if (f->wpending) { write_harvest(f); }
	if (f->werr) { int e = f->werr; return JS_NewInt32(ctx, e); }
	if (len == 0) { return JS_NewInt32(ctx, 0); }
	DWORD room = (DWORD)(WCAP - f->wqlen); if (f->wpending && f->wqlen >= WCAP) { return JS_NewInt32(ctx, -E_AGAIN); }
	DWORD n = (DWORD)(len < room ? len : room); if (!n) { return JS_NewInt32(ctx, -E_AGAIN); }
	if (f->wqlen + n > f->wqcap) { f->wqcap = (f->wqlen + n) * 2; if (f->wqcap < 4096) { f->wqcap = 4096; } f->wq = realloc(f->wq, f->wqcap); }
	memcpy(f->wq + f->wqlen, buf + off, n); f->wqlen += n;
	write_kick(f);
	return JS_NewInt32(ctx, (int)n);
}
static void cancel_io(Fd *f) {
	if (f->ovl && f->rpending) { CancelIo(f->h); DWORD n; GetOverlappedResult(f->h, &f->rov, &n, TRUE); f->rpending = 0; }
	if (f->ovl && f->wpending) { CancelIo(f->h); DWORD n; GetOverlappedResult(f->h, &f->wov, &n, TRUE); f->wpending = 0; }
}
static JSValue js_close(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	int fd = arg_fd(ctx, argv[0]);
	for (int i = 0; i < MAXSLOT; i++) { if (slots[i] && slots[i]->server_of == fd && fd >= 0) { JSValue a[1] = { JS_NewInt32(ctx, i) }; JS_FreeValue(ctx, js_close(ctx, JS_UNDEFINED, 1, a)); } } Fd *f = slots[fd >= 0 && fd < MAXSLOT ? fd : 0]; if (!f || f->num != fd) { return JS_NewInt32(ctx, -E_BADF); }
	if (f->ovl) { if (f->wpending) { DWORD n; GetOverlappedResult(f->h, &f->wov, &n, TRUE); f->wpending = 0; } }  /* let queued bytes reach the peer before closing */
	if (f->h != INVALID_HANDLE_VALUE) { cancel_io(f); }
	if (fd > 2 && f->h != INVALID_HANDLE_VALUE) { CloseHandle(f->h); }
	JS_FreeValue(ctx, f->on_read); JS_FreeValue(ctx, f->on_write);
	CloseHandle(f->rev); CloseHandle(f->wev);
	if (f->thread && f->tstate == 1) { /* blocked in ReadFile on a handle we no longer own: abandon the thread and its buffer until the process exits */ }
	else { free(f->rbuf); if (f->thread) { TerminateThread(f->thread, 0); CloseHandle(f->thread); CloseHandle(f->twake); } }
	free(f->wbuf); free(f->wq); free(f->pipename); slots[fd] = NULL; free(f);
	return JS_NewInt32(ctx, 0);
}
static JSValue set_handler(JSContext *ctx, JSValueConst *argv, int is_read) {
	int fd = arg_fd(ctx, argv[0]); Fd *f = lookup(fd); if (!f) { return JS_NewInt32(ctx, -E_BADF); }
	JSValue *slot = is_read ? &f->on_read : &f->on_write; JS_FreeValue(ctx, *slot);
	*slot = JS_IsFunction(ctx, argv[1]) ? JS_DupValue(ctx, argv[1]) : JS_UNDEFINED;
	if (is_read && !JS_IsUndefined(f->on_read)) { if (f->rpending) { harvest(f); } start_read(f); }
	return JS_UNDEFINED;
}
static JSValue js_set_read_handler(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) { return set_handler(ctx, argv, 1); }
static JSValue js_set_write_handler(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) { return set_handler(ctx, argv, 0); }

/* ------------------------------------------------------------------------------------------------------------------------------------ pipes */
static int pipe_counter;
/* Creates a named-pipe pair. dir: 0 = unidirectional [read end, write end], 1 = duplex. childEnd: -1 both ends overlapped; 0 or 1 = that end (read / write) is created
 * NON-overlapped (for a foreign child process). Returns 0 and the two handles, or -errno. */
static int make_pipe(int duplex, int child_end, HANDLE *a, HANDLE *b, int *a_ovl, int *b_ovl) {
	wchar_t name[96]; swprintf(name, 96, L"\\\\.\\pipe\\qjs98.%lu.%d.%lu", GetCurrentProcessId(), ++pipe_counter, GetTickCount());
	/* the server end is created overlapped; which end it is depends on who the child is: [read end, write end] */
	int srv_reads = duplex || child_end != 0;                                              /* child reads (0): the server is the write end, ours */
	DWORD smode = duplex ? PIPE_ACCESS_DUPLEX : (srv_reads ? PIPE_ACCESS_INBOUND : PIPE_ACCESS_OUTBOUND);
	HANDLE srv = CreateNamedPipeW(name, smode | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT, 1, CHUNK, CHUNK, 0, NULL);
	if (srv == INVALID_HANDLE_VALUE) { return -errno_from_win(GetLastError()); }
	int client_ovl = duplex || child_end < 0;                                              /* a foreign child needs a synchronous handle */
	DWORD access = duplex ? (GENERIC_READ | GENERIC_WRITE) : (srv_reads ? GENERIC_WRITE : GENERIC_READ);
	HANDLE cli = CreateFileW(name, access, 0, NULL, OPEN_EXISTING, client_ovl ? FILE_FLAG_OVERLAPPED : FILE_ATTRIBUTE_NORMAL, NULL);
	if (cli == INVALID_HANDLE_VALUE) { DWORD e = GetLastError(); CloseHandle(srv); return -errno_from_win(e); }
	if (!ConnectNamedPipe(srv, NULL)) { DWORD e = GetLastError(); if (e != ERROR_PIPE_CONNECTED) { CloseHandle(srv); CloseHandle(cli); return -errno_from_win(e); } }
	if (duplex) { *a = srv; *b = cli; *a_ovl = 1; *b_ovl = 1; return 0; }
	if (srv_reads) { *a = srv; *b = cli; *a_ovl = 1; *b_ovl = client_ovl; }               /* [read = server (ours), write = client] */
	else { *a = cli; *b = srv; *a_ovl = client_ovl; *b_ovl = 1; }                          /* [read = client (child's), write = server (ours)] */
	return 0;
}
static JSValue pair_result(JSContext *ctx, int duplex, int child_end) {
	HANDLE a, b; int ao, bo; int r = make_pipe(duplex, child_end, &a, &b, &ao, &bo); if (r < 0) { return JS_NewInt32(ctx, r); }
	int fa = alloc_fd(a, ao), fb = alloc_fd(b, bo);
	JSValue arr = JS_NewArray(ctx); JS_SetPropertyUint32(ctx, arr, 0, JS_NewInt32(ctx, fa)); JS_SetPropertyUint32(ctx, arr, 1, JS_NewInt32(ctx, fb)); return arr;
}
static JSValue js_pipe(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) { int ce = -1; if (argc > 0) { JS_ToInt32(ctx, &ce, argv[0]); } return pair_result(ctx, 0, ce); }
static JSValue js_socketpair(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) { return pair_result(ctx, 1, -1); }

/* ------------------------------------------------------------------------------------------------------------------------------------ processes */
static void quote_arg(const char *s, char **out, size_t *len, size_t *cap) {         /* the Microsoft C runtime's argv parsing rules (as libuv's quote_cmd_arg) */
#define PUT(c) do { if (*len + 2 > *cap) { *cap = *cap * 2 + 64; *out = realloc(*out, *cap); } (*out)[(*len)++] = (c); } while (0)
	int need_quote = !*s || strpbrk(s, " \t\"\n\v") != NULL;
	if (!need_quote) { for (; *s; s++) { PUT(*s); } return; }
	PUT('"'); int bs = 0;
	for (; *s; s++) {
		if (*s == '\\') { bs++; PUT('\\'); }
		else if (*s == '"') { for (int i = 0; i <= bs; i++) { PUT('\\'); } bs = 0; PUT('"'); }
		else { bs = 0; PUT(*s); }
	}
	for (int i = 0; i < bs; i++) { PUT('\\'); }
	PUT('"');
#undef PUT
}
static wchar_t *build_env(char **envp, const char *fdmap) {                           /* "K=V" strings -> double-NUL terminated UTF-16 block, with QJS98_FDMAP replaced */
	size_t total = 1; char **v = envp; int n = 0; while (v && v[n]) { n++; }
	wchar_t **ws = calloc(n + 2, sizeof(wchar_t *)); int cnt = 0;
	for (int i = 0; i < n; i++) { if (_strnicmp(envp[i], "QJS98_FDMAP=", 12) == 0) { continue; } ws[cnt] = wide(envp[i]); total += wcslen(ws[cnt++]) + 1; }
	char tmp[2048]; snprintf(tmp, sizeof tmp, "QJS98_FDMAP=%s", fdmap); ws[cnt] = wide(tmp); total += wcslen(ws[cnt++]) + 1;
	wchar_t *block = malloc(total * sizeof(wchar_t)), *p = block;
	for (int i = 0; i < cnt; i++) { size_t l = wcslen(ws[i]); memcpy(p, ws[i], l * sizeof(wchar_t)); p += l; *p++ = 0; free(ws[i]); }
	*p = 0; free(ws); return block;
}
static const char *env_lookup(char **envp, const char *key) { size_t kl = strlen(key); for (char **e = envp; e && *e; e++) { if (_strnicmp(*e, key, kl) == 0 && (*e)[kl] == '=') { return *e + kl + 1; } } return NULL; }
static int file_exists(const wchar_t *p) { DWORD a = GetFileAttributesW(p); return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY); }
/* search `file` (+ .exe / .com) on the PATH of the child's environment, like libuv: returns a malloc'd wide path or NULL */
static wchar_t *resolve_exe(const char *file, char **envp, const char *cwd) {
	wchar_t *wf = wide(file); int has_sep = strpbrk(file, "/\\:") != NULL, has_ext = strrchr(file, '.') && strrchr(file, '.') > (strrchr(file, '\\') > strrchr(file, '/') ? strrchr(file, '\\') : strrchr(file, '/'));
	const char *exts[] = { "", ".exe", ".com" }; wchar_t *result = NULL;
	char *dirs = _strdup(has_sep ? "" : env_lookup(envp, "PATH") ? env_lookup(envp, "PATH") : (getenv("PATH") ? getenv("PATH") : ""));
	char *save = NULL; const char *dir = has_sep ? "" : (cwd && *cwd ? cwd : ".");
	for (int pass = 0; ; pass++) {
		for (int x = 0; x < 3; x++) {
			if (x == 0 && !has_ext && !has_sep) { continue; }           /* without an extension only the suffixed names count */
			if (x > 0 && has_ext) { continue; }
			size_t l = strlen(dir) + strlen(file) + 16; char *cand = malloc(l);
			if (has_sep) { snprintf(cand, l, "%s%s", file, exts[x]); } else { snprintf(cand, l, "%s%s%s%s", dir, *dir ? "\\" : "", file, exts[x]); }
			wchar_t *wc = wide(cand); free(cand);
			if (file_exists(wc)) { result = wc; break; } free(wc);
		}
		if (result || has_sep) { break; }
		dir = pass == 0 ? strtok_s(dirs, ";", &save) : strtok_s(NULL, ";", &save); if (!dir) { break; }
		if (!*dir) { dir = "."; }
	}
	free(dirs); free(wf); return result;
}
static void set_inherit(HANDLE h, int on) { SetHandleInformation(h, HANDLE_FLAG_INHERIT, on ? HANDLE_FLAG_INHERIT : 0); }
static char **strv_from_js(JSContext *ctx, JSValueConst arr, int *n_out) {
	uint32_t n = 0; JSValue l = JS_GetPropertyStr(ctx, arr, "length"); JS_ToUint32(ctx, &n, l); JS_FreeValue(ctx, l);
	char **v = calloc(n + 1, sizeof(char *));
	for (uint32_t i = 0; i < n; i++) { JSValue e = JS_GetPropertyUint32(ctx, arr, i); const char *s = JS_ToCString(ctx, e); v[i] = _strdup(s ? s : ""); JS_FreeCString(ctx, s); JS_FreeValue(ctx, e); }
	if (n_out) { *n_out = (int)n; } return v;
}
static void strv_free(char **v) { if (v) { for (char **p = v; *p; p++) { free(*p); } free(v); } }

/* spawn({ file, args:[...], env:["K=V"...], cwd, fds:[ourFd or -1 per child fd 0..n-1], detached }) -> pid, or -errno */
static JSValue js_spawn(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	JSValueConst o = argv[0];
	JSValue vfile = JS_GetPropertyStr(ctx, o, "file"), vargs = JS_GetPropertyStr(ctx, o, "args"), venv = JS_GetPropertyStr(ctx, o, "env"), vcwd = JS_GetPropertyStr(ctx, o, "cwd"), vfds = JS_GetPropertyStr(ctx, o, "fds"), vdet = JS_GetPropertyStr(ctx, o, "detached"), vverb = JS_GetPropertyStr(ctx, o, "verbatim");
	const char *file = JS_ToCString(ctx, vfile), *cwd = JS_IsUndefined(vcwd) || JS_IsNull(vcwd) ? NULL : JS_ToCString(ctx, vcwd);
	int nargs = 0; char **args = strv_from_js(ctx, vargs, &nargs); char **envp = JS_IsUndefined(venv) ? NULL : strv_from_js(ctx, venv, NULL);
	int nfds = 0; int *fds = NULL; { uint32_t n = 0; JSValue l = JS_GetPropertyStr(ctx, vfds, "length"); JS_ToUint32(ctx, &n, l); JS_FreeValue(ctx, l); nfds = (int)n; fds = calloc(n + 1, sizeof(int)); for (uint32_t i = 0; i < n; i++) { JSValue e = JS_GetPropertyUint32(ctx, vfds, i); int32_t x = -1; JS_ToInt32(ctx, &x, e); fds[i] = x; JS_FreeValue(ctx, e); } }
	int detached = JS_ToBool(ctx, vdet), verbatim = JS_ToBool(ctx, vverb); int result = 0;
	int low = 0; { JSValue vp = JS_GetPropertyStr(ctx, o, "priority"); const char *ps = JS_IsString(vp) ? JS_ToCString(ctx, vp) : NULL; low = ps && !strcmp(ps, "low"); if (ps) { JS_FreeCString(ctx, ps); } JS_FreeValue(ctx, vp); }   /* priority: "low" = background work: below normal priority class, which children inherit */
	wchar_t *exe = resolve_exe(file, envp, cwd), *wcwd = cwd ? wide(cwd) : NULL, *envblock = NULL, *cmdw = NULL;
	if (!exe) { result = -E_NOENT; goto done; }
	/* command line: argv[0] is the program as given, the rest quoted */
	{ char *cmd = NULL; size_t len = 0, cap = 0; for (int i = 0; i < nargs; i++) { if (i) { if (len + 2 > cap) { cap = cap * 2 + 64; cmd = realloc(cmd, cap); } cmd[len++] = ' '; } if (verbatim && i > 0) { for (const char *q = args[i]; *q; q++) { if (len + 2 > cap) { cap = cap * 2 + 64; cmd = realloc(cmd, cap); } cmd[len++] = *q; } } else { quote_arg(args[i], &cmd, &len, &cap); } } if (!cmd) { cmd = malloc(1); } cmd[len] = 0; cmdw = wide(cmd); free(cmd); }
	/* handles: stdio 0..2 via STARTUPINFO, the rest through QJS98_FDMAP; only these are made inheritable, and only for the duration of CreateProcess */
	HANDLE std[3] = { NULL, NULL, NULL }; HANDLE inh[64]; int ninh = 0; char fdmap[1024] = ""; size_t fl = 0;
	for (int i = 0; i < nfds; i++) {
		if (fds[i] < 0) { continue; }
		Fd *f = lookup(fds[i]); HANDLE h = f ? f->h : (HANDLE)_get_osfhandle(fds[i]);        /* our descriptors, or a CRT one (inherit: 0..2) */
		if (!h || h == INVALID_HANDLE_VALUE) { result = -E_BADF; goto done; }
		if (i < 3) { std[i] = h; }
		else { fl += snprintf(fdmap + fl, sizeof fdmap - fl, "%s%d:%llu:%d", fl ? "," : "", i, (unsigned long long)(ULONG_PTR)h, f ? f->ovl : 0); }
		if (ninh < 64) { inh[ninh++] = h; }
	}
	for (int i = 0; i < 3; i++) { if (!std[i] && (i >= nfds || fds[i] < 0)) { std[i] = INVALID_HANDLE_VALUE; } }
	/* a NULL stdio handle (ignore) must still be a valid handle for the child: open NUL */
	HANDLE nul = INVALID_HANDLE_VALUE; for (int i = 0; i < 3; i++) { if (std[i] == INVALID_HANDLE_VALUE) { if (nul == INVALID_HANDLE_VALUE) { SECURITY_ATTRIBUTES sa = { sizeof sa, NULL, TRUE }; nul = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, NULL); } std[i] = nul; } }
	if (!envp) {                                                                           /* no env given: the child gets ours (an explicit block is still needed for QJS98_FDMAP) */
		wchar_t *cur = GetEnvironmentStringsW(); int cnt = 0; for (wchar_t *e = cur; *e; e += wcslen(e) + 1) { cnt++; }
		envp = calloc(cnt + 1, sizeof(char *)); int k = 0; for (wchar_t *e = cur; *e; e += wcslen(e) + 1) { envp[k++] = narrow(e); } FreeEnvironmentStringsW(cur);
	}
	envblock = build_env(envp, fdmap);
	for (int i = 0; i < ninh; i++) { set_inherit(inh[i], 1); }
	if (nul != INVALID_HANDLE_VALUE) { set_inherit(nul, 1); }
	STARTUPINFOW si; memset(&si, 0, sizeof si); si.cb = sizeof si; si.dwFlags = STARTF_USESTDHANDLES; si.hStdInput = std[0]; si.hStdOutput = std[1]; si.hStdError = std[2];
	PROCESS_INFORMATION pi; memset(&pi, 0, sizeof pi);
	DWORD flags = CREATE_UNICODE_ENVIRONMENT | (detached ? DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP : CREATE_NO_WINDOW);
	if (low) { flags |= 0x00004000; /* BELOW_NORMAL_PRIORITY_CLASS */ }
	BOOL ok = CreateProcessW(exe, cmdw, NULL, NULL, TRUE, flags, envblock, wcwd, &si, &pi);
	DWORD err = ok ? 0 : GetLastError();
	for (int i = 0; i < ninh; i++) { set_inherit(inh[i], 0); }
	if (nul != INVALID_HANDLE_VALUE) { CloseHandle(nul); }
	if (!ok) { result = -errno_from_win(err); goto done; }
	CloseHandle(pi.hThread);
	Proc *pr = calloc(1, sizeof(Proc)); pr->pid = pi.dwProcessId; pr->h = pi.hProcess; pr->on_exit = JS_UNDEFINED; pr->next = procs; procs = pr;
	result = (int)pi.dwProcessId;
done:
	free(exe); free(wcwd); free(envblock); free(cmdw); free(fds); strv_free(args); strv_free(envp);
	JS_FreeCString(ctx, file); if (cwd) { JS_FreeCString(ctx, cwd); }
	JS_FreeValue(ctx, vfile); JS_FreeValue(ctx, vargs); JS_FreeValue(ctx, venv); JS_FreeValue(ctx, vcwd); JS_FreeValue(ctx, vfds); JS_FreeValue(ctx, vdet); JS_FreeValue(ctx, vverb);
	return JS_NewInt32(ctx, result);
}
static Proc *proc_find(DWORD pid) { for (Proc *p = procs; p; p = p->next) { if (p->pid == pid) { return p; } } return NULL; }
static JSValue js_watch_exit(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {     /* watchExit(pid, fn(exitCode, killed)) */
	int pid = arg_fd(ctx, argv[0]); Proc *p = proc_find((DWORD)pid); if (!p) { return JS_NewInt32(ctx, -E_SRCH); }
	JS_FreeValue(ctx, p->on_exit); p->on_exit = JS_DupValue(ctx, argv[1]); p->watching = 1; return JS_NewInt32(ctx, 0);
}
static JSValue js_kill(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {            /* kill(pid, sig): sig 0 only tests existence */
	int pid = arg_fd(ctx, argv[0]), sig = 15; if (argc > 1) { JS_ToInt32(ctx, &sig, argv[1]); }
	Proc *p = proc_find((DWORD)pid); HANDLE h = p ? p->h : OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_INFORMATION | SYNCHRONIZE, FALSE, (DWORD)pid);
	if (!h) { return JS_NewInt32(ctx, -E_SRCH); }
	int r = 0;
	if (sig != 0) { if (p) { p->killed = 1; } if (!TerminateProcess(h, 1)) { r = -errno_from_win(GetLastError()); } }
	else if (WaitForSingleObject(h, 0) == WAIT_OBJECT_0) { r = -E_SRCH; }
	if (!p) { CloseHandle(h); }
	return JS_NewInt32(ctx, r);
}
static JSValue js_exe_path(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	wchar_t buf[MAX_PATH * 2]; DWORD n = GetModuleFileNameW(NULL, buf, MAX_PATH * 2); buf[n] = 0; char *s = narrow(buf); JSValue r = JS_NewString(ctx, s); free(s); return r;
}
static JSValue js_rename(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {            /* rename(from, to): replaces an existing destination (what Node's fs.rename does on Windows) */
	const char *a = JS_ToCString(ctx, argv[0]), *b = JS_ToCString(ctx, argv[1]); if (!a || !b) { if (a) { JS_FreeCString(ctx, a); } if (b) { JS_FreeCString(ctx, b); } return JS_EXCEPTION; }
	wchar_t *wa = wide(a), *wb = wide(b); JS_FreeCString(ctx, a); JS_FreeCString(ctx, b);
	BOOL ok = MoveFileExW(wa, wb, MOVEFILE_REPLACE_EXISTING | MOVEFILE_COPY_ALLOWED); DWORD e = ok ? 0 : GetLastError(); free(wa); free(wb);
	return JS_NewInt32(ctx, ok ? 0 : -errno_from_win(e));
}
/* processTree(rootPid) -> [{ pid, ppid, name, mb, peakMb }] for the process and its descendants (Toolhelp snapshot + working set from psapi): memory numbers without a task manager */
static JSValue js_process_tree(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	int root = argc > 0 ? arg_fd(ctx, argv[0]) : (int)GetCurrentProcessId(); JSValue arr = JS_NewArray(ctx);
	HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0); if (snap == INVALID_HANDLE_VALUE) { return arr; }
	PROCESSENTRY32W e; e.dwSize = sizeof e; static DWORD pids[4096], par[4096]; static wchar_t names[4096][64]; int n = 0;
	if (Process32FirstW(snap, &e)) { do { if (n < 4096) { pids[n] = e.th32ProcessID; par[n] = e.th32ParentProcessID; wcsncpy(names[n], e.szExeFile, 63); names[n][63] = 0; n++; } } while (Process32NextW(snap, &e)); }
	CloseHandle(snap);
	char in[4096] = { 0 }; int out = 0; DWORD want[4096]; want[out++] = (DWORD)root;
	for (int i = 0; i < out; i++) { for (int j = 0; j < n; j++) { if (par[j] == want[i] && pids[j] != want[i] && out < 4096) { int seen = 0; for (int k = 0; k < out; k++) { if (want[k] == pids[j]) { seen = 1; } } if (!seen) { want[out++] = pids[j]; } } } }
	(void)in; uint32_t idx = 0;
	for (int i = 0; i < out; i++) {
		int j = -1; for (int k = 0; k < n; k++) { if (pids[k] == want[i]) { j = k; break; } } if (j < 0) { continue; }
		PROCESS_MEMORY_COUNTERS pmc; memset(&pmc, 0, sizeof pmc); HANDLE h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, want[i]); if (h) { GetProcessMemoryInfo(h, &pmc, sizeof pmc); CloseHandle(h); }
		JSValue o = JS_NewObject(ctx); char *nm = narrow(names[j]);
		JS_SetPropertyStr(ctx, o, "pid", JS_NewInt32(ctx, (int)pids[j])); JS_SetPropertyStr(ctx, o, "ppid", JS_NewInt32(ctx, (int)par[j])); JS_SetPropertyStr(ctx, o, "name", JS_NewString(ctx, nm)); free(nm);
		JS_SetPropertyStr(ctx, o, "mb", JS_NewFloat64(ctx, pmc.WorkingSetSize / 1048576.0)); JS_SetPropertyStr(ctx, o, "peakMb", JS_NewFloat64(ctx, pmc.PeakWorkingSetSize / 1048576.0));
		JS_SetPropertyUint32(ctx, arr, idx++, o);
	}
	return arr;
}
static JSValue js_getpid(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) { return JS_NewInt32(ctx, (int)GetCurrentProcessId()); }

/* spawnSync's engine: pollSync({ pid, inFd, input, outFd, errFd, timeoutMs, maxBuffer }) -> { status, signal, out, err, timedOut, overflow }. Closes the three fds. */
typedef struct { uint8_t *p; size_t n, cap; } Buf;
static void buf_add(Buf *b, const uint8_t *d, size_t n) { if (b->n + n > b->cap) { b->cap = (b->n + n) * 2 + 4096; b->p = realloc(b->p, b->cap); } memcpy(b->p + b->n, d, n); b->n += n; }
static JSValue js_poll_sync(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	JSValueConst o = argv[0]; int pid = 0, infd = -1, outfd = -1, errfd = -1; int64_t timeout = 0, maxbuf = 0;
	JSValue v;
#define GETI(name, var) v = JS_GetPropertyStr(ctx, o, name); if (!JS_IsUndefined(v)) { JS_ToInt32(ctx, &var, v); } JS_FreeValue(ctx, v);
	GETI("pid", pid) GETI("inFd", infd) GETI("outFd", outfd) GETI("errFd", errfd)
	v = JS_GetPropertyStr(ctx, o, "timeoutMs"); JS_ToInt64(ctx, &timeout, v); JS_FreeValue(ctx, v); v = JS_GetPropertyStr(ctx, o, "maxBuffer"); JS_ToInt64(ctx, &maxbuf, v); JS_FreeValue(ctx, v);
	uint8_t *in = NULL; size_t in_len = 0; v = JS_GetPropertyStr(ctx, o, "input"); if (!JS_IsUndefined(v) && !JS_IsNull(v)) { size_t sz; uint8_t *p = JS_GetArrayBuffer(ctx, &sz, v); if (p) { in = malloc(sz + 1); memcpy(in, p, sz); in_len = sz; } } JS_FreeValue(ctx, v);
	Proc *pr = proc_find((DWORD)pid); Buf out = { 0 }, err = { 0 }; int timed_out = 0, overflow = 0; Fd *fi = infd >= 0 ? lookup(infd) : NULL, *fo = outfd >= 0 ? lookup(outfd) : NULL, *fe = errfd >= 0 ? lookup(errfd) : NULL;
	if (fi && in_len) { DWORD done = 0; OVERLAPPED ov; HANDLE ev = CreateEvent(NULL, TRUE, FALSE, NULL); while (done < in_len) { memset(&ov, 0, sizeof ov); ov.hEvent = ev; DWORD n = 0; if (!WriteFile(fi->h, in + done, (DWORD)(in_len - done), NULL, &ov)) { if (GetLastError() != ERROR_IO_PENDING) { break; } } if (!GetOverlappedResult(fi->h, &ov, &n, TRUE)) { break; } done += n; } CloseHandle(ev); }
	if (fi) { JSValue a[1] = { JS_NewInt32(ctx, infd) }; JS_FreeValue(ctx, js_close(ctx, JS_UNDEFINED, 1, a)); }
	DWORD start = GetTickCount(); int proc_done = 0; DWORD code = 0;
	for (;;) {
		HANDLE hs[3]; int kind[3]; int n = 0;
		if (fo) { start_read(fo); if (!fo->reof && !fo->rerr) { hs[n] = fo->rev; kind[n++] = 0; } }
		if (fe) { start_read(fe); if (!fe->reof && !fe->rerr) { hs[n] = fe->rev; kind[n++] = 1; } }
		if (!proc_done && pr) { hs[n] = pr->h; kind[n++] = 2; }
		if (n == 0) { break; }
		DWORD wait = INFINITE; if (timeout > 0) { DWORD el = GetTickCount() - start; wait = el >= timeout ? 0 : (DWORD)(timeout - el); }
		DWORD r = WaitForMultipleObjects(n, hs, FALSE, wait);
		if (r == WAIT_TIMEOUT) { timed_out = 1; if (pr) { pr->killed = 1; TerminateProcess(pr->h, 1); } timeout = 0; continue; }
		if (r >= WAIT_OBJECT_0 + n) { break; }
		int k = kind[r - WAIT_OBJECT_0];
		if (k == 2) { proc_done = 1; GetExitCodeProcess(pr->h, &code); if (!fo && !fe) { break; } continue; }
		Fd *f = k == 0 ? fo : fe; Buf *b = k == 0 ? &out : &err; harvest(f);
		if (f->rlen > f->roff) { buf_add(b, f->rbuf + f->roff, f->rlen - f->roff); f->rlen = f->roff = 0; if (maxbuf > 0 && (int64_t)b->n > maxbuf) { overflow = 1; if (pr) { TerminateProcess(pr->h, 1); } } }
	}
	if (pr && !proc_done) { WaitForSingleObject(pr->h, INFINITE); GetExitCodeProcess(pr->h, &code); }
	if (fo) { JSValue a[1] = { JS_NewInt32(ctx, outfd) }; JS_FreeValue(ctx, js_close(ctx, JS_UNDEFINED, 1, a)); }
	if (fe) { JSValue a[1] = { JS_NewInt32(ctx, errfd) }; JS_FreeValue(ctx, js_close(ctx, JS_UNDEFINED, 1, a)); }
	if (pr) { pr->watching = 0; CloseHandle(pr->h); pr->h = NULL; }
	JSValue res = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, res, "status", JS_NewInt64(ctx, (int64_t)code)); JS_SetPropertyStr(ctx, res, "signal", timed_out || overflow ? JS_NewInt32(ctx, 15) : JS_NULL);
	JS_SetPropertyStr(ctx, res, "out", JS_NewArrayBufferCopy(ctx, out.p ? out.p : (const uint8_t *)"", out.n)); JS_SetPropertyStr(ctx, res, "err", JS_NewArrayBufferCopy(ctx, err.p ? err.p : (const uint8_t *)"", err.n));
	JS_SetPropertyStr(ctx, res, "timedOut", JS_NewBool(ctx, timed_out)); JS_SetPropertyStr(ctx, res, "overflow", JS_NewBool(ctx, overflow));
	free(out.p); free(err.p); free(in); return res;
}

/* ------------------------------------------------------------------------------------------------------------------------------------ event loop hook */
/* Every handle that can wake the loop. WaitForMultipleObjects takes at most 64 (63 with a window): with more (the main process with a dozen children, each with three
 * pipes and a process handle) the handles are served in turns, a window of `max` at a time, and the wait is capped (win_max_timeout) so the others are looked at soon. */
static HANDLE all_h[1024]; static int rr_next = 0, overflowed = 0, overflow_warned = 0;
static int win_collect(HANDLE *out, int max) {
	int n = 0, want_ready = 0; const int cap = (int)(sizeof all_h / sizeof all_h[0]) - 1;
	for (int i = 0; i < MAXSLOT && n < cap; i++) {
		Fd *f = slots[i]; if (!f) { continue; }
		if (f->server_of >= 0) { Fd *pf = slots[f->server_of]; if (pf && !JS_IsUndefined(pf->on_read) && (f->rpending || f->rlen > f->roff)) { all_h[n++] = f->rev; } continue; }
		if (!JS_IsUndefined(f->on_read)) { if (f->rlen > f->roff || f->reof || f->rerr || f->rpending) { all_h[n++] = f->rev; } else { start_read(f); if (f->rpending || f->reof || f->rerr) { all_h[n++] = f->rev; } } }
		if (f->ovl && f->wpending && n < cap) { all_h[n++] = f->wev; }                  /* an overlapped write in flight: its completion sends what was queued behind it, written or not by a handler */
		else if (!JS_IsUndefined(f->on_write) && n < cap) { want_ready = 1; }
	}
	for (Proc *p = procs; p && n < cap; p = p->next) { if (p->watching && p->h) { all_h[n++] = p->h; } }
	if (want_ready) { SetEvent(ready_ev); all_h[n++] = ready_ev; } else { ResetEvent(ready_ev); }
	if (n <= max) { memcpy(out, all_h, (size_t)n * sizeof(HANDLE)); overflowed = 0; return n; }
	if (!overflow_warned) { overflow_warned = 1; fprintf(stderr, "[winproc] %d waitable handles, more than one wait takes (%d): serving them in turns\n", n, max); }
	overflowed = 1; if (rr_next >= n) { rr_next = 0; }
	for (int i = 0; i < max; i++) { out[i] = all_h[(rr_next + i) % n]; }
	rr_next = (rr_next + max) % n; return max;
}
static int win_max_timeout(void) { return overflowed ? 10 : -1; }
static void call_js(JSContext *ctx, JSValue fn, int argc, JSValue *argv) { JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, argc, argv); if (JS_IsException(r)) { js_std_dump_error(ctx); } JS_FreeValue(ctx, r); }
static int win_dispatch(JSContext *ctx, HANDLE h) {
	if (h == ready_ev) {                                                          /* write handlers that can fire now */
		for (int i = 0; i < MAXSLOT; i++) { Fd *f = slots[i]; if (f && !JS_IsUndefined(f->on_write) && !(f->ovl && f->wpending)) { JSValue fn = JS_DupValue(ctx, f->on_write); call_js(ctx, fn, 0, NULL); JS_FreeValue(ctx, fn); return 1; } }
		return 1;
	}
	for (Proc *p = procs; p; p = p->next) {
		if (p->h == h && p->watching) {
			DWORD code = 0; GetExitCodeProcess(p->h, &code); JSValue fn = p->on_exit; p->on_exit = JS_UNDEFINED; p->watching = 0; CloseHandle(p->h); p->h = NULL;
			JSValue a[2] = { JS_NewInt64(ctx, (int64_t)code), JS_NewBool(ctx, p->killed) }; call_js(ctx, fn, 2, a); JS_FreeValue(ctx, fn); return 1;
		}
	}
	for (int i = 0; i < MAXSLOT; i++) {
		Fd *f = slots[i]; if (!f) { continue; }
		if (h == f->rev && f->server_of >= 0) {
			Fd *pf = slots[f->server_of]; harvest(f);
			if (pf && !JS_IsUndefined(pf->on_read) && f->rlen > f->roff) { JSValue fn = JS_DupValue(ctx, pf->on_read); call_js(ctx, fn, 0, NULL); JS_FreeValue(ctx, fn); }
			return 1;
		}
		if (h == f->rev && !JS_IsUndefined(f->on_read)) {
			harvest(f);
			if (f->rlen > f->roff || f->reof || f->rerr) { JSValue fn = JS_DupValue(ctx, f->on_read); call_js(ctx, fn, 0, NULL); JS_FreeValue(ctx, fn); }
			else if (!f->rpending) { start_read(f); }
			return 1;
		}
		if (h == f->wev && f->ovl) {
			write_harvest(f);
			if (f->werr || write_has_room(f)) { if (!JS_IsUndefined(f->on_write)) { JSValue fn = JS_DupValue(ctx, f->on_write); call_js(ctx, fn, 0, NULL); JS_FreeValue(ctx, fn); } }
			return 1;
		}
	}
	return 0;
}
static int win_active(void) {
	for (int i = 0; i < MAXSLOT; i++) { Fd *f = slots[i]; if (f && (!JS_IsUndefined(f->on_read) || !JS_IsUndefined(f->on_write) || (f->ovl && (f->wpending || f->wqlen)))) { return 1; } }
	for (Proc *p = procs; p; p = p->next) { if (p->watching && p->h) { return 1; } }
	return 0;
}

/* ------------------------------------------------------------------------------------------------------------------------------------ named-pipe servers and clients (net.createServer / net.connect with a path) */
static HANDLE new_pipe_instance(const wchar_t *name, int first) {
	return CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0), PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT, PIPE_UNLIMITED_INSTANCES, CHUNK, CHUNK, 0, NULL);
}
static JSValue js_listen_unix(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {     /* listenUnix(path) -> { fd } | -errno; the path must be \\.\pipe\name */
	const char *path = JS_ToCString(ctx, argv[0]); if (!path) { return JS_EXCEPTION; } wchar_t *name = wide(path); JS_FreeCString(ctx, path);
	if (wcsncmp(name, L"\\\\.\\pipe\\", 9) != 0) { free(name); return JS_NewInt32(ctx, -E_INVAL); }
	HANDLE h = new_pipe_instance(name, 1); if (h == INVALID_HANDLE_VALUE) { DWORD e = GetLastError(); free(name); return JS_NewInt32(ctx, e == ERROR_ACCESS_DENIED || e == ERROR_PIPE_BUSY ? -E_ADDRINUSE : -errno_from_win(e)); }
	int fd = alloc_fd(h, 1); if (fd < 0) { CloseHandle(h); free(name); return JS_NewInt32(ctx, fd); }
	Fd *f = slots[fd]; f->is_server = 1; f->pipename = name;
	for (int i = 1; i < 4; i++) {                                                  /* backlog of waiting instances */
		HANDLE h2 = new_pipe_instance(name, 0); if (h2 == INVALID_HANDLE_VALUE) { break; } int fd2 = alloc_fd(h2, 1); if (fd2 < 0) { CloseHandle(h2); break; }
		Fd *g = slots[fd2]; g->is_server = 1; g->server_of = fd; g->pipename = _wcsdup(name); start_read(g);
	}
	JSValue o = JS_NewObject(ctx); JS_SetPropertyStr(ctx, o, "fd", JS_NewInt32(ctx, fd)); JS_SetPropertyStr(ctx, o, "port", JS_NewInt32(ctx, 0)); return o;
}
static Fd *server_ready(int primary_fd) {                                                      /* a listening instance (primary or backlog) that has a client */
	for (int i = 0; i < MAXSLOT; i++) { Fd *g = slots[i]; if (g && g->is_server && (g->num == primary_fd || g->server_of == primary_fd)) { if (g->rpending) { harvest(g); } if (g->rlen > g->roff) { return g; } } }
	return NULL;
}
static JSValue js_accept(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	int pfd = arg_fd(ctx, argv[0]); Fd *f = lookup(pfd); if (!f || !f->is_server || f->server_of >= 0) { return JS_NewInt32(ctx, -E_BADF); }
	Fd *r = server_ready(pfd); if (!r) { start_read(f); return JS_NewInt32(ctx, -E_AGAIN); }
	HANDLE conn = r->h, next = new_pipe_instance(r->pipename, 0); if (next == INVALID_HANDLE_VALUE) { return JS_NewInt32(ctx, -E_NOMEM); }
	int fd = alloc_fd(conn, 1); if (fd < 0) { CloseHandle(next); return JS_NewInt32(ctx, fd); }
	r->h = next; r->rlen = r->roff = 0; r->rpending = 0; start_read(r);
	return JS_NewInt32(ctx, fd);
}
static JSValue js_connect_unix(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {    /* connectUnix(path) -> { fd } | -errno (connects synchronously) */
	const char *path = JS_ToCString(ctx, argv[0]); if (!path) { return JS_EXCEPTION; } wchar_t *name = wide(path); JS_FreeCString(ctx, path);
	HANDLE h = INVALID_HANDLE_VALUE; DWORD err = 0;
	for (int attempt = 0; attempt < 5; attempt++) {
		h = CreateFileW(name, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, NULL);
		if (h != INVALID_HANDLE_VALUE) { break; } err = GetLastError(); if (err != ERROR_PIPE_BUSY) { break; } WaitNamedPipeW(name, 2000);
	}
	free(name); if (h == INVALID_HANDLE_VALUE) { return JS_NewInt32(ctx, err == ERROR_FILE_NOT_FOUND ? -E_NOENT : err == ERROR_PIPE_BUSY ? -E_CONNREFUSED : -errno_from_win(err)); }
	int fd = alloc_fd(h, 1); if (fd < 0) { CloseHandle(h); return JS_NewInt32(ctx, fd); }
	JSValue o = JS_NewObject(ctx); JS_SetPropertyStr(ctx, o, "fd", JS_NewInt32(ctx, fd)); return o;
}

/* ------------------------------------------------------------------------------------------------------------------------------------ misc JS API */
static JSValue js_noop0(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) { return JS_UNDEFINED; }
static JSValue js_noop_ok(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) { return JS_NewInt32(ctx, 0); }
static JSValue js_shutdown(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	Fd *f = lookup(arg_fd(ctx, argv[0])); if (!f) { return JS_NewInt32(ctx, -E_BADF); }
	int how = 1; if (argc > 1) { JS_ToInt32(ctx, &how, argv[1]); }
	if (how >= 1 && f->ovl && !f->is_server) { f->shutting = 1; if (f->wpending) { write_harvest(f); } shutdown_finish(f); }
	return JS_NewInt32(ctx, 0);
}
static JSValue js_nosys(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) { return JS_NewInt32(ctx, -E_NOSYS); }
static JSValue js_errname(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	int e; JS_ToInt32(ctx, &e, argv[0]); if (e < 0) { e = -e; }
	switch (e) {
#define E(x, n) case x: return JS_NewString(ctx, n);
	E(E_NOENT, "ENOENT") E(E_ACCES, "EACCES") E(E_AGAIN, "EAGAIN") E(E_CONNREFUSED, "ECONNREFUSED") E(E_CONNRESET, "ECONNRESET") E(E_PIPE, "EPIPE") E(E_ADDRINUSE, "EADDRINUSE") E(E_NOTDIR, "ENOTDIR")
	E(E_ISDIR, "EISDIR") E(E_EXIST, "EEXIST") E(E_MFILE, "EMFILE") E(E_INVAL, "EINVAL") E(E_BADF, "EBADF") E(E_TIMEDOUT, "ETIMEDOUT") E(E_NOMEM, "ENOMEM") E(E_NOEXEC, "ENOEXEC") E(E_2BIG, "E2BIG")
	E(E_NAMETOOLONG, "ENAMETOOLONG") E(E_NOSYS, "ENOSYS") E(E_IO, "EIO") E(E_SRCH, "ESRCH")
#undef E
	default: return JS_NewString(ctx, "EUNKNOWN");
	}
}
static JSValue js_utf8_decode(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	size_t byteoff = 0, bytelen = 0, bpe = 0, size = 0; uint8_t *p; JSValue ab = JS_GetTypedArrayBuffer(ctx, argv[0], &byteoff, &bytelen, &bpe);
	if (!JS_IsException(ab)) { p = JS_GetArrayBuffer(ctx, &size, ab); JS_FreeValue(ctx, ab); if (!p) { return JS_EXCEPTION; } p += byteoff; }
	else { JS_FreeValue(ctx, JS_GetException(ctx)); p = JS_GetArrayBuffer(ctx, &size, argv[0]); if (!p) { return JS_EXCEPTION; } bytelen = size; }
	return JS_NewStringLen(ctx, (const char *)p, bytelen);
}
static JSValue js_utf8_encode(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	size_t len; const char *s = JS_ToCStringLen2(ctx, &len, argv[0], 0); if (!s) { return JS_EXCEPTION; }
	JSValue r = JS_NewUint8ArrayCopy(ctx, (const uint8_t *)s, len); JS_FreeCString(ctx, s); return r;
}

static const JSCFunctionListEntry funcs[] = {
	JS_CFUNC_DEF("pipe", 1, js_pipe), JS_CFUNC_DEF("socketpair", 0, js_socketpair), JS_CFUNC_DEF("read", 4, js_read), JS_CFUNC_DEF("write", 4, js_write), JS_CFUNC_DEF("close", 1, js_close),
	JS_CFUNC_DEF("setReadHandler", 2, js_set_read_handler), JS_CFUNC_DEF("setWriteHandler", 2, js_set_write_handler), JS_CFUNC_DEF("spawn", 1, js_spawn), JS_CFUNC_DEF("watchExit", 2, js_watch_exit),
	JS_CFUNC_DEF("kill", 2, js_kill), JS_CFUNC_DEF("exePath", 0, js_exe_path), JS_CFUNC_DEF("rename", 2, js_rename), JS_CFUNC_DEF("getpid", 0, js_getpid), JS_CFUNC_DEF("processTree", 1, js_process_tree), JS_CFUNC_DEF("pollSync", 1, js_poll_sync), JS_CFUNC_DEF("errname", 1, js_errname),
	JS_CFUNC_DEF("setNonblock", 2, js_noop_ok), JS_CFUNC_DEF("setCloexec", 2, js_noop_ok), JS_CFUNC_DEF("ignoreSigpipe", 0, js_noop0), JS_CFUNC_DEF("shutdown", 2, js_shutdown),
	JS_CFUNC_DEF("listen", 2, js_nosys), JS_CFUNC_DEF("listenUnix", 1, js_listen_unix), JS_CFUNC_DEF("accept", 1, js_accept), JS_CFUNC_DEF("connect", 2, js_nosys), JS_CFUNC_DEF("connectUnix", 1, js_connect_unix),
	JS_CFUNC_DEF("soError", 1, js_noop_ok), JS_CFUNC_DEF("sockPort", 1, js_noop_ok),
};
static int proc_init(JSContext *ctx, JSModuleDef *m) { return JS_SetModuleExportList(ctx, m, funcs, sizeof funcs / sizeof funcs[0]); }
void spike_init_esm(JSContext *ctx);
void spike_init(JSContext *ctx) {
	spike_init_esm(ctx); g_ctx = ctx; ready_ev = CreateEvent(NULL, TRUE, FALSE, NULL);
	/* Windows' default timer resolution is 15.6 ms: QuickJS clamps setTimeout(0) to 1 ms and waits with WaitForMultipleObjects/Sleep, so every chained zero-delay timer (the workbench and the Node
	   shims use thousands, setImmediate included) would cost a full tick. Ask for 1 ms for the life of the process; QJS98_TIMER_RES=0 turns it off (for comparisons). */
	{ const char *tr = getenv("QJS98_TIMER_RES"); if (!tr || tr[0] != '0') { timeBeginPeriod(1); } }
	js_win_waiter.collect = win_collect; js_win_waiter.dispatch = win_dispatch; js_win_waiter.active = win_active; js_win_waiter.max_timeout = win_max_timeout;
	JSValue g = JS_GetGlobalObject(ctx);
	JS_SetPropertyStr(ctx, g, "__utf8Decode", JS_NewCFunction(ctx, js_utf8_decode, "__utf8Decode", 1));
	JS_SetPropertyStr(ctx, g, "__utf8Encode", JS_NewCFunction(ctx, js_utf8_encode, "__utf8Encode", 1));
	JS_SetPropertyStr(ctx, g, "__nativeRename", JS_NewCFunction(ctx, js_rename, "__nativeRename", 2));   /* used by the fs shim */
	JS_FreeValue(ctx, g);
	JSModuleDef *m = JS_NewCModule(ctx, "spike:proc", proc_init); if (m) { JS_AddModuleExportList(ctx, m, funcs, sizeof funcs / sizeof funcs[0]); }
}
