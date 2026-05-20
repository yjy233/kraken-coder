# Kraken Coder Memory System Optimization Plan

## 1. 背景

Kraken Coder 已经有一版本地 memory 和 episode 机制，但当前实现更接近“读取固定 Markdown 文件并注入 prompt”。它能满足简单的用户偏好和项目事实复用，但在长期使用、跨任务召回、上下文预算控制、过期信息治理、可观察性方面还比较粗。

这份文档只梳理现状和提出优化方案，不涉及代码改动。

## 2. 当前实现现状

### 2.1 存储路径

当前 memory 分为 global 和 workspace 两层：

- Global user memory: `~/kraken-coder/memory/user.md`
- Workspace memory root: `<workspace>/.kraken-coder/memory`
- Workspace project memory: `<workspace>/.kraken-coder/memory/project.md`
- Workspace decisions memory: `<workspace>/.kraken-coder/memory/decisions.md`
- Workspace preferences memory: `<workspace>/.kraken-coder/memory/preferences.md`

Episode 存在 workspace 内：

- Episodes root: `<workspace>/.kraken-coder/episodes`
- 每个 episode 包含 `meta.toml`、`summary.md`、`changes.md`、可选 `transcript.jsonl` 和 `artifacts/`

### 2.2 配置项

Memory 配置来自 `config.toml` 和 VS Code settings：

- `memory.enabled`
- `memory.autoRead`
- `memory.maxChars`
- `memory.allowWrite`

Episode 配置：

- `episodes.enabled`
- `episodes.autoCapture`
- `episodes.autoRecall`
- `episodes.maxRecalled`
- `episodes.maxChars`
- `episodes.storeTranscript`

默认值目前偏开启：

- memory 默认启用并自动读取。
- episodes 默认启用、自动捕获、自动召回。
- memory 注入预算默认 8000 chars。
- episode 注入预算默认 12000 chars。

### 2.3 Runtime 接入

一次 agent run 的当前链路：

1. `KrakenViewProvider.runAgentForUserText()` 读取配置。
2. 计算 workspace root 和 git branch。
3. 调用 `loadMemory()` 读取 memory 文件。
4. 调用 `recallEpisodes()` 召回当前 branch 相关 episode summary。
5. 把 `memoryPromptBlock` 和 `episodesPromptBlock` 传给 `AgentRuntime.run()`。
6. `PromptBuilder` 把这两个 block 拼进 system prompt。

当前没有单独的 memory 检索阶段，也没有向量索引、关键词索引、结构化 entry 选择或动态预算分配。

### 2.4 Memory 读取

`readMemoryFiles()` 只读取固定候选文件：

1. Workspace project memory
2. Workspace decisions memory
3. Workspace preferences memory
4. Global user memory

读取后 `buildMemoryPromptBlock()` 直接按文件顺序拼接成 `## Memory` section，并按 `memory.maxChars` 做硬截断。截断只追加 `[truncated]`，不会保留索引，也不会提示模型通过工具继续读取未注入内容。

### 2.5 Memory 写入

当前写入入口主要是 slash command：

- `/memory show`
- `/memory add [--global|--workspace] <text>`
- `/memory open [--global|--workspace]`

`/memory add` 默认写 workspace project memory，格式为追加：

```md
## Notes

- YYYY-MM-DD: ...
```

已有 secret 粗过滤：

- `api_key`
- `secret`
- `token`
- `password`
- private key
- `sk-...`

当前没有 memory tool 给 agent 自主读写。`memory.allowWrite` 配置预留给未来 agent tool，slash command 不受它控制。

### 2.6 Episode 捕获和召回

完成一次 agent run 后，`recordEpisode()` 会根据配置保存 episode：

- `summary.md` 使用用户目标和最终结果拼接。
- `changes.md` 记录 tool message activity。
- `transcript.jsonl` 可选保存完整消息。
- `meta.toml` 保存 branch、title、时间和 tags。

召回时，`recallEpisodes()`：

- 读取当前 workspace episodes。
- 按 branch 过滤，允许 `unknown` branch。
- 用 query term 在 title 和 summary 中简单计分。
- 按分数和更新时间排序。
- 取 `episodes.maxRecalled` 条。
- 拼成 `## Recalled Episodes` section 并按 `episodes.maxChars` 截断。

### 2.7 Session 内优化实验实现

当前有一版 session 内优化实验实现，目标是替代原先 `history.slice(-10)` 的简单丢弃策略。该实现只作用在当前 session 的请求上下文中，不写 global/workspace memory，也不改变 episode 存储。

