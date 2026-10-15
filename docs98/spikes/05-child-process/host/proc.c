/* spike:proc - the smallest native layer needed for Node's child_process / net on top of QuickJS-ng's own `qjs:os` (read/write/setReadHandler/waitpid/signal/kill).
 * POSIX only in this spike. Every function returns a value >= 0 or a NEGATIVE errno, so JS can map errors to Node-style codes.
 * What qjs:os lacks and this adds: spawn with an arbitrary fd map (stdio + extra pipes, which `os.exec` cannot do), CLOEXEC pipes, socketpair,
 * O_NONBLOCK, and TCP / unix-domain sockets (listen, accept, connect, getsockname, shutdown, SO_ERROR). Not a Windows port: see the README for the Win32 mapping. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <time.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>
#include "quickjs.h"

#define ERR() (-errno)

static JSValue js_pipe(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	int fds[2]; if (pipe2(fds, O_CLOEXEC) < 0) { return JS_NewInt32(ctx, ERR()); }
	JSValue a = JS_NewArray(ctx); JS_SetPropertyUint32(ctx, a, 0, JS_NewInt32(ctx, fds[0])); JS_SetPropertyUint32(ctx, a, 1, JS_NewInt32(ctx, fds[1])); return a;
}
static JSValue js_socketpair(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	int fds[2]; if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, fds) < 0) { return JS_NewInt32(ctx, ERR()); }
	JSValue a = JS_NewArray(ctx); JS_SetPropertyUint32(ctx, a, 0, JS_NewInt32(ctx, fds[0])); JS_SetPropertyUint32(ctx, a, 1, JS_NewInt32(ctx, fds[1])); return a;
}
static JSValue js_set_nonblock(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	int fd, on; JS_ToInt32(ctx, &fd, argv[0]); on = JS_ToBool(ctx, argv[1]);
	int fl = fcntl(fd, F_GETFL); if (fl < 0) { return JS_NewInt32(ctx, ERR()); }
	if (fcntl(fd, F_SETFL, on ? (fl | O_NONBLOCK) : (fl & ~O_NONBLOCK)) < 0) { return JS_NewInt32(ctx, ERR()); }
	return JS_NewInt32(ctx, 0);
}
/* clear/set CLOEXEC (a pipe end meant to be inherited must not have it, but spawn() dup2s into place, so this is rarely needed) */
static JSValue js_set_cloexec(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	int fd, on; JS_ToInt32(ctx, &fd, argv[0]); on = JS_ToBool(ctx, argv[1]);
	if (fcntl(fd, F_SETFD, on ? FD_CLOEXEC : 0) < 0) { return JS_NewInt32(ctx, ERR()); }
	return JS_NewInt32(ctx, 0);
}

static char **strv_from_js(JSContext *ctx, JSValueConst arr, int *n_out) {
	uint32_t n = 0; JSValue l = JS_GetPropertyStr(ctx, arr, "length"); JS_ToUint32(ctx, &n, l); JS_FreeValue(ctx, l);
	char **v = calloc(n + 1, sizeof(char *));
	for (uint32_t i = 0; i < n; i++) { JSValue e = JS_GetPropertyUint32(ctx, arr, i); const char *s = JS_ToCString(ctx, e); v[i] = strdup(s ? s : ""); JS_FreeCString(ctx, s); JS_FreeValue(ctx, e); }
	if (n_out) { *n_out = (int)n; } return v;
}
static void strv_free(char **v) { if (v) { for (char **p = v; *p; p++) { free(*p); } free(v); } }

/* Search `file` on the PATH found in `envp` (the child's environment, like libuv), falling back to the default path. Returns malloc'd path or NULL. */
static char *resolve_exec(const char *file, char **envp) {
	if (strchr(file, '/')) { return strdup(file); }
	const char *path = "/usr/local/bin:/usr/bin:/bin";
	for (char **e = envp; e && *e; e++) { if (!strncmp(*e, "PATH=", 5)) { path = *e + 5; break; } }
	char *copy = strdup(path), *save = NULL, *res = NULL;
	for (char *dir = strtok_r(copy, ":", &save); dir; dir = strtok_r(NULL, ":", &save)) {
		size_t len = strlen(dir) + strlen(file) + 2; char *cand = malloc(len); snprintf(cand, len, "%s/%s", *dir ? dir : ".", file);
		if (access(cand, X_OK) == 0) { res = cand; break; } free(cand);
	}
	free(copy); return res;
}

