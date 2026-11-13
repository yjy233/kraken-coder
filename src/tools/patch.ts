import { lstat, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Algorithms } from '../core/types.js';
import { isMissing, Workspace } from './workspace.js';
export interface Change { path: string; before: string | null; after: string | null; mode: number }
/** Codex patch 的明确子集：Add/Delete/Update + @@ 精确上下文；不支持 Move/模糊匹配。 */
export async function preparePatch(workspace: Workspace, patch: string, replace: Algorithms['replaceText']): Promise<Change[]> {
  const lines = patch.replace(/\r\n/g, '\n').trimEnd().split('\n');
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') throw new Error('Expected Begin/End Patch markers');
  const changes: Change[] = [], seen = new Set<string>();
  let i = 0;
  while (i < lines.length) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[i++]!);
    if (!header) throw new Error('Expected Add/Update/Delete File header');
    const operation = header[1]!, path = header[2]!;
    const full = await workspace.path(path);
    if (seen.has(full)) throw new Error('Duplicate target in patch');
    seen.add(full);
    let before: string | null = null, mode = 0o644;
    try { before = await workspace.read(path); mode = (await lstat(full)).mode & 0o777; }
    catch (error) { if (!isMissing(error)) throw error; }
    if (operation === 'Add' && before !== null) throw new Error('Add target already exists');
    if (operation !== 'Add' && before === null) throw new Error('Patch target does not exist');
    let after: string | null = before;
    if (operation === 'Add') {
      const added: string[] = [];
      while (i < lines.length && !lines[i]!.startsWith('*** ')) {
        const line = lines[i++]!;
        if (!line.startsWith('+')) throw new Error('Add lines must begin with +');
        added.push(line.slice(1));
      }
      if (!added.length) throw new Error('Add requires at least one + line');
      after = added.join('\n') + '\n';
    } else if (operation === 'Delete') after = null;
    else {
      let hunks = 0;
      while (i < lines.length && !lines[i]!.startsWith('*** ')) {
        if (lines[i++] !== '@@') throw new Error('Update hunks must start with bare @@');
        const oldLines: string[] = [], newLines: string[] = [];
        let modified = false;
        while (i < lines.length && lines[i] !== '@@' && !lines[i]!.startsWith('*** ')) {
          const line = lines[i++]!, prefix = line[0];
          if (prefix !== ' ' && prefix !== '+' && prefix !== '-') throw new Error('Invalid patch line');
          if (prefix !== '+') oldLines.push(line.slice(1));
          if (prefix !== '-') newLines.push(line.slice(1));
          if (prefix !== ' ') modified = true;
        }
        if (!oldLines.length || !modified) throw new Error('Update needs old context and a change');
        // 匹配整行边界，防止 a 被替换到 data 的中间；支持没有末尾换行的文件。
        const normalized = after!.replace(/\r\n/g, '\n');
        const ended = normalized.endsWith('\n');
        const framed = '\n' + normalized + (ended ? '' : '\n');
        const oldText = '\n' + oldLines.join('\n') + '\n';
        const newText = newLines.length ? '\n' + newLines.join('\n') + '\n' : '\n';
        let result = replace(framed, oldText, newText).slice(1);
        if (!ended && result.endsWith('\n')) result = result.slice(0, -1);
        after = before!.includes('\r\n') ? result.replace(/\n/g, '\r\n') : result;
        hunks++;
      }
      if (!hunks) throw new Error('Update requires a hunk');
    }
    changes.push({ path, before, after, mode });
  }
  if (!changes.length || changes.length > 32) throw new Error('Patch needs 1–32 files');
  return changes;
}

export async function applyChanges(workspace: Workspace, changes: Change[], signal: AbortSignal): Promise<string[]> {
  // 审批期间用户可能改了文件：全部预检后才开始写。
  for (const c of changes) {
    signal.throwIfAborted();
    let current: string | null = null;
    try { current = await workspace.read(c.path); } catch (error) { if (!isMissing(error)) throw error; }
    if (current !== c.before) throw new Error(`File changed since patch preview: ${c.path}`);
  }
  const applied: string[] = [];
  for (const c of changes) {
    signal.throwIfAborted();
    const full = await workspace.path(c.path);
    if (c.after === null) await unlink(full);
    else {
      await mkdir(dirname(full), { recursive: true });
      const temp = full + '.kraken-' + randomUUID();
      try {
        await writeFile(temp, c.after, { flag: 'wx', mode: c.mode });
        await rename(temp, full);
      } finally { await unlink(temp).catch(error => { if (!isMissing(error)) throw error; }); }
    }
    applied.push(c.path);
  }
  return applied;
}
