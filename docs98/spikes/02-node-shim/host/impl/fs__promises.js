import { promises } from './fs.js';
export const { stat, lstat, readdir, readFile, writeFile, mkdir, rm, rename, access, chmod, realpath, unlink, mkdtemp, open, copyFile, appendFile, readlink, symlink, utimes, rmdir, cp, chown, lchmod, lchown, link, lutimes, opendir, statfs, truncate, watch } = promises;
export default promises;
