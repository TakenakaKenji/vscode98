export function getProcessTree(rootPid, callback) { callback?.(undefined); }
export function getProcessList(rootPid, callback) { callback?.([]); }
export function getProcessCpuUsage(list, callback) { callback?.([]); }
export default { getProcessTree, getProcessList, getProcessCpuUsage };
