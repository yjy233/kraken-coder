# `/init` And AGENT.md Technical Design

## 1. 背景与目标

Kraken Coder 需要支持 `/init` 命令，用来理解当前项目并生成项目级 Agent 指令文件 `AGENT.md`。后续 agent 运行时，system prompt 不直接注入 `AGENT.md` 全文，而是提示模型在需要项目规则时优先读取 `AGENT.md`。如果文件太长，模型需要先提炼成项目指令摘要，再基于摘要执行任务。

目标：

- 用户输入 `/init` 后，生成或更新项目级 `AGENT.md`。
- `AGENT.md` 作为 workspace 级项目说明，后续由 Agent 通过工具按需读取。
- `/init` 默认生成 reviewable change proposal，不直接写文件。
- Prompt Builder 增加项目指令读取策略，提醒 Agent 何时读取和如何提炼 `AGENT.md`。
- 首期只支持 VS Code workspace，不考虑其他 IDE。

非目标：

- 不在本阶段实现代码。
- 不让 `/init` 自动执行测试、安装依赖或修改业务代码。
- 不把 `AGENT.md` 当成隐藏配置；它应该是用户可读、可编辑、可版本化的文档。

## 2. 文件位置

项目级指令文件固定为：

```text
<workspace>/AGENT.md
```

理由：

- 文件在 workspace 根目录，模型和用户都容易发现。
- 不藏在 `kraken-coder/` 子目录里，避免项目规则不可见。
- 便于随项目提交到 Git，团队共享同一份 agent 指令。

Kraken Coder 自己的配置仍放在：

```text
<workspace>/kraken-coder/config/config.toml
```

因此 `/init` 默认创建：

```text
AGENT.md
kraken-coder/
  config/
    config.toml
  skill/
    .gitkeep
```

## 3. AGENT.md 内容结构

`AGENT.md` 应该是给 coding agent 的项目说明，不是面向用户的 README。推荐结构：

```md
# AGENT.md

## Project Overview

Describe what this project does, the main runtime, and important entry points.

## Architecture

- Summarize the main modules and ownership boundaries.
- Mention where extension code, agent runtime, tools, webview, and docs live.

## Build And Verification

- `npm run check`: TypeScript no-emit check.
- `npm run compile`: Compile extension output.

## Coding Guidelines

- Keep changes scoped to the requested behavior.
- Prefer existing project patterns before adding abstractions.
- Use reviewable change proposals for generated edits.

## Tool And Permission Notes

- This project is VS Code-only.
- API keys are stored in VS Code SecretStorage.
- Workspace TOML config overrides global TOML config.

## Known Constraints

- Do not assume browser or shell tools are enabled.
- Do not bypass reviewable changes for risky file edits.
```

内容要求：

- 使用简洁、可执行的项目规则。
- 命令必须来自项目真实文件，例如 `package.json` scripts。
- 不写 API key、token、私有凭证。
- 不写过长的文件树，文件树应该在运行时上下文里动态提供。
- 不写泛泛的 agent 行为规则，通用行为放 system prompt。

## 4. `/init` 行为设计

### 4.1 默认行为

用户输入：

```text
/init
```

执行流程：

1. 获取当前 VS Code workspace root。
2. 收集项目摘要输入：
   - 根目录文件列表。
   - `package.json` scripts 和 dependencies 摘要。
   - README、docs 入口文件摘要。
   - `tsconfig.json`、`.vscode/launch.json` 等关键配置。
   - 已有 `AGENT.md` 内容，如果存在。
3. 生成 `AGENT.md` 候选内容。
4. 生成 workspace `kraken-coder/config/config.toml` 候选内容。
5. 通过 `addChangeProposal()` 创建可审查变更。
6. 在 Chat 中说明生成了哪些文件。

默认不直接写入文件，避免覆盖用户已有项目说明。

### 4.2 已存在 AGENT.md

如果 `AGENT.md` 已存在：

- 默认不覆盖。
- 返回说明：文件已存在，建议使用 `/init --refresh` 或 `/init --force`。
- 后续可以提供 diff proposal，将新识别的信息合并进去。

### 4.3 `--refresh`

```text
/init --refresh
```

用于基于当前项目状态刷新 `AGENT.md`：

- 读取已有 `AGENT.md`。
- 保留用户手写的明确规则。
- 根据当前项目文件和 scripts 补充缺失内容。
- 创建 diff proposal。

### 4.4 `--force`

```text
/init --force
```

允许生成完整替换版 `AGENT.md`，但仍通过 reviewable change proposal 展示，不直接写入。

### 4.5 `--dry-run`

```text
/init --dry-run
```