已落地的实验做法：

- 新增 `src/agent/session-memory.ts`。
- `AgentRuntime.run()` 在构造 agent messages 前调用 `buildSessionMemoryMessages(options.history)`。
- 以最近一条已完成的正式 assistant 回答作为锚点。
- 锚点之前的旧 session 消息被压成一条 synthetic user message，内容以 `Session history summary:` 开头。
- 锚点开始直到当前请求前的消息优先保留，包括最近正式 assistant 回答、后续用户提问和后续 tool 记录。
- 压缩摘要是本地 deterministic 文本压缩，不调用模型二次总结。
- 每条旧消息只保留 role、时间、压缩后的文本和附件摘要。
- 摘要总长度上限约 6000 chars，单条旧消息约 360 chars。
- 如果锚点之后的保留内容已经达到 `context.maxChars`，则省略旧历史 summary；否则只截断 summary，不截断锚点之后的保留内容。
- `RunResult.contextWindow` 记录 raw/effective token 估算、压缩模式、摘要消息数、保留消息数。
- `ChatSession.contextWindow` 保存最近一次 run 的 session 压缩状态。
- Webview 模型参数行显示 `mem: raw→effective`，tooltip 展示 session memory 详情。

该实现的价值：

- 不再完全丢弃较早对话。
- 最近正式 assistant 回答及其之后的用户追问和工具过程优先保留。
- 不增加模型请求次数。
- 行为可预测，成本稳定。
- 给 UI 和后续调试暴露了 session 压缩状态。

该实现的问题：

- 摘要不是语义总结，只是机械截断，容易保留无关噪音并丢失关键细节。
- synthetic user message 可能改变对话角色语义，模型可能把它当成用户新要求，而不是低优先级历史摘要。
- 没有区分用户目标、最终结论、工具错误、文件修改、命令结果等不同信息类型。
- 没有按当前任务相关性选择旧消息。
- 没有保护关键历史事实，例如用户明确约束、未完成 todo、重要文件路径。
- token 只是字符数粗估，`rawUsagePercent/effectiveUsagePercent` 当前没有真实 context window 基准。
- 压缩发生在每次 run 的输入打包阶段，压缩结果没有作为 session artifact 持久化，也没有可编辑入口。
- UI 只显示压缩比例，无法展开查看本次实际注入的 session summary。

结论：这版实现可以作为“不要直接丢掉旧消息”的过渡方案，但不应作为最终 memory 架构。后续应改成结构化 session state 和可观察的 compaction artifact。

## 3. 当前主要问题

### 3.1 Memory 和 Episode 的边界还不够强

Memory 应保存稳定事实和长期偏好，Episode 应保存一次任务过程。但现在 episode 自动捕获默认开启，summary 质量依赖最终回答，容易把短期任务状态变成长期提示噪音。

### 3.2 读取策略是全量拼接加硬截断

当前 memory 注入没有相关性排序。只要文件存在，就按固定顺序拼进去。文件变大后，后面的 global memory 或 preferences 可能被截断，模型也不知道哪些未被注入。

### 3.3 缺少结构化元数据

Markdown 易读，但当前 note 没有稳定 id、分类、来源、创建时间、更新时间、过期时间、置信度、最后使用时间等字段。后续无法可靠地更新、删除、去重、排序和清理。

### 3.4 写入是 append-only

`/memory add` 只能追加。不能更新已有条目，不能标记过期，不能删除，不能把重复记忆合并。长期使用后 memory 文件会膨胀。

### 3.5 缺少冲突检测

当前 prompt 只说明 memory 不应和当前请求、AGENT.md 冲突，但系统没有检测重复或冲突的能力。例如同一项目的 build 命令变化后，旧 memory 仍会被注入。

### 3.6 缺少可观察性

用户不知道每次请求实际注入了哪些 memory、哪些 episode、占用了多少上下文、哪些被截断。Usage tab 统计 token，但 memory 注入本身没有单独统计视图。

### 3.7 Agent 不能按需读取未注入 memory

当 memory 超过预算被截断后，没有 memory index 或 memory read tool 让 agent 再读特定文件/entry。模型只能看到截断后的片段。

### 3.8 Episode 召回质量有限

当前 episode 召回是简单关键词匹配，不考虑文件路径、工具类型、最近修改文件、任务类型、失败/成功状态、用户明确意图等信号。

### 3.9 Session 历史压缩语义不稳定

session 内历史压缩如果只是机械截断，会产生两个问题：

