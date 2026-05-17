# Kraken Coder VS Code 插件技术方案

## 1. 背景与目标

Kraken Coder VS Code 插件面向日常编码场景，目标是在编辑器内提供一个可控、可审计、可逐步增强的编程 Agent。插件不只做聊天入口，而是要能理解当前工作区、读取代码上下文、提出补丁、运行验证命令，并把结果以适合开发者工作流的方式呈现出来。

首期目标：

- 在 VS Code 侧提供侧边栏聊天与任务入口。
- 读取当前文件、选区、打开的编辑器、诊断信息和工作区文件树作为上下文。
- 支持解释代码、生成代码、修改代码、生成测试、修复报错等基础编码任务。
- 以 diff/patch 方式提交改动，默认需要用户确认后写入文件。
- 支持配置 OpenAI 兼容模型服务、API Key、默认模型和上下文策略。
- 保留向多步 Agent、工具调用、终端验证、远端执行服务演进的架构空间。

非目标：

- 首期不直接替代 VS Code 原生 Git、Debug、Testing UI。
- 首期不做完全自动化的大规模重构，所有高风险写操作需要明确确认。
- 首期不依赖某个专有后端，核心协议保持 OpenAI 兼容接口优先。

## 2. 产品形态

### 2.1 入口

- Activity Bar：新增 `Kraken Coder` 图标，打开插件主侧边栏。
- Explorer/Editor 右键菜单：
  - `Kraken: Explain Selection`
  - `Kraken: Fix Selection`
  - `Kraken: Generate Tests`
  - `Kraken: Add To Chat Context`
- Command Palette：
  - `Kraken: Open Chat`
  - `Kraken: New Coding Task`
  - `Kraken: Configure Model`
  - `Kraken: Clear Session`
- Code Action：对诊断报错提供 `Ask Kraken to Fix` 快捷入口。

### 2.2 主界面

侧边栏 Webview 提供三块能力：

- Chat：面向自然语言任务，支持引用文件、选区、诊断和终端输出。
- Changes：展示 Agent 生成的文件变更、diff、应用/拒绝按钮。
- Context：展示当前已加入上下文的文件、片段、问题列表和 Token 预算。

### 2.3 典型工作流

1. 用户选中一段代码，执行 `Kraken: Fix Selection`。
2. 插件收集选区、所在文件、相关诊断、邻近代码和项目元信息。
3. Webview 显示任务消息，Extension Host 调用 Agent Runtime。
4. Agent Runtime 请求模型并产生结构化结果：说明、文件补丁、验证建议。
5. 插件使用 VS Code diff editor 展示改动。
6. 用户确认后，插件通过 WorkspaceEdit 写入文件。
7. 可选：用户允许插件运行测试或 lint 命令，结果回填到对话。

## 3. 总体架构

```text
┌─────────────────────────────────────────────────────────────┐
│                         VS Code                             │
│                                                             │
│  ┌───────────────┐     postMessage      ┌────────────────┐  │
│  │ Webview UI    │ ◄──────────────────► │ Extension Host │  │
│  │ Chat/Changes  │                      │ Commands       │  │
│  │ Context Panel │                      │ Workspace APIs │  │
│  └───────────────┘                      └───────┬────────┘  │
│                                                  │           │
│                                                  ▼           │
│                                      ┌────────────────────┐  │
│                                      │ Agent Runtime       │  │
│                                      │ Prompt Builder      │  │
│                                      │ Tool Dispatcher     │  │
│                                      │ Patch Planner       │  │
│                                      └─────────┬──────────┘  │
└────────────────────────────────────────────────┼─────────────┘
                                                 │
                      ┌──────────────────────────┴──────────────────────────┐
                      ▼                                                     ▼
           ┌─────────────────────┐                              ┌─────────────────────┐
           │ Model Provider       │                              │ Optional Backend     │
           │ OpenAI-compatible    │                              │ Index/Memory/Remote  │
           └─────────────────────┘                              └─────────────────────┘
```

核心原则：

- Extension Host 负责 VS Code API 交互、权限边界和文件写入。
- Webview 只做展示和轻量交互，不直接访问本地文件系统。
- Agent Runtime 以纯 TypeScript 模块实现，便于未来迁移到 Node 后端或复用到 CLI。
- 所有工具调用都经过 Extension Host 授权和审计。

## 4. 模块设计

### 4.1 Extension Host

职责：

- 注册命令、菜单、Code Action、TreeView/WebviewView。
- 管理插件配置、会话状态。
- 通过 VS Code Workspace API 读取文件、应用编辑、打开 diff。
- 调度 Agent Runtime，并把进度事件推送给 Webview。
- 控制终端命令执行、文件写入等高风险操作的用户确认。

建议目录：

```text
src/
  extension.ts
  commands/
    chat.ts
    explainSelection.ts
    fixSelection.ts
    generateTests.ts
  providers/
    krakenViewProvider.ts
    codeActionProvider.ts
    contextProvider.ts
  vscode/
    workspace.ts
    diagnostics.ts
    edits.ts
    terminal.ts
    secrets.ts
```