/* spawn({ file, args:[...], env:["K=V"...], cwd, fds:[parentFd or -1 per child fd 0..n-1], detached }) -> pid, or -errno (exec failure is reported back through a CLOEXEC pipe) */
static JSValue js_spawn(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	JSValueConst o = argv[0];
	JSValue vfile = JS_GetPropertyStr(ctx, o, "file"), vargs = JS_GetPropertyStr(ctx, o, "args"), venv = JS_GetPropertyStr(ctx, o, "env"), vcwd = JS_GetPropertyStr(ctx, o, "cwd"), vfds = JS_GetPropertyStr(ctx, o, "fds"), vdet = JS_GetPropertyStr(ctx, o, "detached");
	const char *file = JS_ToCString(ctx, vfile), *cwd = JS_IsUndefined(vcwd) || JS_IsNull(vcwd) ? NULL : JS_ToCString(ctx, vcwd);
	char **args = strv_from_js(ctx, vargs, NULL), **envp = JS_IsUndefined(venv) ? NULL : strv_from_js(ctx, venv, NULL);
	int nfds = 0; int *fds = NULL; { uint32_t n = 0; JSValue l = JS_GetPropertyStr(ctx, vfds, "length"); JS_ToUint32(ctx, &n, l); JS_FreeValue(ctx, l); nfds = (int)n; fds = calloc(n + 1, sizeof(int)); for (uint32_t i = 0; i < n; i++) { JSValue e = JS_GetPropertyUint32(ctx, vfds, i); int32_t fd; JS_ToInt32(ctx, &fd, e); fds[i] = fd; JS_FreeValue(ctx, e); } }
	int detached = JS_ToBool(ctx, vdet);
	int low = 0; { JSValue vp = JS_GetPropertyStr(ctx, o, "priority"); const char *ps = JS_IsString(vp) ? JS_ToCString(ctx, vp) : NULL; low = ps && !strcmp(ps, "low"); if (ps) { JS_FreeCString(ctx, ps); } JS_FreeValue(ctx, vp); }   /* priority: "low" = background work (children inherit it) */
	char *exe = resolve_exec(file, envp ? envp : environ);
	int result;
	if (!exe) { result = -ENOENT; goto done; }
	int ep[2]; if (pipe2(ep, O_CLOEXEC) < 0) { result = ERR(); free(exe); goto done; }
	pid_t pid = fork();
	if (pid < 0) { result = ERR(); close(ep[0]); close(ep[1]); free(exe); goto done; }
	if (pid == 0) {
		/* child: first move every source fd out of the way of the targets (dup to >= nfds+3), then dup2 into place */
		int tmp[64]; int base = nfds + 3; if (nfds > 64) { _exit(127); }
		for (int i = 0; i < nfds; i++) { tmp[i] = fds[i] >= 0 ? fcntl(fds[i], F_DUPFD, base) : -1; }
		for (int i = 0; i < nfds; i++) {
			if (tmp[i] >= 0) { dup2(tmp[i], i); } else { int nul = open("/dev/null", i == 0 ? O_RDONLY : O_RDWR); if (nul >= 0 && nul != i) { dup2(nul, i); close(nul); } }
			fcntl(i, F_SETFD, 0);                                    /* inherited */
		}
		for (int i = 0; i < nfds; i++) { if (tmp[i] >= 0) { close(tmp[i]); } }
		if (detached) { setsid(); }
		if (low) { (void)!nice(10); }
		if (cwd && chdir(cwd) < 0) { int e = errno; (void)!write(ep[1], &e, sizeof e); _exit(127); }
		signal(SIGPIPE, SIG_DFL);
		sigset_t none; sigemptyset(&none); sigprocmask(SIG_SETMASK, &none, NULL);
		if (envp) { environ = envp; }
		execv(exe, args);
		int e = errno; (void)!write(ep[1], &e, sizeof e); _exit(127);
	}
	close(ep[1]);
	int e = 0; ssize_t r; do { r = read(ep[0], &e, sizeof e); } while (r < 0 && errno == EINTR);
	close(ep[0]); free(exe);
	if (r == (ssize_t)sizeof e) { int st; waitpid(pid, &st, 0); result = -e; } else { result = (int)pid; }
done:
	JS_FreeCString(ctx, file); if (cwd) { JS_FreeCString(ctx, cwd); }
	strv_free(args); strv_free(envp); free(fds);
	JS_FreeValue(ctx, vfile); JS_FreeValue(ctx, vargs); JS_FreeValue(ctx, venv); JS_FreeValue(ctx, vcwd); JS_FreeValue(ctx, vfds); JS_FreeValue(ctx, vdet);
	return JS_NewInt32(ctx, result);
}