1. 旧消息中的真正任务状态可能被截掉。
2. 压缩后的文本如果作为普通 user message 注入，模型可能误判优先级。

更合理的方式是把 session state 拆成结构化块：

- Current task
- Active constraints
- Open todos
- Recent user preferences in this session
- Files already inspected
- Files changed
- Tool failures and unresolved errors
- Recent assistant conclusions

这些块应作为明确的 `## Session State` section 注入，而不是伪装成普通对话消息。

## 4. 优化目标

优化后的 memory system 应满足：

1. 可控：不会静默写入长期记忆，写入需要用户明确动作或确认。
2. 可查：用户能看到本次请求注入了什么 memory 和 episode。
3. 可维护：支持更新、删除、去重、过期和压缩。
4. 相关性优先：大 memory 下只注入和当前任务相关的条目。
5. 预算稳定：memory、episode、workspace context 各自有清晰预算，避免挤爆模型上下文。
6. 可迁移：兼容现有 Markdown 文件，不破坏用户已写 memory。
7. 安全：继续拒绝 secret，避免把敏感数据写进长期存储或 prompt。

## 5. 建议架构

### 5.1 三层记忆模型

建议把系统明确分成三层：

| 层级 | 用途 | 生命周期 | 默认注入 |
| --- | --- | --- | --- |
| Session Context | 当前会话消息、当前选择、诊断、workspace tree | 当前 session | 是，按 context 预算 |
| Stable Memory | 用户偏好、项目事实、长期决策 | 长期 | 是，但需要相关性选择 |
| Episodes | 历史任务摘要、变更、验证记录 | 中长期，可清理 | 只召回相关摘要 |

Stable Memory 不记录短期任务状态。Episodes 不作为规则，只作为历史参考。

### 5.2 Memory Entry 数据模型

保留 Markdown 作为用户可读主文件，同时引入可选 sidecar index。

建议 entry 模型：

```ts
interface MemoryEntry {
  id: string;
  scope: 'global' | 'workspace';
  file: 'user' | 'project' | 'decisions' | 'preferences';
  category: 'preference' | 'fact' | 'decision' | 'workflow' | 'command' | 'note';
  text: string;
  source: 'manual' | 'slash' | 'agent-suggested' | 'migration';
  tags: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
  confidence: 'high' | 'medium' | 'low';
  pinned: boolean;
  stale?: boolean;
}
```

可选 sidecar：

```text
~/kraken-coder/memory/.index.json
<workspace>/.kraken-coder/memory/.index.json
```

Markdown 继续作为事实来源，`.index.json` 只保存检索和维护元数据。没有 index 时，从 Markdown heading 和 list item 做 lazy migration。

### 5.3 Prompt 注入策略

从“拼接所有文件”改成“构建候选 entry 后选择注入”。

建议顺序：

1. Pinned workspace entries
2. Pinned global entries
3. 当前任务相关 workspace entries
4. 当前任务相关 global entries
5. 相关 episode summaries

预算建议：

```text
memory.totalBudget = memory.maxChars
memory.pinnedBudget = 30%
memory.retrievedBudget = 50%
memory.indexBudget = 20%
```

当 entry 太多时，不注入全文，而是注入一个 memory index：

```md
## Memory Index

- Project Memory has 42 entries. Top categories: commands, architecture, decisions.
- Some entries were omitted because of budget. Use memory read when needed.
```

后续如果加入 memory tool，agent 可以按 entry id 或 file 读取更多内容。

### 5.4 检索评分

首期不必上向量库，先做可解释的本地评分：

```text
score =
  keywordMatch * 4
  + pathMatch * 3
  + categoryBoost * 2
  + pinnedBoost * 5
  + workspaceScopeBoost * 2
  + recencyBoost
  - stalePenalty
```

输入信号：

- 当前 userText
- 当前 workspace context path
- 当前 git branch
- 最近 tool activity
- 当前打开文件路径
- task type hint，例如 fix/test/explain/config

### 5.5 Memory 写入策略

保持“不静默写 memory”的原则。

建议新增写入流：

1. 用户显式 `/memory add ...`
2. 用户显式 `/memory remember ...`
3. Agent 在 final answer 中给出 memory suggestions，但不自动写。
4. 用户点击确认或执行 slash command 后再写。

建议新增 slash command：

```text
/memory list [--global|--workspace]
/memory show [id]
/memory add [--global|--workspace] [--category fact|decision|workflow|preference] <text>
/memory update <id> <text>
/memory forget <id>
/memory compact [--dry-run]
/memory search <query>
```

