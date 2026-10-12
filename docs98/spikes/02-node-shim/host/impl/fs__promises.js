import { promises } from './fs.js';
export const { stat, lstat, readdir, readFile, writeFile, mkdir, rm, rename, access, chmod, realpath, unlink, mkdtemp, open } = promises;
export default promises;