/* ---- sockets ---------------------------------------------------------------------------------------------------------------------------- */
static JSValue fd_and(JSContext *ctx, int fd, int port) { JSValue o = JS_NewObject(ctx); JS_SetPropertyStr(ctx, o, "fd", JS_NewInt32(ctx, fd)); JS_SetPropertyStr(ctx, o, "port", JS_NewInt32(ctx, port)); return o; }
static int resolve_inet(const char *host, int port, struct sockaddr_storage *ss, socklen_t *len) {
	struct addrinfo hints = { .ai_family = AF_UNSPEC, .ai_socktype = SOCK_STREAM, .ai_flags = AI_NUMERICSERV }, *res; char ps[16]; snprintf(ps, sizeof ps, "%d", port);
	int rc = getaddrinfo(host && *host ? host : NULL, ps, &hints, &res); if (rc != 0) { return -EADDRNOTAVAIL; }
	memcpy(ss, res->ai_addr, res->ai_addrlen); *len = res->ai_addrlen; int fam = res->ai_family; freeaddrinfo(res); return fam;
}
static int sock_port(int fd) { struct sockaddr_storage ss; socklen_t l = sizeof ss; if (getsockname(fd, (struct sockaddr *)&ss, &l) < 0) { return -1; } return ss.ss_family == AF_INET ? ntohs(((struct sockaddr_in *)&ss)->sin_port) : ss.ss_family == AF_INET6 ? ntohs(((struct sockaddr_in6 *)&ss)->sin6_port) : 0; }