### 5.6 Memory Tool

后续可以给 agent 增加只读优先的 memory tool：

```ts
type MemoryToolInput =
  | { action: 'index' }
  | { action: 'search'; query: string; scope?: 'global' | 'workspace' }
  | { action: 'read'; id?: string; file?: string }
  | { action: 'suggest'; text: string; category?: string }
  | { action: 'write'; text: string; scope: string; category: string; confirmationId: string };
```

默认只启用 `index/search/read/suggest`。`write` 必须同时满足：

- `memory.allowWrite = true`
- 用户在当前会话明确确认
- 内容通过 secret 检测
- 写入记录进入 audit log

### 5.7 Episode 优化

Episode 建议从“每次完成都写一份简单 summary”升级为“任务记录 + 召回索引”。

建议新增 metadata：

```ts
interface EpisodeMetaV2 {
  id: string;
  branch: string;
  title: string;
  status: 'closed' | 'interrupted' | 'error';
  taskType?: 'fix' | 'feature' | 'research' | 'config' | 'debug' | 'docs';
  filesTouched: string[];
  toolsUsed: string[];
  verificationCommands: string[];
  outcome: 'success' | 'partial' | 'failed';
  createdAt: string;
  updatedAt: string;
}
```

召回评分增加：

- 当前任务文本匹配
- 当前文件路径匹配 `filesTouched`
- 当前 branch 匹配
- 成功 outcome 优先
- 最近更新时间
- 同类 taskType

Episode summary 应避免保存大段原始 assistant 文本，优先结构化：

- Goal
- Key decisions
- Files changed
- Commands run
- Errors encountered
- Final outcome
- Follow-ups

### 5.8 可观察性

建议在 Usage 或新增 Memory tab 展示本次请求：

- 注入 memory entries 数量
- 注入 memory 字符数
- 被截断数量
- 召回 episode 数量
- episode 字符数
- 每条 memory 的 source/path/category
- 本次 query 的 top scoring entries

同时 debug trace 可以写入：

```text
~/kraken-coder/debug/memory/<run-id>.json
```

内容包括候选 entry、score、被选/被丢原因、最终 prompt block 大小。

### 5.9 Session State Compaction

session 内优化建议从“压缩旧消息”改为“维护 session state”。

建议结构：

```ts
interface SessionStateMemory {
  version: 1;
  sessionId: string;
  updatedAt: string;
  activeTask?: string;
  constraints: string[];
  openQuestions: string[];
  todos: Array<{ id: string; text: string; status: 'open' | 'done' | 'blocked' }>;
  inspectedFiles: Array<{ path: string; reason?: string; lastSeenAt: string }>;
  changedFiles: Array<{ path: string; summary: string; lastChangedAt: string }>;
  toolFailures: Array<{ tool: string; summary: string; recoverable: boolean; createdAt: string }>;
  decisions: string[];
  recentSummary: string;
}
```

生成策略：

1. 最近 N 条消息仍保留原文。
2. 更旧消息不直接机械截断，而是提取成 session state。
3. 工具事件优先结构化记录，不混在自然语言摘要里。
4. 用户明确约束和当前任务优先保留。
5. 压缩结果作为 session artifact 保存，便于 UI 展示和后续修正。

Prompt 注入建议：

```md
## Session State

This is compacted state from the current chat session. It is lower priority than the latest user message.

### Active Constraints
- ...

### Files Already Inspected
- ...

### Tool Failures To Recover From
- ...

### Recent Summary
...
```

该方案比 synthetic user message 更清晰：

- 明确优先级。
- 明确这是压缩状态，不是新用户请求。
- 可被 UI 展开检查。
- 后续可以和 memory/episode 体系复用同一套可观察性和预算打包逻辑。

## 6. 推荐落地阶段

### Phase 1: 现状可观察化

目标：不改变行为，只让用户和开发者知道发生了什么。

- 新增 memory injection debug log。
- 在 session model info 或 Usage tab 中显示 memory/episode 注入量。
- 标记 memory 是否被截断。
- 记录每次 run 注入了哪些 memory 文件和 episode id。

### Phase 1.5: Session 内 compaction 修正

目标：把当前 session 内实验实现从“机械摘要 message”调整为“结构化 Session State”。

