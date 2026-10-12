// Skeleton `https` (see http.js).
import { Agent as HttpAgent, Server as HttpServer } from './http.js';
export class Agent extends HttpAgent { }
export class Server extends HttpServer { }
export const globalAgent = new Agent();
const unsupported = (what) => () => { const e = new Error(`${what} is not implemented in this host yet`); e.code = 'ERR_NOT_IMPLEMENTED'; throw e; };
export const request = unsupported('https.request'), get = unsupported('https.get'), createServer = unsupported('https.createServer');
export default { Agent, Server, globalAgent, request, get, createServer };