/* listen(host|null, port) -> {fd, port}  | listenUnix(path) -> {fd} ; fds are non-blocking and CLOEXEC */
static JSValue js_listen(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	const char *host = JS_IsNull(argv[0]) || JS_IsUndefined(argv[0]) ? NULL : JS_ToCString(ctx, argv[0]); int port; JS_ToInt32(ctx, &port, argv[1]);
	struct sockaddr_storage ss; socklen_t len; int fam = host ? resolve_inet(host, port, &ss, &len) : 0;
	if (!host) { struct sockaddr_in6 *a = (struct sockaddr_in6 *)&ss; memset(a, 0, sizeof *a); a->sin6_family = AF_INET6; a->sin6_port = htons(port); len = sizeof *a; fam = AF_INET6; }
	if (host) { JS_FreeCString(ctx, host); }
	if (fam < 0) { return JS_NewInt32(ctx, fam); }
	int fd = socket(fam, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0); if (fd < 0) { return JS_NewInt32(ctx, ERR()); }
	int one = 1; setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one); if (fam == AF_INET6) { int zero = 0; setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &zero, sizeof zero); }
	if (bind(fd, (struct sockaddr *)&ss, len) < 0 || listen(fd, 128) < 0) { int e = ERR(); close(fd); return JS_NewInt32(ctx, e); }
	return fd_and(ctx, fd, sock_port(fd));
}
static JSValue js_listen_unix(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]); struct sockaddr_un a; memset(&a, 0, sizeof a); a.sun_family = AF_UNIX; strncpy(a.sun_path, path, sizeof a.sun_path - 1); JS_FreeCString(ctx, path);
	int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0); if (fd < 0) { return JS_NewInt32(ctx, ERR()); }
	if (bind(fd, (struct sockaddr *)&a, sizeof a) < 0 || listen(fd, 128) < 0) { int e = ERR(); close(fd); return JS_NewInt32(ctx, e); }
	return fd_and(ctx, fd, 0);
}
/* accept(fd) -> new fd (non-blocking) or -EAGAIN */
static JSValue js_accept(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	int fd; JS_ToInt32(ctx, &fd, argv[0]); int c = accept4(fd, NULL, NULL, SOCK_CLOEXEC | SOCK_NONBLOCK); if (c < 0) { return JS_NewInt32(ctx, ERR()); }
	return JS_NewInt32(ctx, c);
}
/* connect(host, port) -> {fd}: non-blocking; -EINPROGRESS is not an error: wait for writability, then soError(fd). Name resolution is blocking (getaddrinfo). */
static JSValue js_connect(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	const char *host = JS_ToCString(ctx, argv[0]); int port; JS_ToInt32(ctx, &port, argv[1]);
	struct sockaddr_storage ss; socklen_t len; int fam = resolve_inet(host, port, &ss, &len); JS_FreeCString(ctx, host); if (fam < 0) { return JS_NewInt32(ctx, fam); }
	int fd = socket(fam, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0); if (fd < 0) { return JS_NewInt32(ctx, ERR()); }
	if (connect(fd, (struct sockaddr *)&ss, len) < 0 && errno != EINPROGRESS) { int e = ERR(); close(fd); return JS_NewInt32(ctx, e); }
	int one = 1; setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
	return fd_and(ctx, fd, 0);
}
static JSValue js_connect_unix(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	const char *path = JS_ToCString(ctx, argv[0]); struct sockaddr_un a; memset(&a, 0, sizeof a); a.sun_family = AF_UNIX; strncpy(a.sun_path, path, sizeof a.sun_path - 1); JS_FreeCString(ctx, path);
	int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0); if (fd < 0) { return JS_NewInt32(ctx, ERR()); }
	if (connect(fd, (struct sockaddr *)&a, sizeof a) < 0 && errno != EINPROGRESS) { int e = ERR(); close(fd); return JS_NewInt32(ctx, e); }
	return fd_and(ctx, fd, 0);
}
static JSValue js_so_error(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	int fd, err = 0; socklen_t l = sizeof err; JS_ToInt32(ctx, &fd, argv[0]); if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &l) < 0) { return JS_NewInt32(ctx, ERR()); }
	return JS_NewInt32(ctx, -err);
}
static JSValue js_shutdown(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	int fd, how; JS_ToInt32(ctx, &fd, argv[0]); JS_ToInt32(ctx, &how, argv[1]); return JS_NewInt32(ctx, shutdown(fd, how) < 0 ? ERR() : 0);
}
static JSValue js_sockport(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) { int fd; JS_ToInt32(ctx, &fd, argv[0]); return JS_NewInt32(ctx, sock_port(fd)); }

/* ---- synchronous I/O for spawnSync / execSync -------------------------------------------------------------------------------------------- */
typedef struct { uint8_t *p; size_t n, cap; } Buf;
static void buf_add(Buf *b, const uint8_t *d, size_t n) { if (b->n + n > b->cap) { b->cap = (b->n + n) * 2 + 4096; b->p = realloc(b->p, b->cap); } memcpy(b->p + b->n, d, n); b->n += n; }
static int64_t mono_ms(void) { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000; }
/* pollSync({ pid, inFd, input:ArrayBuffer|undefined, outFd, errFd, timeoutMs, maxBuffer }) -> { status, signal, out:ArrayBuffer, err:ArrayBuffer, timedOut, overflow }.
 * Feeds `input` to inFd, drains outFd/errFd with poll(2) until EOF, enforces a timeout (SIGTERM), then waitpid()s. Closes the three fds. -1 means "not used". */