只在 Chat 中输出将创建或更新的文件列表和摘要，不创建 change proposal。

## 5. AGENT.md 生成策略

### 5.1 MVP：模板生成

第一阶段不调用模型，直接根据项目文件生成保守模板：

- 如果存在 `package.json`，读取 scripts。
- 如果存在 `README.md`，提示用户补充项目概述，或摘取标题作为初始线索。
- 如果是 VS Code extension 项目，写入 VS Code-only 约束。
- 写入当前项目的固定验证命令。

优点：

- 不需要 API key。
- `/init` 可以在模型未配置时运行。
- 行为确定，适合作为 slash command 系统首个闭环。

缺点：

- 项目理解比较浅，`AGENT.md` 需要用户再调整。

### 5.2 增强版：模型辅助生成

第二阶段允许 `/init --ai` 或配置项启用模型辅助：

```text
/init --ai
```

模型输入：

- 项目文件树摘要。
- package scripts。
- README 和 docs 摘要。
- 已有 `AGENT.md`。
- Kraken Coder 的 `AGENT.md` 生成规范。

模型输出：

- 只输出 `AGENT.md` Markdown 文本。
- 不输出业务代码改动。
- 不编造不存在的命令。
- 不包含 secrets。

模型辅助生成也必须走 change proposal。

## 6. Prompt 读取策略

当前 `AgentRuntime` 通过 `PromptBuilder(baseSystemPrompt, tools).build()` 构造 system prompt。不要在运行前自动读取 `AGENT.md` 并塞入 system prompt，而是在 system prompt 中加入“项目指令读取策略”：

建议 system prompt 结构：

```text
<base system prompt>

## Project Instructions Policy
- If the task depends on project conventions, build commands, architecture, or repository-specific rules, first read `<workspace>/AGENT.md` with `read_file` when it exists.
- Do not assume `AGENT.md` content without reading it in the current run.
- If `AGENT.md` is long, summarize it into concise working notes before using it.
- Follow `AGENT.md` unless it conflicts with system/tool safety rules or the user's explicit request.

## Working Process
...

## Available Tools
...

## Available Skills
...

## Tool Guidelines
...
```

读取规则：

- Extension Host 不主动注入 `AGENT.md` 全文。
- Agent 在需要项目规则时使用 `read_file` 读取 `<workspace>/AGENT.md`。
- 如果 `AGENT.md` 不存在，Agent 继续按普通 workspace context 工作；可在合适时提示用户运行 `/init`。
- `AGENT.md` 优先级低于 Kraken Coder 的安全和工具权限规则，高于普通 workspace context。
- `AGENT.md` 不能扩大工具权限，不能覆盖用户本轮明确要求。

### 6.1 长文件提炼策略

如果 `AGENT.md` 内容太长，Agent 不应把全文当作长期工作上下文反复携带。读取后先提炼成短摘要：

```text
AGENT.md working notes:
- Project purpose:
- Architecture boundaries:
- Build/test commands:
- Coding rules:
- Tool/permission constraints:
- Task-relevant instructions:
```

提炼规则：

- 优先保留和当前任务相关的项目规则。
- 保留真实命令，例如 `npm run check`、`npm run compile`。
- 丢弃和当前任务无关的长背景、重复说明和完整文件树。
- 如果发现 `AGENT.md` 明显过期，例如命令不存在，应说明不一致并继续用项目真实文件校验。
- 如果摘要仍然太长，进一步压缩到 20 条以内。

## 7. Prompt 优化方向

当前基础 prompt 偏通用，需要为 coding agent 和 VS Code-only 项目做收敛。

建议 base prompt 调整为：

```text
You are Kraken Coder, a pragmatic coding agent running inside VS Code.

Your job is to help with code understanding, edits, tests, and project maintenance in the current workspace.

Follow this priority order:
1. System and tool safety rules.
2. Project instructions from AGENT.md.
3. User request.
4. Local code context and existing conventions.

Prefer reading the local project before making implementation claims. When a task depends on project-specific rules, read AGENT.md first if it exists. If AGENT.md is long, summarize the task-relevant instructions before proceeding. When edits are needed, use reviewable change proposals unless a direct file-write tool is explicitly enabled and appropriate.
```

需要新增的 prompt section：

```text
## Project Instructions Policy
- Treat AGENT.md as durable workspace guidance, but read it with tools instead of assuming it is already in context.
- If AGENT.md is long, summarize its task-relevant instructions first.
- Follow AGENT.md unless it conflicts with system safety rules or explicit user instructions.
- If AGENT.md appears outdated, mention the mismatch and ask whether to refresh it.
```

