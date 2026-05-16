# Memory System Technical Design

## 1. 背景与目标

Kraken Coder 需要一个轻量 memory system，用来保存稳定、可复用的信息，让 agent 在后续对话和后续 workspace 会话里能继承用户偏好和项目约定。

Memory 不是聊天记录归档，也不是替代 `AGENT.md`。它的目标是保存长期有效、可编辑、可审查的事实：

- 用户偏好：例如默认用中文回答、不要在设计阶段改代码。
- 项目事实：例如项目是 VS Code extension、入口文件是 `src/extension.ts`。
- 工作约定：例如改 TypeScript 后运行 `npm run check` 和 `npm run compile`。
- 历史决策：例如 skills 目录统一使用复数 `skills`。

首期目标：

- 支持 global memory 和 workspace memory 两层。
- 使用 Markdown 文件存储，方便用户直接阅读和编辑。
- Agent run 时自动读取 memory，并按预算注入 system prompt。
- 支持 episode 存储单元，按分支/任务保存对话摘要、变更和验证信息，方便后续召回。
- 提供 slash command 查看和追加 memory。
- 写入 memory 必须显式触发，不做静默自动记忆。

非目标：

- 首期不做向量数据库或语义检索。
- 首期不保存完整聊天记录。
- 首期不自动从对话中提取并写入 memory。
- 首期不跨 IDE，只支持 VS Code。
- 首期不让 Webview 直接读写 memory 文件。

## 2. Memory 类型

长期 memory 分为两类：

1. Global memory：跨 workspace 的用户偏好和通用工作习惯。
2. Workspace memory：当前 workspace 的项目事实、约定和决策。

推荐语义：

- Global memory 记录用户个人偏好，不记录具体项目实现细节。
- Workspace memory 记录项目相关事实，不记录私密账号、API key、token。
- `AGENT.md` 仍然是项目显式规则，适合进入仓库。
- Memory 默认是本地数据，适合放在 `.gitignore` 中。

另有 episode storage，用来保存每个分支、每轮任务或每段对话的独立存储单元：

- Episode 记录一次任务的 goal、summary、decisions、changed files、commands、follow-ups。
- Episode 可以保存 transcript，但 prompt 召回默认只使用 `summary.md`。
- Episode 不参与长期规则优先级，只作为可召回上下文。
- 一个 Git branch 可以对应多个 episode。

边界：

- Memory：稳定偏好和项目事实。
- Session：用户可切换的聊天状态，保存 messages、context、change proposals。
- Episode：一次任务/对话的过程和结果。
- `AGENT.md`：项目长期规则。

## 3. 路径设计

路径沿用 Kraken Coder 的 global/workspace 目录风格：

```text
~/kraken-coder/
  memory/
    user.md

<workspace>/.kraken-coder/
  memory/
    project.md
    decisions.md
    preferences.md
  sessions/
    session_xxx.json
  episodes/
    2026-05-16-153000-implement-skill-system/
      meta.toml
      summary.md
      transcript.jsonl
      changes.md
      artifacts/
```

路径说明：

- Global memory root: `~/kraken-coder/memory`
- Global user memory: `~/kraken-coder/memory/user.md`
- Workspace memory root: `<workspace>/.kraken-coder/memory`
- Workspace project memory: `<workspace>/.kraken-coder/memory/project.md`
- Workspace decisions memory: `<workspace>/.kraken-coder/memory/decisions.md`
- Workspace preferences memory: `<workspace>/.kraken-coder/memory/preferences.md`
- Workspace sessions root: `<workspace>/.kraken-coder/sessions`
- Workspace episodes root: `<workspace>/.kraken-coder/episodes`

首期只需要支持这些固定文件。后续可以支持 `*.md` 扫描。

Episode id 建议格式：

```text
YYYY-MM-DD-HHMMSS-short-title
```

例如：

```text
2026-05-16-153000-implement-skill-system
```

## 4. 优先级与冲突规则

Prompt 冲突优先级：

1. System 和 tool 安全规则。
2. 当前用户请求。
3. `AGENT.md` 项目说明。
4. Workspace memory。
5. Global memory。
6. 通用 agent prompt。

解释：

- 当前用户请求优先于旧 memory。
- `AGENT.md` 是项目显式文档，优先于本地 memory。
- Workspace memory 比 global memory 更具体。
- Memory 不能绕过工具权限、沙箱策略、模型安全规则。

当 memory 和当前用户请求冲突时，agent 应遵循当前请求，并在必要时提示 memory 可能过期。

## 5. 文件格式