### 4.2 Webview UI

职责：

- 展示聊天消息、工具调用状态、生成中的内容、错误信息。
- 展示上下文列表和 token 预算。
- 展示待应用改动，提供 apply/reject/open diff。
- 通过 `vscode.postMessage` 与 Extension Host 通信。

建议技术栈：

- Vite + React + TypeScript。
- 状态管理优先使用轻量本地 store，例如 Zustand；首期也可以用 React state。
- UI 组件保持编辑器风格，遵循 VS Code 主题变量，例如 `--vscode-editor-background`。

消息协议示例：

```ts
type WebviewToExtensionMessage =
  | { type: 'chat.send'; text: string; contextIds: string[] }
  | { type: 'change.apply'; changeSetId: string }
  | { type: 'change.reject'; changeSetId: string }
  | { type: 'context.remove'; contextId: string }
  | { type: 'config.open' };

type ExtensionToWebviewMessage =
  | { type: 'session.updated'; session: ChatSession }
  | { type: 'agent.progress'; event: AgentProgressEvent }
  | { type: 'change.created'; changeSet: ChangeSet }
  | { type: 'error'; message: string; recoverable: boolean };
```

### 4.3 Agent Runtime

职责：

- 构造系统提示词、任务提示词和上下文包。
- 调用模型服务，处理流式输出。
- 将模型输出解析成结构化动作，例如说明、补丁、命令建议。
- 根据策略决定是否需要更多上下文。
- 维护当前会话的短期记忆。

建议目录：

```text
src/agent/
  runtime.ts
  promptBuilder.ts
  modelClient.ts
  streamParser.ts
  toolDispatcher.ts
  patchParser.ts
  contextBudget.ts
  sessionStore.ts
```

首期可以采用“单轮规划 + 结构化输出”的方式，不急于实现完整 ReAct 循环。推荐先约束模型输出为 JSON 包裹的变更计划：

```ts
interface AgentResult {
  summary: string;
  changes: FileChange[];
  commands?: CommandSuggestion[];
  followUps?: string[];
}

interface FileChange {
  path: string;
  type: 'create' | 'modify' | 'delete';
  patch?: string;
  fullText?: string;
  rationale?: string;
}
```

### 4.4 Context Engine

职责：

- 收集当前任务相关上下文。
- 控制上下文 token 预算。
- 对文件树、打开文件、选区、诊断、Git diff 做摘要。
- 为未来语义检索和代码索引预留接口。

首期上下文来源：

- 当前 active editor 文件。
- 用户选区及前后窗口代码。
- 当前 workspace 文件树，忽略 `node_modules`、`.git`、构建产物。
- VS Code diagnostics。
- 用户显式添加的文件或片段。
- Git changed files，可选。

后续增强：

- ripgrep 关键词检索。
- Tree-sitter 符号抽取。
- 本地 embedding 索引。
- 远端索引服务。

### 4.5 Patch 与文件写入

文件修改必须可审查：

- Agent 产出 unified diff 或完整文件内容。
- 插件解析并生成内存中的 `ChangeSet`。
- 使用 VS Code diff editor 展示原始内容和候选内容。
- 用户确认后通过 `WorkspaceEdit` 写入。
- 写入前检查文件版本，避免覆盖用户刚刚手动编辑的内容。

建议 ChangeSet 结构：

```ts
interface ChangeSet {
  id: string;
  title: string;
  description: string;
  files: Array<{
    path: string;
    beforeText: string | null;
    afterText: string | null;
    status: 'created' | 'modified' | 'deleted';
  }>;
  createdAt: number;
}
```

### 4.6 终端命令与验证

插件可以建议运行测试、lint、类型检查，但默认不自动执行。

执行策略：

- 白名单命令可一键运行，例如 `npm test`、`pnpm test`、`npm run lint`。
- 其他命令展示完整命令文本，需要用户确认。
- 命令在 VS Code Terminal 中运行，输出可由用户选择是否添加回上下文。
- 不自动运行删除、上传、部署、权限变更类命令。

## 5. 配置设计

`package.json` contribution 配置建议：

```json
{
  "configuration": {
    "title": "Kraken Coder",
    "properties": {
      "kraken.model.baseUrl": {
        "type": "string",
        "default": "https://api.openai.com/v1"
      },
      "kraken.model.provider": {
        "type": "string",
        "default": "openai-compatible"
      },
      "kraken.model.name": {
        "type": "string",
        "default": ""
      },
      "kraken.context.maxChars": {
        "type": "number",
        "default": 60000
      },
      "kraken.agent.autoApply": {
        "type": "boolean",
        "default": false
      }
    }
  }
}
```

敏感信息：

- API Key 写入全局 `~/kraken-coder/config/config.toml` 的 `[model].apiKey`。
- 不把 Key 写入 workspace 配置、日志或 Webview state。
- 诊断日志默认脱敏。

## 6. 安全与权限边界

安全原则：