static JSValue js_poll_sync(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	JSValueConst o = argv[0]; int32_t pid, infd, outfd, errfd; double timeout = 0, maxbuf = 0;
	#define GETI(name, var) { JSValue v = JS_GetPropertyStr(ctx, o, name); JS_ToInt32(ctx, &var, v); JS_FreeValue(ctx, v); }
	GETI("pid", pid) GETI("inFd", infd) GETI("outFd", outfd) GETI("errFd", errfd)
	{ JSValue v = JS_GetPropertyStr(ctx, o, "timeoutMs"); JS_ToFloat64(ctx, &timeout, v); JS_FreeValue(ctx, v); v = JS_GetPropertyStr(ctx, o, "maxBuffer"); JS_ToFloat64(ctx, &maxbuf, v); JS_FreeValue(ctx, v); }
	size_t in_len = 0, in_off = 0; uint8_t *in = NULL; { JSValue v = JS_GetPropertyStr(ctx, o, "input"); if (!JS_IsUndefined(v) && !JS_IsNull(v)) { size_t n; uint8_t *d = JS_GetArrayBuffer(ctx, &n, v); if (d) { in = malloc(n ? n : 1); memcpy(in, d, n); in_len = n; } } JS_FreeValue(ctx, v); }
	if (infd >= 0) { fcntl(infd, F_SETFL, fcntl(infd, F_GETFL) | O_NONBLOCK); if (in_len == 0) { close(infd); infd = -1; } }
	Buf out = {0}, err = {0}; int64_t deadline = timeout > 0 ? mono_ms() + (int64_t)timeout : 0; int timed_out = 0, overflow = 0, killed = 0;
	signal(SIGPIPE, SIG_IGN);
	while (infd >= 0 || outfd >= 0 || errfd >= 0) {
		struct pollfd pf[3]; int n = 0, ii = -1, io = -1, ie = -1;
		if (infd >= 0) { ii = n; pf[n++] = (struct pollfd){ infd, POLLOUT, 0 }; }
		if (outfd >= 0) { io = n; pf[n++] = (struct pollfd){ outfd, POLLIN, 0 }; }
		if (errfd >= 0) { ie = n; pf[n++] = (struct pollfd){ errfd, POLLIN, 0 }; }
		int wait = -1; if (deadline) { int64_t left = deadline - mono_ms(); if (left <= 0) { if (!killed) { kill(pid, SIGTERM); killed = 1; timed_out = 1; } wait = 200; deadline = mono_ms() + 2000; } else { wait = (int)left; } }
		int r = poll(pf, n, wait); if (r < 0 && errno == EINTR) { continue; }
		if (r < 0) { break; }
		uint8_t tmp[65536];
		if (ii >= 0 && (pf[ii].revents & (POLLOUT | POLLERR | POLLHUP))) { ssize_t w = write(infd, in + in_off, in_len - in_off); if (w > 0) { in_off += w; } if (w < 0 && errno != EAGAIN) { in_off = in_len; } if (in_off >= in_len) { close(infd); infd = -1; } }
		if (io >= 0 && (pf[io].revents & (POLLIN | POLLHUP | POLLERR))) { ssize_t g = read(outfd, tmp, sizeof tmp); if (g > 0) { buf_add(&out, tmp, g); } else if (g == 0 || (errno != EAGAIN && errno != EINTR)) { close(outfd); outfd = -1; } }
		if (ie >= 0 && (pf[ie].revents & (POLLIN | POLLHUP | POLLERR))) { ssize_t g = read(errfd, tmp, sizeof tmp); if (g > 0) { buf_add(&err, tmp, g); } else if (g == 0 || (errno != EAGAIN && errno != EINTR)) { close(errfd); errfd = -1; } }
		if (maxbuf > 0 && (out.n > maxbuf || err.n > maxbuf) && !killed) { kill(pid, SIGTERM); killed = 1; overflow = 1; }
	}
	if (infd >= 0) { close(infd); }
	int st = 0; while (waitpid(pid, &st, 0) < 0 && errno == EINTR) { }
	JSValue res = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, res, "status", WIFEXITED(st) ? JS_NewInt32(ctx, WEXITSTATUS(st)) : JS_NULL);
	JS_SetPropertyStr(ctx, res, "signal", WIFSIGNALED(st) ? JS_NewInt32(ctx, WTERMSIG(st)) : JS_NULL);
	JS_SetPropertyStr(ctx, res, "out", JS_NewArrayBufferCopy(ctx, out.p ? out.p : (uint8_t *)"", out.n));
	JS_SetPropertyStr(ctx, res, "err", JS_NewArrayBufferCopy(ctx, err.p ? err.p : (uint8_t *)"", err.n));
	JS_SetPropertyStr(ctx, res, "timedOut", JS_NewBool(ctx, timed_out)); JS_SetPropertyStr(ctx, res, "overflow", JS_NewBool(ctx, overflow));
	free(out.p); free(err.p); free(in);
	return res;
}