Memory 使用 Markdown，不使用 TOML/JSON。

原因：

- Memory 是给 AI 和用户共同阅读的自然语言内容。
- Markdown 方便手工编辑。
- 标题分区足够支持首期半结构化读取。
- 后续可以按 heading 做 section replace。

Global memory 示例：

```md
# User Memory

## Preferences

- Prefer Chinese responses unless the user asks otherwise.
- Do not change code when the user asks for a design only.

## Workflow

- Prefer focused implementation with verification.
- Mention commands that were run before finishing.
```

Workspace memory 示例：

```md
# Project Memory

## Stable Facts

- This project is a VS Code extension.
- The extension entrypoint is `src/extension.ts`.
- The chat webview HTML is generated from `src/webview/html.ts`.

## Commands

- Type check: `npm run check`
- Compile: `npm run compile`

## Decisions

- Skills use plural `skills` directories.
- Built-in skills live under `resources/skills`.
```

Episode 使用一个目录表示一次任务或对话。`summary.md` 用于召回，`transcript.jsonl` 用于审计和细节恢复，`changes.md` 用于快速理解代码影响。

Episode `meta.toml` 示例：

```toml
id = "2026-05-16-153000-implement-skill-system"
branch = "main"
title = "Implement skill system"
createdAt = "2026-05-16T15:30:00+08:00"
updatedAt = "2026-05-16T16:20:00+08:00"
status = "closed"
tags = ["skills", "runtime", "vscode"]
```

Episode `summary.md` 示例：

```md
# Implement Skill System

## User Goal

Support workspace, global, and built-in skills.

## Decisions

- Workspace skills override global and built-in skills.
- Built-in skills live in `resources/skills`.
- New skill directories use plural `skills`.

## Files Changed

- `src/skills/paths.ts`
- `src/vscode/agentTools.ts`
- `resources/skills/...`

## Verification

- `npm run check`
- `npm run compile`

## Follow-ups

- Design memory system.
```

Episode `transcript.jsonl` 示例：

```jsonl
{"role":"user","content":"支持skill系统...","createdAt":"2026-05-16T15:30:00+08:00"}
{"role":"assistant","content":"已实现...","createdAt":"2026-05-16T16:20:00+08:00"}
```

Episode `changes.md` 示例：

```md
# Changes

## Modified Files

- `src/skills/paths.ts`: added discovery dirs and priority rules.
- `src/vscode/agentTools.ts`: returns availableSkills with tools.

## Commands

- `npm run check`
- `npm run compile`
```

## 6. Runtime 注入策略

Agent run 时读取 memory，并注入 system prompt 的 `## Memory` section。Episode recall 使用独立 section，避免把长期记忆和任务记录混在一起。

MVP 策略：

1. 读取 global `user.md`。
2. 读取 workspace `project.md`、`decisions.md`、`preferences.md`。
3. 查找当前 Git branch 最近的 episode summaries。
4. 合并成 memory block 和 episode recall block。
5. 分别按 `memory.maxChars` 和 `episodes.maxChars` 截断。
6. 传给 `PromptBuilder`，追加到 tools/skills 指南之前或之后。

建议 prompt 结构：

```text
## Memory

These are persistent notes. Follow them only when they do not conflict with system rules, tool rules, AGENT.md, or the current user request.

### Workspace Memory
...

### Global Memory
...

## Recalled Episodes

These are summaries of previous task conversations. Use them as context only; verify local files before relying on implementation details.

### 2026-05-16-153000-implement-skill-system
...
```

截断策略：

- 优先保留 workspace memory。
- 再保留 global memory。
- Episode recall 只读取 `summary.md`，不默认注入完整 transcript。
- Episode 按当前 Git branch、更新时间、关键词相关性排序。
- 单个文件过长时保留开头和最近追加段落。
- 截断时明确标记 `[truncated]`。

后续优化：

- Memory 超过预算时，不直接注入全部内容。
- Prompt 只注入 memory 文件索引，提示 agent 使用 memory tool 读取相关文件。
- 增加摘要文件，例如 `summary.md`。

## 7. 写入策略

Memory 写入必须显式触发。

允许写入的入口：

- Slash command：`/memory add ...`
- 后续 memory tool：仅在用户明确授权时写入。
- Change proposal：对 workspace memory 的写入可以走 reviewable proposal。

不允许：

- Agent 根据对话内容静默写 memory。
- Webview 直接写文件。
- 将 API key、token、密码等敏感信息写入 memory。

写入默认 scope：