- Webview 不直接读写文件，不直接调用网络密钥。
- 文件写入默认必须用户确认。
- 终端命令默认必须用户确认。
- 对模型发送上下文前，让用户能看到已选上下文范围。
- 支持 workspace trust，未信任工作区下禁用自动读全量文件树和终端执行。
- 对 `.env`、证书、私钥、密钥文件设置默认忽略规则。

默认忽略：

```text
.git/
node_modules/
dist/
build/
coverage/
.env
.env.*
*.pem
*.key
*.p12
```

## 7. API 与协议

### 7.1 Model Provider

首期建议实现 OpenAI 兼容模型抽象，具体请求格式由 Provider 适配层决定：

```ts
interface ModelClient {
  streamChat(request: ModelRequest): AsyncIterable<ModelEvent>;
}

interface ModelRequest {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
  }>;
  tools?: ToolDefinition[];
  temperature?: number;
}
```

为后续兼容不同模型服务，`ModelClient` 不直接绑定 UI，也不直接依赖 VS Code API。

### 7.2 Tool 协议

Agent 可申请工具调用，但 Extension Host 决定是否执行：

```ts
type ToolName =
  | 'workspace.readFile'
  | 'workspace.searchText'
  | 'workspace.listFiles'
  | 'workspace.proposePatch'
  | 'terminal.suggestCommand';

interface ToolCall {
  id: string;
  name: ToolName;
  input: unknown;
}
```

首期建议只允许只读工具自动执行；写文件和终端类工具转为“提案”，由用户确认。

## 8. 工程脚手架

建议技术栈：

- TypeScript。
- VS Code Extension API。
- Vite + React 用于 Webview。
- esbuild 或 tsup 打包 Extension Host。
- Vitest 做纯逻辑单测。
- `@vscode/test-electron` 做集成测试。
- ESLint + Prettier 做基础质量控制。

建议目录：

```text
kraken-coder/
  package.json
  tsconfig.json
  vite.config.ts
  src/
    extension.ts
    agent/
    commands/
    providers/
    vscode/
    shared/
  webview/
    index.html
    src/
      main.tsx
      App.tsx
      components/
      store/
  test/
    unit/
    integration/
  docs/
    vscode-extension-technical-design.md
```

## 9. 测试策略

单元测试：

- Prompt Builder：上下文拼装、token 截断、敏感文件过滤。
- Patch Parser：新增、修改、删除文件场景。
- ChangeSet：版本冲突、路径规范化、换行处理。
- Model Client：流式事件解析和错误重试。

集成测试：

- 命令注册成功。
- Webview 能加载并与 Extension Host 通信。
- 选区上下文能正确传入 Agent Runtime。
- 生成 ChangeSet 后可以打开 diff。
- 用户确认后 WorkspaceEdit 正确写入。

手工验证：

- 小型 TS/JS 项目解释代码。
- 根据报错修复一个 TypeScript 类型错误。
- 生成并应用一个测试文件。
- 在未信任工作区验证高风险能力被禁用。

## 10. 里程碑

### M0：插件骨架

- 初始化 VS Code Extension 项目。
- 注册 Activity Bar 和 WebviewView。
- 实现配置项。
- 实现基础 Webview 消息通信。

### M1：聊天与上下文

- 支持侧边栏聊天。
- 支持选区、当前文件、诊断加入上下文。
- 支持 OpenAI 兼容模型流式输出。
- 实现基础会话状态。

### M2：代码修改闭环

- Agent 输出结构化 ChangeSet。
- 支持 diff 预览。
- 支持用户确认后应用文件改动。
- 增加 Patch Parser 单测。

### M3：任务入口与 Code Action

- 增加解释、修复、生成测试等命令。
- 对 diagnostics 提供 Code Action。
- 增加上下文面板。
- 支持错误恢复和重试。

### M4：验证命令

- 支持建议测试/lint 命令。
- 用户确认后在 VS Code Terminal 执行。
- 支持把终端输出摘要加入对话。

### M5：Agent 增强

- 引入只读工具调用。
- 支持关键词检索与文件相关性排序。
- 支持长任务进度、取消和恢复。
- 预留远端索引/记忆服务接入点。

## 11. 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 模型输出补丁不可解析 | 文件修改失败 | 首期优先支持完整文件替换和受控 JSON，再逐步支持 unified diff |
| 上下文过大 | 成本高、响应慢 | 引入 token budget、文件过滤、片段优先级 |
| 误写用户文件 | 数据丢失 | diff 确认、文件版本检查、WorkspaceEdit 原子写入 |
| 终端命令风险 | 安全事故 | 默认禁用自动执行，高风险命令强确认 |
| Webview 与 Extension 状态不一致 | UI 混乱 | 单一会话 store，所有状态由 Extension Host 下发 |
| 多模型兼容差异 | 功能不稳定 | ModelClient 抽象，Provider 适配层隔离差异 |

## 12. 官方参考

- VS Code Extension API: https://code.visualstudio.com/api
- Webview API: https://code.visualstudio.com/api/extension-guides/webview
- Contribution Points: https://code.visualstudio.com/api/references/contribution-points
- Testing Extensions: https://code.visualstudio.com/api/working-with-extensions/testing-extension
