# Slash Commands Technical Design

## 1. 背景与目标

Kraken Coder 需要支持类似 Claude Code 的 slash commands，让用户可以在 Chat 输入框里输入 `/init`、`/help` 这类短命令触发固定工作流。

Slash command 的核心价值不是替代自然语言，而是给常用任务一个稳定入口：

- `/init`：初始化当前 workspace 的 Kraken Coder 项目说明和配置骨架。
- `/help`：展示可用命令。
- `/clear`：清空当前会话。
- `/config`：打开或创建配置文件。
- `/context`：查看或刷新当前上下文。

首期目标：

- 在 Webview Chat 输入中识别以 `/` 开头的命令。
- 支持内置命令注册、参数解析、执行、错误展示。
- 首先实现 `/init` 的技术路径，生成 workspace 级别的 Kraken 文件。
- 命令执行仍然通过 Extension Host，不让 Webview 直接读写文件。
- 兼容现有 Agent Runtime、tools、TOML config、skills 系统。

非目标：

- 首期不实现 shell 风格的完整解析器。
- 首期不做跨 IDE 支持，只支持 VS Code。
- 首期不让自定义命令直接执行任意终端命令。

## 2. 命令形态

输入格式：

```text
/command [args...]
```

示例：

```text
/init
/init --force
/help
/config open
/context refresh
```

解析规则：

- 第一段 token 是命令名，例如 `/init`。
- 后续内容作为 raw args 保留。
- 首期只需要支持简单 flags：`--force`、`--dry-run`、`--target <path>`。
- 命令名大小写不敏感，最终统一转成小写。
- 如果输入不是以 `/` 开头，则走普通 chat agent 流程。

## 3. 总体架构

```text
Webview Chat Input
        │
        ▼
WebviewToExtensionMessage: chat.send
        │
        ▼
KrakenViewProvider.sendChat()
        │
        ├── parseSlashCommand(text)
        │       │
        │       ├── no match  ─────► AgentRuntime.run()
        │       │
        │       └── match
        │
        ▼
SlashCommandRegistry
        │
        ▼
SlashCommand.execute(context)
        │
        ├── VS Code APIs
        ├── config/workspace helpers
        ├── change proposal APIs
        └── optional AgentRuntime.run()
```

Webview 只负责发送原始输入。命令识别和执行放在 Extension Host，原因是：

- Extension Host 已经拥有 VS Code API、SecretStorage、workspace root、change proposal 这些能力。
- Webview 不应该直接决定文件写入或配置写入。
- 后续命令可以复用 `KrakenViewProvider` 的会话状态和 `propose_changes` 流程。

## 4. 模块设计

建议新增目录：

```text
src/slash/
  types.ts
  parser.ts
  registry.ts
  builtins/
    help.ts
    init.ts
    clear.ts
    config.ts
    context.ts
```

### 4.1 types.ts

```ts
export interface SlashCommandInvocation {
  raw: string;
  name: string;
  argsText: string;
  flags: Record<string, string | boolean>;
  positionals: string[];
}

export interface SlashCommandContext {
  workspaceRoot: string;
  postAssistantMessage: (content: string) => void;
  postProgress: (message: string) => void;
  clearSession: () => Promise<void>;
  openConfig: () => Promise<void>;
  addChangeProposal: (summary: string, changes: FileChange[]) => Promise<string>;
}

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  usage: string;
  execute: (invocation: SlashCommandInvocation, context: SlashCommandContext) => Promise<void>;
}
```

### 4.2 parser.ts

Parser 只做轻量解析：

- `parseSlashCommand(text)` 返回 `SlashCommandInvocation | undefined`。
- 支持 quoted string，例如 `/init --target "kraken-coder/config"`。
- 不支持 pipe、redirect、subshell、环境变量展开。
- 对未知 flag 不在 parser 层报错，由具体 command 决定。

这样可以避免把 slash command 误设计成 shell。

### 4.3 registry.ts

Registry 负责：

- 注册内置命令。
- 按 name 和 alias 查找命令。
- 生成 `/help` 输出。
- 后续加载 workspace/custom/skill 命令。

首期只需要静态注册：

```ts
const commands = [
  helpCommand,
  initCommand,
  clearCommand,
  configCommand,
  contextCommand,
];
```

## 5. `/init` 设计

`/init` 用于让当前 workspace 变成 Kraken Coder 友好的项目。它不应该偷偷覆盖用户文件，默认生成 reviewable change proposal。

### 5.1 默认行为

用户输入：

```text
/init
```

执行步骤：

1. 检查当前 VS Code workspace root。
2. 检查是否存在 `<workspace>/kraken-coder/config/config.toml`。
3. 检查是否存在 `<workspace>/AGENT.md`。
4. 读取项目文件树、`package.json`、README、常见配置文件。
5. 生成一个 change proposal，而不是直接写文件。
6. 在 Chat 中说明生成了哪些文件，用户可以 Apply。

建议生成文件：

```text
kraken-coder/
  config/
    config.toml
.kraken-coder/
  skills/
    .gitkeep
AGENT.md
```

`config.toml` 示例：

```toml
[context]
maxChars = 60000

[agent]
autoApply = false
allowTerminal = false
allowFileWriteTool = false
allowBrowserTool = false
```

