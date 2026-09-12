import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local';
import { FsError } from '@deepseek-ai/dsh-fs';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

/** Reuses official I/O and tools, adding a task-root fence to reads AND writes. */
export default class WorkspaceFileSystem extends LocalFileSystem {
  constructor(ctx, config) {
    super(ctx, config);
    // native expands Windows 8.3 aliases, matching the official backend's fs.realpath identity.
    this.workspace = realpathSync.native(config.cwd);
  }
  assertTarget(target) {
    // This subclass knows its own LocalFileSystem backend's host path; consumers do not parse targetKey.
    const path = super.processPath(target);
    const rel = relative(this.workspace, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.split(/[\\/]/).some(part => part.toLowerCase() === '.env' || part.toLowerCase().startsWith('.env.'))) {
      throw new FsError('File access is outside the assigned task workspace or targets a credential file', 'FS_SANDBOX_DENIED');
    }
    return target;
  }
  async resolve(path, options) { return this.assertTarget(await super.resolve(path, options)); }
  async checked(target, signal) { return this.assertTarget(await super.resolve(super.processPath(target), {signal})); }
  async stat(target, signal) { return super.stat(await this.checked(target, signal), signal); }
  async lstat(path, opts, signal) { await this.resolve(path, {...opts, signal}); return super.lstat(path, opts, signal); }
  async readText(target, signal) { return super.readText(await this.checked(target, signal), signal); }
  async streamText(target, signal) { return super.streamText(await this.checked(target, signal), signal); }
  async readBytes(target, signal, maxBytes) { return super.readBytes(await this.checked(target, signal), signal, maxBytes); }
  async readByteRange(target, range, signal) { return super.readByteRange(await this.checked(target, signal), range, signal); }
  async listDir(target, signal) {
    const entries = await super.listDir(await this.checked(target, signal), signal);
    return entries.filter(entry => { try { this.assertTarget(entry.target); return true; } catch { return false; } });
  }
  async writeText(target, content, expected, signal) { return super.writeText(await this.checked(target, signal), content, expected, signal); }
  async editText(target, edit, expected, signal) { return super.editText(await this.checked(target, signal), edit, expected, signal); }
}