- `/memory add ...` 默认写 workspace memory。
- 用户明确说“全局记住”时写 global memory。
- 用户明确说“项目里记住”时写 workspace memory。

追加格式：

```md
## Notes

- 2026-05-16: Use `npm run check` before finishing TypeScript changes.
```

日期使用本地日期，便于后续清理过期 memory。

## 8. Slash Commands

建议新增命令：

```text
/memory
/memory show
/memory add <text>
/memory add --global <text>
/memory add --workspace <text>
/memory open
/memory clear --workspace
```

MVP 实现：

- `/memory`：显示帮助。
- `/memory show`：展示当前会读取的 memory 文件摘要。
- `/memory add <text>`：追加到 workspace memory。
- `/memory add --global <text>`：追加到 global `user.md`。
- `/memory open`：打开 workspace memory 文件；没有则创建。

`clear` 属于高风险操作，首期可以只设计不实现。

## 9. Tool 接口设计

后续可以新增 `memory` tool，供 agent 在需要时读取或写入 memory。

```ts
interface MemoryToolInput {
  action: 'read' | 'append' | 'replace_section';
  scope: 'workspace' | 'global';
  file?: 'user.md' | 'project.md' | 'decisions.md' | 'preferences.md';
  section?: string;
  content?: string;
}
```

行为：

- `read`：读取指定 scope/file 或返回 memory 索引。
- `append`：追加内容，需要用户明确授权或 slash command 上下文。
- `replace_section`：替换 Markdown heading section，首期不实现。

ToolContext 需要增加：

```ts
memory: {
  globalRoot: string;
  workspaceRoot?: string;
  allowWrite: boolean;
}
```

首期可以先不加 tool，只做 runtime 自动读取和 slash command。

## 10. 配置设计

在 `config.toml` 中新增：

```toml
[memory]
enabled = true
autoRead = true
maxChars = 8000
allowWrite = false

[episodes]
enabled = true
autoCapture = true
autoRecall = true
maxRecalled = 3
maxChars = 12000
storeTranscript = true
```

字段说明：

- `enabled`：总开关。
- `autoRead`：agent run 时是否自动读取并注入 memory。
- `maxChars`：注入 prompt 的最大字符数。
- `allowWrite`：是否允许 agent tool 写 memory。Slash command 不受该字段影响，但仍需显式命令触发。

Episode 字段说明：

- `episodes.enabled`：episode system 总开关。
- `episodes.autoCapture`：是否自动保存对话摘要、变更和验证信息。
- `episodes.autoRecall`：agent run 时是否自动召回相关 episode summary。
- `episodes.maxRecalled`：每次请求最多召回的 episode 数量。
- `episodes.maxChars`：episode recall 注入 prompt 的最大字符数。
- `episodes.storeTranscript`：是否保存完整对话 transcript JSONL。

默认值：

```text
enabled = true
autoRead = true
maxChars = 8000
allowWrite = false

episodes.enabled = true
episodes.autoCapture = true
episodes.autoRecall = true
episodes.maxRecalled = 3
episodes.maxChars = 12000
episodes.storeTranscript = true
```

VS Code settings 可以提供同名配置：

```text
kraken.memory.enabled
kraken.memory.autoRead
kraken.memory.maxChars
kraken.memory.allowWrite
kraken.episodes.enabled
kraken.episodes.autoCapture
kraken.episodes.autoRecall
kraken.episodes.maxRecalled
kraken.episodes.maxChars
kraken.episodes.storeTranscript
```

TOML 优先于 VS Code settings，沿用现有 config precedence。

## 11. 模块设计

建议新增：

```text
src/memory/
  types.ts
  paths.ts
  reader.ts
  writer.ts
  markdown.ts

src/episodes/
  types.ts
  paths.ts
  recorder.ts
  recall.ts
  summarizer.ts

src/slash/builtins/
  memory.ts
  episodes.ts
```

职责：

- `types.ts`：定义 memory scope、file、config、loaded memory。
- `paths.ts`：计算 global/workspace memory 路径。
- `reader.ts`：读取、预算截断、合并 memory block。
- `writer.ts`：创建目录、追加 note、打开文件。
- `markdown.ts`：heading section 查找和替换，后续使用。
- `memory.ts`：slash command 实现。
- `episodes/paths.ts`：计算 workspace episode root 和 episode id。
- `episodes/recorder.ts`：保存 transcript、summary、changes。
- `episodes/recall.ts`：按 branch、更新时间、关键词召回 episode summaries。
- `episodes/summarizer.ts`：从会话结果生成或更新 summary。
- `episodes.ts`：slash command 实现，例如 `/episodes list`、`/episodes show`。

