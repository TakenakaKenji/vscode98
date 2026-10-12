// Skeleton `http`: real classes/constants so interop helpers (__importStar) and `extends http.Agent` work; no networking (request/get/createServer throw).
import { EventEmitter } from './events.js';
export const METHODS = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'];
export const STATUS_CODES = { 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error' };
const unsupported = (what) => () => { const e = new Error(`${what} is not implemented in this host yet`); e.code = 'ERR_NOT_IMPLEMENTED'; throw e; };
export class Agent extends EventEmitter { constructor(options) { super(); this.options = options || {}; this.requests = {}; this.sockets = {}; this.freeSockets = {}; this.maxSockets = Infinity; } destroy() { } }
export class Server extends EventEmitter { listen() { return unsupported('http.Server#listen')(); } close(cb) { if (cb) { cb(); } return this; } closeAllConnections() { } address() { return null; } }
export class IncomingMessage extends EventEmitter { }
export class ServerResponse extends EventEmitter { }
export class ClientRequest extends EventEmitter { }
export const globalAgent = new Agent();
export const request = unsupported('http.request'), get = unsupported('http.get'), createServer = unsupported('http.createServer');
export default { METHODS, STATUS_CODES, Agent, Server, IncomingMessage, ServerResponse, ClientRequest, globalAgent, request, get, createServer };
