export class Mutex { constructor(name) { this.name = name; } release() { } }
export function isActive() { return false; }
export default { Mutex, isActive };