/* ---- UTF-8 <-> string, native. The JS TextDecoder/TextEncoder polyfill (a per-character loop) made IPC of large messages ~60x slower than Node; QuickJS's own
 * UTF-8 routines do the same work in C. Installed as globals (__utf8Decode / __utf8Encode) so the shims can pick them up without importing this module. */
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
static JSValue js_ignore_sigpipe(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) { signal(SIGPIPE, SIG_IGN); return JS_UNDEFINED; }
static JSValue js_errname(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	int e; JS_ToInt32(ctx, &e, argv[0]); if (e < 0) { e = -e; }
	switch (e) {
#define E(x) case x: return JS_NewString(ctx, #x);
	E(ENOENT) E(EACCES) E(EAGAIN) E(EINPROGRESS) E(ECONNREFUSED) E(ECONNRESET) E(EPIPE) E(EADDRINUSE) E(EADDRNOTAVAIL) E(ENOTDIR) E(EISDIR) E(EEXIST) E(EMFILE) E(ENFILE) E(EINVAL) E(EBADF) E(ETIMEDOUT) E(ENOMEM) E(ENOTCONN) E(EINTR) E(ENOEXEC) E(E2BIG) E(ENAMETOOLONG)
#undef E
	default: return JS_NewString(ctx, "EUNKNOWN");
	}
}

static const JSCFunctionListEntry funcs[] = {
	JS_CFUNC_DEF("pipe", 0, js_pipe), JS_CFUNC_DEF("socketpair", 0, js_socketpair), JS_CFUNC_DEF("setNonblock", 2, js_set_nonblock), JS_CFUNC_DEF("setCloexec", 2, js_set_cloexec),
	JS_CFUNC_DEF("spawn", 1, js_spawn), JS_CFUNC_DEF("listen", 2, js_listen), JS_CFUNC_DEF("listenUnix", 1, js_listen_unix), JS_CFUNC_DEF("accept", 1, js_accept),
	JS_CFUNC_DEF("connect", 2, js_connect), JS_CFUNC_DEF("connectUnix", 1, js_connect_unix), JS_CFUNC_DEF("soError", 1, js_so_error), JS_CFUNC_DEF("shutdown", 2, js_shutdown),
	JS_CFUNC_DEF("sockPort", 1, js_sockport), JS_CFUNC_DEF("ignoreSigpipe", 0, js_ignore_sigpipe), JS_CFUNC_DEF("errname", 1, js_errname), JS_CFUNC_DEF("pollSync", 1, js_poll_sync),
};
static int proc_init(JSContext *ctx, JSModuleDef *m) { return JS_SetModuleExportList(ctx, m, funcs, sizeof funcs / sizeof funcs[0]); }
void spike_init_esm(JSContext *ctx);
void spike_init(JSContext *ctx) {
	spike_init_esm(ctx);
	JSValue g = JS_GetGlobalObject(ctx);
	JS_SetPropertyStr(ctx, g, "__utf8Decode", JS_NewCFunction(ctx, js_utf8_decode, "__utf8Decode", 1));
	JS_SetPropertyStr(ctx, g, "__utf8Encode", JS_NewCFunction(ctx, js_utf8_encode, "__utf8Encode", 1));
	JS_FreeValue(ctx, g);
	JSModuleDef *m = JS_NewCModule(ctx, "spike:proc", proc_init); if (m) { JS_AddModuleExportList(ctx, m, funcs, sizeof funcs / sizeof funcs[0]); }
}