`PromptBuilder` 增加输入：

```ts
new PromptBuilder(basePrompt, tools, skills, memory)
```

`AgentRuntime.run()` 增加：

```ts
memory?: LoadedMemory
recalledEpisodes?: RecalledEpisode[]
```

`KrakenViewProvider.sendChat()` 在调用 runtime 前读取 memory。
Episode recorder 在 agent run 完成后记录本次用户目标、assistant 结果、工具活动、变更和验证命令。

## 12. AGENT.md、Skills 与 Memory 的边界

`AGENT.md`：

- 项目级显式规则。
- 适合提交到仓库。
- 由 `/init` 创建和维护。

Skills：

- 描述 agent 能力和专项工作流。
- 可以有 references/scripts/assets。
- 不应记录某个 workspace 的临时事实。

Memory：

- 本地持久信息。
- 适合用户偏好、项目事实、历史决策。
- 默认不提交到仓库。

冲突处理：

- 如果 memory 与 `AGENT.md` 冲突，遵循 `AGENT.md`。
- 如果 memory 与用户当前请求冲突，遵循当前请求。
- 如果 memory 看起来过期，agent 应说明并优先验证本地文件。

## 13. 安全与隐私

Memory 不应保存：

- API keys、tokens、passwords。
- 个人隐私数据。
- 未经用户确认的外部服务凭据。
- 大段源码或第三方文档。

写入前检查：

- 如果内容疑似 secret，拒绝写入并提示用 SecretStorage 或环境变量。
- 如果内容过长，提示用户改为项目文档或 reference 文件。
- 如果内容是临时任务状态，建议放在当前对话，不写入 memory。

## 14. 测试计划

静态验证：

- `npm run check`
- `npm run compile`

单元/行为场景：

- 没有 memory 文件时，agent run 正常，不注入空 section。
- 只有 global memory 时，prompt 包含 Global Memory。
- 只有 workspace memory 时，prompt 包含 Workspace Memory。
- workspace + global 同时存在时，workspace 排在前面。
- memory 超过 `maxChars` 时被截断并标记 `[truncated]`。
- 当前 Git branch 有 episode summary 时，prompt 包含 Recalled Episodes。
- episode recall 只注入 `summary.md`，不默认注入 `transcript.jsonl`。
- `episodes.maxRecalled` 会限制召回数量。
- `/memory show` 展示读取到的文件和字符数。
- `/memory add hello` 创建 workspace memory 并追加。
- `/memory add --global hello` 创建 global memory 并追加。
- memory 中疑似 secret 的内容不写入。
- episode recorder 创建 `meta.toml`、`summary.md`、`changes.md`。
- `episodes.storeTranscript = false` 时不写 `transcript.jsonl`。

手动场景：

- 在 VS Code Extension Host 中打开 workspace，创建 `.kraken-coder/memory/project.md`，确认后续提问能读到项目事实。
- 修改 `~/kraken-coder/memory/user.md`，确认跨 workspace 生效。
- 在同一 Git branch 完成一次任务后，新会话能召回最近 episode summary。
- 当前用户请求与 memory 冲突时，agent 遵循当前请求。

## 15. 分阶段实现

第一阶段：文档和配置

- 写本文档。
- 更新 `config.example.toml`。
- 更新 `docs/configs-and-workspace.md`。

第二阶段：只读 runtime 注入

- 新增 `src/memory/*`。
- 实现 global/workspace memory 路径。
- 实现读取和预算截断。
- `PromptBuilder` 注入 `## Memory`。

第三阶段：Episode capture 和 recall

- 新增 `src/episodes/*`。
- 每次 agent run 后创建或更新 episode。
- 记录 `meta.toml`、`summary.md`、`changes.md`。
- 按当前 Git branch 召回最近 episode summaries。

第四阶段：Slash command

- 新增 `/memory` command。
- 支持 `show`、`add`、`open`。
- 写入时创建目录和文件。
- 新增 `/episodes` command。
- 支持 `list`、`show`、`open`。

第五阶段：Tool 化

- 新增 `memory` tool。
- 默认只启用 read。
- append/replace 受 `memory.allowWrite` 控制。
- 新增 `episodes` tool 或扩展 `memory` tool，用于读取 episode summary/transcript。

第六阶段：摘要和维护

- Memory 超长时生成摘要候选。
- 支持 section replace。
- 支持过期 memory 清理建议。
- Episode 过多时生成 branch summary 或归档旧 episode。