`AGENT.md` 用来记录项目级 agent 指令：

```md
# Project Instructions

## Project Overview

Describe the project purpose, runtime, and important entry points.

## Build And Test

- Fill in the commands used to check this workspace.

## Coding Guidelines

- Keep changes scoped.
- Prefer existing project conventions.
```

### 5.2 `--force`

```text
/init --force
```

`--force` 表示允许在 change proposal 中修改已有 `kraken-coder/config/config.toml` 和 `AGENT.md`，但仍然不直接写入文件。实际覆盖仍由用户点击 Apply 决定。

### 5.3 `--dry-run`

```text
/init --dry-run
```

只输出将要创建或修改的文件，不创建 change proposal。

### 5.4 是否调用模型

首期 `/init` 可以分两层：

- MVP：不调用模型，只生成固定模板。
- 增强版：调用 Agent Runtime，让模型根据项目文件树、README、package scripts 生成更贴合项目的 `AGENT.md`。

建议先做 MVP，保证命令系统闭环；之后再把项目摘要作为上下文交给 Agent 优化文档内容。

## 6. 命令执行结果

命令执行结果统一表现为 assistant message。

成功示例：

```text
Initialized Kraken Coder workspace files.

Created reviewable change proposal change_xxx:
- kraken-coder/config/config.toml
- AGENT.md
- .kraken-coder/skills/.gitkeep
```

失败示例：

```text
Unknown slash command: /foo

Run /help to see available commands.
```

执行期间可以复用已有 progress 事件：

```text
Running /init...
Inspecting workspace...
Creating change proposal...
```

## 7. 与现有系统的关系

### 7.1 Chat Flow

`KrakenViewProvider.sendChat()` 当前负责普通 chat。新增 slash command 后，流程变成：

1. trim 用户输入。
2. 如果是 slash command，执行 slash command 并 return。
3. 否则继续现有 `ensureModelConfigured()`、`AgentRuntime.run()` 流程。

Slash command 不应该强制要求 model 和 API key，除非该命令明确需要调用 Agent。

### 7.2 Config System

`/init` 生成 workspace 配置：

```text
<workspace>/kraken-coder/config/config.toml
```

这与当前配置优先级一致：workspace TOML 覆盖全局 TOML。

`/config open` 可以优先打开 workspace config；不存在时提供创建。

### 7.3 Tools System

Slash commands 本身不是 model tool。它们是用户显式触发的 Extension Host 命令。

如果某个 slash command 需要文件变更，优先使用 `addChangeProposal()` 生成可审查改动。只有用户确认后才应用。

### 7.4 Skills System

后续可以允许 skill 暴露 slash commands，但首期只预留接口。

候选设计：

```toml
[slash]
commands = ["review", "release-note"]
```

或者在 `SKILL.md` frontmatter 中声明：

```yaml
slash_commands:
  - name: review
    description: Review current changes
```

加载策略：

- workspace skill command 优先级高于 global skill command。
- skill command 不直接执行任意代码。
- skill command 默认转成 prompt template 交给 Agent Runtime。

## 8. Custom Commands

后续可支持 workspace 自定义命令：

```text
kraken-coder/commands/
  review.md
  release-note.md
```

文件格式：

```md
---
name: review
description: Review current git changes
argument-hint: [scope]
---

Review the current changes. Focus on bugs, regressions, missing tests, and risky behavior.

Scope: {{args}}
```

执行 `/review src/agent` 时，将 markdown 作为 prompt template，注入 args 后走普通 Agent Runtime。

首期可以不实现，但 registry 设计要避免和未来 custom command 冲突。

## 9. 权限与安全

- Slash command 由用户显式输入触发，但仍不等于授权任意写文件。
- `/init` 默认只创建 change proposal。
- `/clear` 只影响当前 chat session。
- `/config open` 只打开或创建 Kraken Coder 自己的配置文件。
- 自定义命令首期不允许声明 shell command。
- 如果未来支持 command hooks，必须走 tools 权限开关和 VS Code 确认。

## 10. MVP 实施计划

第一阶段：

1. 新增 `src/slash/types.ts`、`parser.ts`、`registry.ts`。
2. 实现 `/help`、`/clear`、`/init`。
3. 在 `KrakenViewProvider.sendChat()` 前置 slash command 分流。
4. `/init` 生成 reviewable change proposal。
5. Webview 不做特殊处理，只发送原始输入。

第二阶段：

1. 增加 `/config open`、`/context refresh`。
2. Chat 输入框支持输入 `/` 时展示命令补全。
3. 命令执行结果增加更清晰的 UI 标识。

第三阶段：

1. 支持 `kraken-coder/commands/*.md` 自定义命令。
2. 支持 skill 声明 prompt-template 型 slash command。
3. 支持命令参数 schema 和自动补全。

## 11. Open Questions

- `/init` 是否需要同时兼容 `AGENTS.md`？建议首期只使用 workspace 根目录的 `AGENT.md`。
- `commands/*.md` 是放在 `<workspace>/kraken-coder/commands`，还是也支持 `~/kraken-coder/commands`？
- 自定义命令是否允许覆盖内置命令？建议首期不允许。
- Slash command 是否需要出现在 Command Palette？建议首期不需要，避免两套入口状态不一致。