需要减少的内容：

- 避免要求模型“Always reason through your plan explicitly”，因为最终回答不需要展示完整推理。
- 把工具选择、todo 使用、web 使用放到具体 tool guidelines，而不是 base prompt 里重复。

## 8. 读取 AGENT.md 的运行时流程

每次 chat run 前不读取 `AGENT.md`。读取动作交给 Agent 在 ReAct 流程中通过工具完成。

推荐流程：

1. `PromptBuilder` 在 system prompt 中加入 `Project Instructions Policy`。
2. Agent 判断任务是否依赖项目规则。
3. 如果需要，使用 `read_file` 读取 `<workspace>/AGENT.md`。
4. 如果文件较短，直接依据内容工作。
5. 如果文件较长，先提炼 task-relevant working notes。
6. 后续执行时引用摘要，不反复携带全文。

可以新增轻量 helper，但不是必须：

```text
src/agent/project-instructions.ts
```

职责：

- 提供 prompt 文案片段。
- 定义“长文件”阈值建议，例如 20000 字符。
- 定义摘要字段模板。

不建议在 Extension Host 层缓存 `AGENT.md` 内容；用户编辑后，Agent 下次通过 `read_file` 会读取最新文件。

## 9. 与上下文系统的关系

`AGENT.md` 不是普通 context item。

区别：

- 普通 context 是本轮任务相关材料，放 user message。
- `AGENT.md` 是项目级规则，由 Agent 按需通过工具读取。
- 普通 context 受 `context.maxChars` 预算影响。
- `AGENT.md` 不占用初始 context 预算；读取后是否摘要由 Agent 决定。

后续可在 TOML 中加入：

```toml
[projectInstructions]
file = "AGENT.md"
maxChars = 20000
enabled = true
autoInject = false
```

首期可以先固定为 `AGENT.md`，不增加配置项；`autoInject` 默认应保持 `false`。

## 10. 与配置系统的关系

`/init` 生成的 `kraken-coder/config/config.toml` 应该只包含 workspace 推荐配置，不包含 secrets。

建议默认内容：

```toml
[context]
maxChars = 60000

[agent]
autoApply = false
allowTerminal = false
allowFileWriteTool = false
allowBrowserTool = false
```

不写 `[model]`：

- 模型通常是用户级偏好，适合放全局配置。
- workspace 配置写 model 容易让团队成员共享同一个私有服务地址。

## 11. UX 设计

用户输入 `/init` 后，Chat 显示：

```text
Running /init...
Inspecting workspace...
Preparing AGENT.md...
Created reviewable change proposal change_xxx.
```

如果没有 workspace：

```text
/init requires an open VS Code workspace folder.
```

如果 `AGENT.md` 已存在：

```text
AGENT.md already exists.

Use /init --refresh to propose updates, or /init --force to propose a replacement.
```

如果模型未配置：

- MVP `/init` 不受影响。
- `/init --ai` 才要求 model 和 API key。

## 12. 安全与冲突处理

- `AGENT.md` 不能提升工具权限。
- `AGENT.md` 不能要求绕过 change proposal。
- 如果 `AGENT.md` 与系统规则冲突，系统规则优先。
- 如果 `AGENT.md` 与用户本轮明确请求冲突，优先询问或说明冲突，不静默覆盖。
- 如果 `AGENT.md` 包含明显敏感信息，读取时不主动外泄；后续可以增加 secret pattern 警告。

## 13. 实施计划

第一阶段：文档和固定模板

1. 实现 slash parser 和 registry。
2. 实现 `/init` MVP。
3. 生成 `AGENT.md`、workspace `config.toml`、`kraken-coder/skill/.gitkeep` 的 change proposal。
4. 不调用模型。

第二阶段：prompt 优化

1. `PromptBuilder` 增加 `Project Instructions Policy` section。
2. 提醒 Agent 对项目相关任务优先读取 `AGENT.md`。
3. 明确长文件需要先提炼 task-relevant working notes。
4. 调整 base prompt，删除显式展示推理的要求。

第三阶段：刷新和 AI 辅助

1. `/init --refresh` 合并已有 `AGENT.md`。
2. `/init --ai` 基于项目摘要生成更准确文档。
3. 增加过期检测，例如 package scripts 变化后提示刷新。

## 14. Open Questions

- 是否需要同时兼容 `AGENTS.md`？建议首期只认 `AGENT.md`，减少规则分裂。
- 是否允许 workspace TOML 配置自定义指令文件名？建议后续再加。
- `/init --refresh` 如何识别用户手写内容和生成内容边界？建议用标题结构合并，不用隐藏 marker。
