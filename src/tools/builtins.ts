import type { Algorithms, Emit } from '../core/types.js';
import { Instructions, type Skill } from '../context/instructions.js';
import { Workspace } from './workspace.js';
import { applyChanges, preparePatch } from './patch.js';
import { runShell } from './shell.js';
import { integer, params, str, ToolRegistry } from './registry.js';
export function registerBuiltins(registry: ToolRegistry, workspace: Workspace, algorithms: Algorithms, instructions: Instructions, skills: Skill[], emit: Emit): void {
  registry.register({ name: 'list_files', effect: 'read', description: 'List workspace text/code paths; skips .git, .env, node_modules, generated output and symlinks. Bounded traversal; not gitignore-aware.',
    parameters: params({ path: str() }, []),
    async prepare(a) { return { preview: String(a.path ?? '.'), run: async () => workspace.files(a.path as string ?? '.') }; },
  });
  registry.register({ name: 'read_file', effect: 'read', description: 'Read a text file with line numbers and applicable AGENTS.md. Use start_line/limit for pagination.',
    parameters: params({ path: str(), start_line: integer(1, 1_000_000), limit: integer(1, 400) }, ['path']),
    async prepare(a) { return { preview: String(a.path), run: async () => {
      const path = a.path as string, body = await workspace.read(path), lines = body.split('\n');
      const start = (a.start_line as number ?? 1) - 1, limit = a.limit as number ?? 120;
      const result = { path, instructions: await instructions.forPath(path, false), totalLines: lines.length, content: lines.slice(start, start + limit).map((line, i) => `${start + i + 1}: ${line}`).join('\n'), hasMore: start + limit < lines.length };
      // 通用输出截断可能切掉目录指令；只有确认完整交付才标记已读。
      // 长文件仍可查看，随后用 project_instructions 单独读取指令链。
      if (JSON.stringify(result).length <= 19_000) instructions.markRead(result.instructions);
      return result;
    } }; },
  });
  // 搜索文件内容中的文字，不按文件名匹配。
  // 例如 { query: 'runLoop', path: 'src' }：在 src 目录下查找包含 runLoop 的代码行。
  // query 是必填关键词；path 是可选的搜索目录，省略时从工作区根目录开始。
  registry.register({ name: 'search', effect: 'read', description: 'Search literal text (not regex) in up to 1000 workspace files; set ignore_case to true for case-insensitive matching; return at most 80 line matches.',
    parameters: params({ query: str(500), path: str(), ignore_case: { type: 'boolean' } }, ['query']),
    async prepare(a) {
      const query = a.query as string;
      if (!query.length) throw new Error('Search query cannot be empty');
      const ignoreCase = a.ignore_case === true, needle = ignoreCase ? query.toLowerCase() : query;
      return { preview: query, run: async signal => {
        // 先枚举候选文件（默认最多 1000 个，跳过受保护和生成目录等），此时还没有匹配关键词。
        const listing = await workspace.files(a.path as string ?? '.');
        const matches: unknown[] = []; let skipped = 0;
        for (const path of listing.files) {
          signal.throwIfAborted();
          let body: string;
          // 再读取文件内容；读取失败（如文件过大或含 NUL）就跳过，skipped 记录这类文件数。
          try { body = await workspace.read(path); } catch { skipped++; continue; }
          // 默认区分大小写；ignore_case 只规范化匹配副本，不修改返回的原文。始终不做正则匹配。
          for (const [i, line] of body.split('\n').entries()) if ((ignoreCase ? line.toLowerCase() : line).includes(needle)) {
            // 每个命中行返回文件路径、从 1 开始的行号、该行前 400 个字符，供模型继续 read_file。
            matches.push({ path, line: i + 1, text: line.slice(0, 400) });
            // 达到 80 条命中行就提前返回；truncated 提醒模型结果可能不完整。
            if (matches.length === 80) return { matches, truncated: true, skipped };
          }
        }
        // 即使命中很少，文件枚举也可能提前结束；空结果不能证明整个项目不存在该关键词。
        return { matches, truncated: listing.truncated, skipped };
      } };
    },
  });
  registry.register({ name: 'project_instructions', effect: 'read', description: 'Read scoped AGENTS.md chain for a target file, including a file that does not exist yet.',
    parameters: params({ path: str() }),
    async prepare(a) { return { preview: String(a.path), run: async () => instructions.forPath(a.path as string) }; },
  });
  registry.register({ name: 'apply_patch', effect: 'write', description: 'Apply exact-context Add/Update/Delete patches. All targets are validated before approval. Read target instructions first. No Move or fuzzy hunks.',
    parameters: params({ patch: str(90_000) }),
    async prepare(a) {
      const changes = await preparePatch(workspace, a.patch as string, algorithms.replaceText);
      for (const c of changes) await instructions.requireRead(c.path);
      return { preview: a.patch as string, run: async signal => {
        for (const c of changes) await instructions.requireRead(c.path);
        const paths = await applyChanges(workspace, changes, signal);
        emit({ type: 'files.changed', paths }); return { paths };
      } };
    },
  });
  registry.register({ name: 'shell', effect: 'shell', description: 'Execute a local /bin/sh command in the workspace. NOT sandboxed. Requires explicit shell enablement and policy approval. Output and time are bounded.',
    parameters: params({ command: str(8000), timeout_ms: integer(1, 120_000) }, ['command']),
    async prepare(a) { return { preview: `cwd: ${workspace.root}\n$ ${a.command}`, run: async signal => runShell(a.command as string, workspace.root, a.timeout_ms as number ?? 30_000, signal) }; },
  });
  registry.register({ name: 'update_plan', effect: 'state', description: 'Replace the task plan with 1–12 steps, at most one in_progress.',
    parameters: params({ steps: { type: 'array', maxItems: 12, items: params({ step: str(500), status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }) } }),
    async prepare(a) {
      const steps = a.steps as { step: string; status: string }[];
      if (!steps.length || steps.some(s => !s.step.trim()) || steps.filter(s => s.status === 'in_progress').length > 1) throw new Error('Plan needs nonempty steps and at most one in_progress');
      return { preview: JSON.stringify(steps), run: async () => { emit({ type: 'plan.updated', steps }); return { steps }; } };
    },
  });
  registry.register({ name: 'read_skill', effect: 'read', description: 'Load the full body of a skill from the advertised workspace catalog.',
    parameters: params({ name: str(64) }),
    async prepare(a) {
      const skill = skills.find(s => s.name === a.name);
      if (!skill) throw new Error('Unknown skill');
      return { preview: skill.path, run: async () => ({ ...skill, content: await workspace.read(skill.path) }) };
    },
  });
}
