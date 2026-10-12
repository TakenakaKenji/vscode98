// Descriptor I/O used by the stream classes: qjs:os on POSIX; on Windows spike:proc's own table of pipe handles (winproc.c), whose reads/writes are completed by the event loop.
import * as os from 'qjs:os';
import * as p from 'spike:proc';
const win = os.platform === 'win32';
export const read = win ? p.read : os.read, write = win ? p.write : os.write, close = win ? p.close : os.close;
export const setReadHandler = win ? p.setReadHandler : os.setReadHandler, setWriteHandler = win ? p.setWriteHandler : os.setWriteHandler;
export const isWindows = win;
