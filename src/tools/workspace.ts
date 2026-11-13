import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const blocked = new Set(['.git', '.kraken-coder', 'node_modules']);
export const ignored = new Set([...blocked, 'dist', 'out', 'coverage', '.DS_Store']);
export function forbidden(part: string): boolean {
  // macOS 常用大小写不敏感文件系统，不能用 .GIT 绕过 .git 的保护。
  const normalized = part.toLowerCase();
  return blocked.has(normalized) || (normalized.startsWith('.env') && normalized !== '.env.example');
}
export function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
/** 应用层路径约束；无法替代 OS 沙箱，也不能抵御敌对进程的路径竞态。 */
export class Workspace {
  private constructor(readonly root: string) {}
  static async open(root: string): Promise<Workspace> {
    const canonical = await realpath(resolve(root));
    if (!(await lstat(canonical)).isDirectory()) throw new Error('Workspace must be a directory');
    return new Workspace(canonical);
  }
  async path(input: string, allowRoot = false): Promise<string> {
    if (!input || input.includes('\0') || input.includes('\\') || isAbsolute(input)) throw new Error('Use a workspace-relative path');
    const parts = input.split('/');
    if (parts.some(p => p === '..' || forbidden(p))) throw new Error('Protected or escaping path');
    const target = resolve(this.root, input);
    const rel = relative(this.root, target);
    if (rel.startsWith('..' + sep) || isAbsolute(rel) || (!rel && !allowRoot)) throw new Error('Path is outside workspace or is its root');
    let current = this.root;
    for (const part of rel.split(sep).filter(Boolean)) {
      current = join(current, part);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) throw new Error('Symbolic links are not supported by workspace tools');
        if (!stat.isDirectory() && !stat.isFile()) throw new Error('Special files are not supported');
        if (stat.isFile() && stat.nlink > 1) throw new Error('Hard-linked files are not supported');
      } catch (error) { if (!isMissing(error)) throw error; }
    }
    return target;
  }
  async read(path: string): Promise<string> {
    const full = await this.path(path);
    const stat = await lstat(full);
    if (!stat.isFile() || stat.size > 256_000) throw new Error('Expected a text file no larger than 256 KB');
    const body = await readFile(full, 'utf8');
    if (body.includes('\0')) throw new Error('Binary files are not supported');
    return body;
  }
  async files(path = '.', limit = 1000): Promise<{ files: string[]; truncated: boolean }> {
    const start = await this.path(path, true), files: string[] = [];
    let visited = 0, truncated = false;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 20 || visited > 10_000) { truncated = true; return; }
      const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (++visited > 10_000 || files.length >= limit) { truncated = true; return; }
        if (e.isSymbolicLink() || ignored.has(e.name) || forbidden(e.name)) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full, depth + 1);
        else if (e.isFile()) files.push(relative(this.root, full).split(sep).join('/'));
      }
    };
    await walk(start, 0); return { files, truncated };
  }
}