- 移除或弱化 synthetic user message 方案。
- 新增 `SessionStateMemory` 数据结构。
- 从 session messages 和 tool messages 中提取 constraints、files、tool failures、decisions、recent summary。
- 最近 N 条消息继续原文注入。
- `## Session State` 作为独立 prompt block 注入。
- 在 UI 中允许查看本次注入的 Session State。
- `contextWindow` 使用真实模型 context window 或配置基准计算 usage percent。

### Phase 2: Entry 解析和索引

目标：从文件级注入升级到 entry 级候选。

- 解析现有 Markdown heading 和 list items。
- 生成稳定 entry id。
- 写 `.index.json` sidecar。
- 保持现有 Markdown 文件兼容。
- `/memory show` 展示 entry 而不是只展示文件。

### Phase 3: 相关性检索和预算打包

目标：让 memory 注入更准、更省。

- 实现关键词/path/category/recency/pinned 评分。
- 按预算选择 entry。
- 超预算时注入 index，不硬截断重要条目。
- Episode 召回改用增强评分。

### Phase 4: 写入和维护能力

目标：让长期 memory 可治理。

- `/memory update`
- `/memory forget`
- `/memory search`
- `/memory compact --dry-run`
- 重复 entry 检测。
- 过期 entry 标记。
- Secret 检测增强。

### Phase 5: Agent memory tool

目标：让 agent 能按需读取，不把所有 memory 都塞进 prompt。

- 增加 memory read/search tool。
- 默认禁用直接写。
- `memory.allowWrite` 只控制 agent tool 写入。
- 写入需要当前会话确认。

### Phase 6: UI 集成

目标：让用户在 Kraken Coder 里管理 memory。

- 新增 Memory tab 或扩展 Usage tab。
- 显示当前 workspace/global memory。
- 支持 open/edit/forget/search。
- 显示本次请求注入详情。

## 7. 兼容与迁移

迁移策略：

1. 不移动现有 `user.md`、`project.md`、`decisions.md`、`preferences.md`。
2. 首次运行新索引器时只读解析，生成 `.index.json`。
3. 如果 `.index.json` 缺失或损坏，回退到当前文件级读取。
4. 用户手工编辑 Markdown 后，通过 mtime/hash 触发重新索引。
5. 旧 `/memory add` 继续可用，只是追加后同步更新 index。

## 8. 安全策略

必须保留并增强 secret 检测：

- OpenAI/OpenRouter/Anthropic/Qwen key pattern
- GitHub token
- JWT
- Private key
- `.env` 风格 key-value
- Cloud credential pattern

Memory 写入前应返回明确错误，不应把疑似 secret 写入文件、prompt 或 debug log。

对于 episode transcript：

- 默认可继续保存，但建议增加 `episodes.redactSecrets = true`。
- transcript 写入前做 secret redaction。
- debug memory trace 不保存完整用户敏感内容，只保存 entry id、score 和长度。

## 9. 测试计划

单元测试：

- Markdown memory parser。
- Entry id 稳定性。
- Secret detection。
- Ranking score。
- Budget packing。
- Markdown 到 index lazy migration。
- Episode recall scoring。

集成测试：

- 有 global/workspace memory 时 prompt 注入正确。
- memory 超预算时不会硬截断 pinned entry。
- `/memory add` 后 index 更新。
- `/memory forget` 后 prompt 不再注入。
- 当前 workspace 文件路径能提高相关 entry 分数。
- episode recall 能优先召回同 branch、同文件、成功 outcome 的记录。

手动验证：

- 打开 Memory tab 可看到本次注入详情。
- 编辑 Markdown 后重新运行能感知变化。
- 大 memory 文件下请求仍然稳定。
- 疑似 secret 被拒绝写入。

## 10. 风险与决策

风险：

- 结构化 index 可能和手写 Markdown 不一致。
- 自动 compact 可能误删重要上下文。
- 召回太激进会污染 prompt。
- 召回太保守会让 memory 看起来“不生效”。
- Transcript 和 debug trace 有隐私风险。

建议决策：

- Markdown 继续作为用户可读主存储。
- Sidecar index 只做加速和治理，不作为唯一事实源。
- 不做静默长期写入。
- 先做关键词和路径检索，不立即引入向量库。
- Memory 注入必须可观察。
- Compact 默认 dry-run，用户确认后才写。

## 11. 建议优先级

最值得先做的三件事：

1. Memory 注入可观察化：先知道每次塞了什么。
2. Entry 级解析和预算打包：解决文件级硬截断。
3. `/memory search/update/forget`：解决 append-only 膨胀。

这三步完成后，再考虑 agent memory tool 和 UI 管理能力。
