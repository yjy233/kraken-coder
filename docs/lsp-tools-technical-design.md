# LSP Tools Technical Design

## 1. 背景与目标

Kraken Coder 当前主要通过 `read_file`、`grep`、`glob`、diagnostics context 和 workspace tree 理解代码。对于“跳定义、找引用、看类型、看符号、获取 hover 文档”这类语义信息，继续让模型做文本搜索会低效且容易漏。

LSP tools 的目标是把 Language Server Protocol 能力包装成 Agent 可调用工具，让模型在需要语义信息时调用稳定工具，而不是猜测代码关系。

重要约束：LSP 能力不能绑定 VS Code。Kraken Coder 后续可能支持 CLI，因此设计应以共享 LSP core 为主，VS Code 和 CLI 只是不同 Host Adapter。

首期只支持三种语言：

- TypeScript
- Go
- Python

首期目标：

- 提供 VS Code 和 CLI 都能复用的 LSP tool schema。
- 通过 Host Adapter 屏蔽 VS Code Provider 与独立 LSP 进程差异。
- 给 Agent 暴露少量高价值语义工具。
- 对 TypeScript、Go、Python 做明确支持和降级。
- 返回结构化、短输出，适合放进模型上下文。
- 不做文件写入，LSP tools 首期全部是 read-only。

非目标：

- 不支持所有语言。
- 不做跨 workspace 远程 index 服务。
- 不执行 rename、code action、formatting 等写操作。
- 不把 LSP 结果直接用于自动改代码；改动仍走现有 change proposal。

## 2. 核心设计原则

### 2.1 Core 不依赖 VS Code

LSP tools 应该分成两层：

- `lsp core`：语言白名单、工具 schema、路径/位置转换、结果格式化、超时、缓存、错误降级。
- `host adapter`：负责实际调用语言能力。

Host Adapter 至少两种：

- VS Code Adapter：消费 VS Code 已注册的 language provider。
- CLI Adapter：启动和管理 language server 进程，通过 JSON-RPC/LSP 通信。

这样可以做到：

- VS Code 插件首期可以快速复用编辑器里的语言服务。
- CLI 后续不依赖 VS Code，可以直接跑 `typescript-language-server`、`gopls`、`pyright-langserver`。
- Agent 看到的 tool 名称、输入、输出保持一致。

### 2.2 工具只返回定位和摘要

LSP tools 返回：

- 文件路径
- 行列范围
- 符号名和类型
- hover markdown 的短摘要
- 引用/定义列表

如果 Agent 需要具体代码内容，再调用 `read_file` 读取对应行范围。这样可以控制上下文，避免一次 LSP 查询塞入太多源码。

### 2.3 语言白名单

首期只允许以下语言 / 文件扩展：

| Language | Extensions | CLI language server |
| --- | --- | --- |
| TypeScript | `.ts`, `.tsx`, `.mts`, `.cts` | `typescript-language-server --stdio` |
| Go | `.go` | `gopls serve` 或 `gopls` stdio 模式 |
| Python | `.py`, `.pyi` | `pyright-langserver --stdio` |

VS Code Adapter 还需要映射 VS Code language id：

| Language | VS Code language id |
| --- | --- |
| TypeScript | `typescript`, `typescriptreact` |
| Go | `go` |
| Python | `python` |

遇到其他语言时，工具直接返回 unsupported，不尝试调用 provider 或 language server。

## 3. 总体架构

```text
Agent Runtime
    │
    ▼
Tool Registry
    │
    ▼
lsp_* tools
    │
    ▼
LspService Core
    │
    ├── language detection
    ├── path and position normalization
    ├── result formatting
    ├── timeout and truncation
    └── Host Adapter interface
            │
            ├── VSCodeLspAdapter
            │     └── vscode.execute*Provider
            │
            └── ProcessLspAdapter
                  ├── typescript-language-server
                  ├── gopls
                  └── pyright-langserver
```

建议目录：

```text
src/lsp/
  adapters/
    types.ts
    process.ts
  languages.ts
  positions.ts
  protocol.ts
  service.ts
  tools.ts

src/vscode/lsp/
  adapter.ts

src/vscode/agentTools.ts
  createVSCodeToolRegistry()
    └── append createLspTools(new VSCodeLspAdapter(...))

src/cli/
  agentTools.ts
    └── append createLspTools(new ProcessLspAdapter(...))
```

`src/lsp` 不能 import `vscode`。VS Code 专属代码只能放在 `src/vscode/lsp`。

## 4. Adapter Interface

Core 只依赖一个接口：

```ts
export interface LspHostAdapter {
  kind: 'vscode' | 'process';
  initializeWorkspace(workspaceRoot: string, language: LspLanguage): Promise<void>;
  hover(request: LspTextDocumentPositionRequest): Promise<LspHoverResult>;
  definition(request: LspDefinitionRequest): Promise<LspLocation[]>;
  references(request: LspReferencesRequest): Promise<LspReference[]>;
  documentSymbols(request: LspDocumentSymbolsRequest): Promise<LspDocumentSymbol[]>;
  workspaceSymbols(request: LspWorkspaceSymbolsRequest): Promise<LspWorkspaceSymbol[]>;
  dispose?(): Promise<void>;
}
```

共享类型：

```ts
export type LspLanguage = 'typescript' | 'go' | 'python';

export interface LspPosition {
  line: number;      // Agent-facing 1-based
  character: number; // Agent-facing 1-based
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspTextDocumentPositionRequest {
  workspaceRoot: string;
  path: string;
  language: LspLanguage;
  position: LspPosition;
}
```

Core 负责把 Agent 输入标准化成这些类型；Adapter 只负责执行。

## 5. VS Code Adapter

VS Code Adapter 调用已注册 Provider：

- `vscode.executeHoverProvider`
- `vscode.executeDefinitionProvider`
- `vscode.executeDeclarationProvider`
- `vscode.executeTypeDefinitionProvider`
- `vscode.executeImplementationProvider`
- `vscode.executeReferenceProvider`
- `vscode.executeDocumentSymbolProvider`
- `vscode.executeWorkspaceSymbolProvider`

优点：

- VS Code 已经负责 language server 生命周期、workspace 配置、extension activation。
- TypeScript、Go、Python 的 provider 由对应扩展提供。
- 插件侧实现轻，适合第一阶段落地。

限制：

- 只能在 VS Code Extension Host 中使用。
- 结果质量依赖用户安装/启用的 VS Code 扩展。
- CLI 不能复用这一层。

VS Code Adapter 执行流程：

1. 校验文件属于 workspace。
2. `vscode.workspace.openTextDocument(uri)` 打开文档。
3. 必要时 `vscode.window.showTextDocument(document, { preserveFocus: true, preview: true })` 激活 provider。
4. 将 1-based position 转成 VS Code 0-based `Position`。
5. 调用 `vscode.execute*Provider`。
6. 标准化 `Location` / `LocationLink` / `DocumentSymbol` / `SymbolInformation`。

## 6. CLI Process Adapter

CLI Adapter 直接管理 language server 进程。首期建议用成熟 LSP 包，不手写 JSON-RPC framing。

可选依赖：

- `vscode-jsonrpc`
- `vscode-languageserver-protocol`
- `vscode-languageclient` 的 node client 能力如果可在当前运行环境复用，也可以评估；但 CLI 不应依赖 VS Code API。

### 6.1 TypeScript

推荐 server：

```bash
typescript-language-server --stdio
```

依赖：

- `typescript`
- `typescript-language-server`

项目配置：

- 依赖 `tsconfig.json` / `jsconfig.json`。
- monorepo 下以 workspace root 初始化，一个 root 一个 server session。

### 6.2 Go

推荐 server：

```bash
gopls
```

依赖：

- `gopls`
- Go toolchain

项目配置：

- `go.mod`
- `go.work`
- GOPATH 项目作为降级支持

### 6.3 Python

推荐 server：

```bash
pyright-langserver --stdio
```

依赖：

- `pyright`

项目配置：

- `pyrightconfig.json`
- `python.analysis.extraPaths`
- 当前虚拟环境路径可通过 Kraken config 传入

### 6.4 CLI 初始化流程

Process Adapter 每个 workspace/language 维护一个 server session：

1. 根据语言解析 server command。
2. spawn language server。
3. 发送 `initialize`：
   - `rootUri`
   - `workspaceFolders`
   - textDocument capabilities
   - workspace symbol capabilities
4. 发送 `initialized`。
5. 查询前确保目标文件已同步：
   - 打开文件时发送 `textDocument/didOpen`。
   - 文件内容变化后发送 `textDocument/didChange`，或者首期只按磁盘快照 didOpen。
6. 调用 `textDocument/hover`、`textDocument/definition`、`textDocument/references` 等 request。
7. 按 idle timeout 关闭 server，或 session 结束时 dispose。

首期为了简单：

- 不做实时增量同步。
- 每次查询前从磁盘读取文件内容，若未 didOpen 则 didOpen。
- 如果文件已经 didOpen 且 mtime 变化，则 didChange 全量同步。

## 7. 工具集合

首期建议暴露 5 个工具，不做过细拆分。

### 7.1 `lsp_hover`

用途：查看光标位置的类型、签名、文档。

Input:

```ts
interface LspHoverInput {
  path: string;
  line: number;      // 1-based
  character: number; // 1-based
}
```

Output:

```ts
interface LspHoverOutput {
  language: 'typescript' | 'go' | 'python';
  path: string;
  position: { line: number; character: number };
  contents: string[];
}
```

输出控制：

- 最多返回 5 段 hover content。
- 单段最多 1200 字符。
- MarkdownString 转纯文本或保留轻量 markdown 均可，但不要返回 command URI。

### 7.2 `lsp_definition`

用途：跳到定义、声明、类型定义或实现。

Input:

```ts
interface LspDefinitionInput {
  path: string;
  line: number;
  character: number;
  kind?: 'definition' | 'declaration' | 'type_definition' | 'implementation';
  max_results?: number;
}
```

Output:

```ts
interface LspLocationResult {
  language: 'typescript' | 'go' | 'python';
  query: {
    path: string;
    line: number;
    character: number;
    kind: string;
  };
  locations: Array<{
    path: string;
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    preview?: string;
  }>;
}
```

说明：

- `line` / `character` 对 Agent 使用 1-based，Adapter 内部按需要转 0-based。
- `preview` 只返回目标起始行附近 1-3 行，完整内容由 Agent 再用 `read_file` 读取。
- 默认 `kind = "definition"`。

### 7.3 `lsp_references`

用途：找某个符号的引用。

Input:

```ts
interface LspReferencesInput {
  path: string;
  line: number;
  character: number;
  include_declaration?: boolean;
  max_results?: number;
}
```

Output:

```ts
interface LspReferencesOutput {
  language: 'typescript' | 'go' | 'python';
  symbol?: string;
  references: Array<{
    path: string;
    line: number;
    character: number;
    preview?: string;
  }>;
  truncated: boolean;
}
```

默认：

- `include_declaration = false`
- `max_results = 50`
- 硬上限 200

### 7.4 `lsp_document_symbols`

用途：读取当前文件的符号树，比全文读文件更适合快速了解模块结构。

Input:

```ts
interface LspDocumentSymbolsInput {
  path: string;
  max_depth?: number;
}
```

Output:

```ts
interface LspDocumentSymbolsOutput {
  language: 'typescript' | 'go' | 'python';
  path: string;
  symbols: Array<{
    name: string;
    kind: string;
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    selectionRange: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    children?: unknown[];
  }>;
}
```

### 7.5 `lsp_workspace_symbols`

用途：按名称查找 workspace 内的类型、函数、变量、类。

Input:

```ts
interface LspWorkspaceSymbolsInput {
  query: string;
  language?: 'typescript' | 'go' | 'python';
  max_results?: number;
}
```

Output:

```ts
interface LspWorkspaceSymbolsOutput {
  query: string;
  symbols: Array<{
    name: string;
    kind: string;
    containerName?: string;
    path: string;
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    language?: string;
  }>;
  truncated: boolean;
}
```

说明：

- 如果指定 `language`，结果按白名单扩展名过滤。
- 默认最多 50 条，硬上限 200。

## 8. 为什么不首期做这些工具

以下能力先不做成 LSP tools：

- Rename：有写入风险，且跨文件编辑需要复杂 review。
- Code Action：不同语言返回差异大，很多 action 需要用户确认或会修改文件。
- Formatting：和项目 formatter 冲突风险高。
- Semantic Tokens：对 Agent 价值有限，输出量大。
- Call Hierarchy / Type Hierarchy：各 language server 支持差异较大，后续再加。

后续可以增加：

- `lsp_code_actions`：只读列出可用 action，不执行。
- `lsp_prepare_rename`：只检查符号是否可 rename。
- `lsp_call_hierarchy`：用于复杂调用链分析。

## 9. 语言支持细节

### 9.1 TypeScript

VS Code Adapter：

- 使用 VS Code 内置 TypeScript language features。

CLI Adapter：

- 使用 `typescript-language-server --stdio`。
- 需要项目安装或全局可用 `typescript`。

支持文件：

- `.ts`
- `.tsx`
- `.mts`
- `.cts`

注意：

- TypeScript 依赖 `tsconfig.json` / `jsconfig.json`。
- 如果文件不在 config include 范围内，结果可能退化。
- Monorepo 里需要按 workspace root 或 package root 做 session 策略，首期可以先以 Kraken workspace root 初始化。

建议错误提示：

```text
TypeScript language server did not return results. Check tsconfig include/exclude and whether typescript-language-server/typescript are installed.
```

### 9.2 Go

VS Code Adapter：

- 使用官方 VS Code Go 扩展提供的 Provider。

CLI Adapter：

- 使用 `gopls`。

支持文件：

- `.go`

注意：

- `gopls` 依赖 `go.mod`、`go.work` 或 GOPATH 项目结构。
- 首次打开 workspace 时索引可能需要几秒。
- Generated file、大型 monorepo 可能返回慢。

建议错误提示：

```text
Go language server did not return results. Ensure gopls can load this module.
```

### 9.3 Python

VS Code Adapter：

- 使用 Python 扩展 / Pylance / Pyright / Jedi 注册的 Provider。

CLI Adapter：

- 使用 `pyright-langserver --stdio`。

支持文件：

- `.py`
- `.pyi`

注意：

- 类型和跳转质量依赖 interpreter、venv、`python.analysis.extraPaths`。
- CLI Adapter 需要从 config 或环境变量获得 Python path / venv 信息，再传给 pyright 配置。
- 动态代码、monkey patch、未安装依赖可能导致定义/引用不完整。

建议错误提示：

```text
Python language server did not return results. Check pyright configuration and the selected Python environment.
```

## 10. Core 调用流程

单个工具执行流程：

1. 校验 `path` 在 workspace/sandbox 允许范围内。
2. 根据扩展名判断语言是否属于白名单。
3. 校验 `line` / `character` 是否在文件范围内。
4. 从 adapter pool 获取对应 workspace/language 的 Adapter session。
5. 调用 `adapter.initializeWorkspace(workspaceRoot, language)`。
6. 对 CLI Adapter，确保目标文档已 `didOpen` 或已同步最新磁盘内容。
7. 调用对应 adapter 方法。
8. 标准化位置、路径和 symbol kind。
9. 生成必要 preview。
10. 按 `max_results` 截断。
11. 返回 JSON 字符串或结构化 `ToolResult.output`。

需要注意：

- LSP 原生位置是 0-based，Agent 输入输出统一 1-based。
- LSP 可能返回 `Location`、`LocationLink`、`DocumentSymbol`、`SymbolInformation` 等多种结构，需要统一。
- 所有返回路径优先用 workspace-relative path。
- workspace 外路径默认只展示绝对路径和 range，不自动读取。

## 11. Agent 使用策略

PromptBuilder 应在发现 LSP tools 可用时追加工具指南。

建议系统提示：

```text
## LSP Tool Guidelines
- Use LSP tools for semantic questions such as definitions, references, hover types, implementations, and document symbols.
- Prefer `lsp_definition` or `lsp_references` over broad text search when the user asks about a specific symbol.
- Use `lsp_document_symbols` before reading a large file when you only need its structure.
- After LSP returns locations, use `read_file` for the exact line ranges you need before proposing edits.
- LSP results can be incomplete when the language server is not configured; fall back to `grep` and `read_file` when a provider returns no result.
```

推荐使用顺序：

- 理解一个文件结构：`lsp_document_symbols` -> 必要时 `read_file`
- 找函数/类定义：`lsp_workspace_symbols` 或 `lsp_definition` -> `read_file`
- 分析影响面：`lsp_references` -> 对关键引用 `read_file`
- 理解类型/签名：`lsp_hover` -> 必要时 `lsp_definition`
- LSP 无结果：`grep` / `glob` / `read_file`

## 12. Tool Registry 集成

LSP tools 应放进共享 registry 能使用的层，而不是只挂在 VS Code registry。

建议：

```text
createToolRegistry(...)
  └── generic tools

createLspTools(adapter, config)
  └── lsp_hover
  └── lsp_definition
  └── lsp_references
  └── lsp_document_symbols
  └── lsp_workspace_symbols

VS Code:
  createVSCodeToolRegistry()
    ├── createToolRegistry(...)
    ├── createLspTools(new VSCodeLspAdapter(...), config)
    └── createProposeChangesTool(...)

CLI:
  createCliToolRegistry()
    ├── createToolRegistry(...)
    └── createLspTools(new ProcessLspAdapter(...), config)
```

配置建议：

```toml
[lsp]
enabled = true
adapter = "auto"
languages = ["typescript", "go", "python"]
maxResults = 50
hoverMaxChars = 4000
timeoutMs = 8000

[lsp.typescript]
command = "typescript-language-server"
args = ["--stdio"]

[lsp.go]
command = "gopls"
args = []

[lsp.python]
command = "pyright-langserver"
args = ["--stdio"]
pythonPath = ""
extraPaths = []
```

默认：

- VS Code 环境下 `adapter = "vscode"`。
- CLI 环境下 `adapter = "process"`。
- `adapter = "auto"` 根据运行环境选择。
- `enabled = true`。
- `languages = ["typescript", "go", "python"]`。
- `maxResults = 50`。
- `hoverMaxChars = 4000`。
- `timeoutMs = 8000`。

## 13. 错误与降级

工具不应该因为 language server 无结果而抛致命错误，除非输入非法。

应抛错的情况：

- `path` 为空。
- 文件不在 workspace 或 sandbox 允许范围内。
- `line` / `character` 越界。
- 文件语言不在白名单。
- CLI Adapter 启动 server 失败且用户明确启用了该语言。

应返回空结果的情况：

- Provider 未注册。
- Language server 返回空。
- Language server 尚未索引完成。
- 符号本身无法解析。

空结果格式示例：

```json
{
  "language": "typescript",
  "locations": [],
  "message": "No definition returned by the language server. Try grep/read_file fallback."
}
```

CLI server 不存在时的结果示例：

```json
{
  "language": "python",
  "locations": [],
  "message": "pyright-langserver is not available. Install pyright or disable Python LSP tools."
}
```

## 14. 安全与权限

首期 LSP tools 是 read-only：

- 不执行 rename。
- 不执行 code action。
- 不写文件。
- 不运行用户 shell 命令；CLI Adapter 只启动配置允许的 language server command。

路径策略应复用现有 workspace/sandbox 校验：

- 输入 `path` 必须解析到 workspace 内。
- 返回 workspace 外位置时只展示路径和 range，不自动读取。
- 不返回 command links。
- hover markdown 中如果包含 `command:` URI，应移除或转义。

CLI Adapter 的额外限制：

- language server command 来自内置默认或 config，不能由模型传入。
- command 和 args 不应该通过 tool input 暴露。
- server 进程 stdout/stderr 要做大小限制。
- idle timeout 后关闭 server，避免泄露长期进程。

## 15. 测试策略

单元测试：

- 1-based / 0-based position 转换。
- LSP `Location` 和 `LocationLink` 标准化。
- 文件扩展名到语言映射。
- max result 截断。
- hover markdown 清洗。
- adapter mock 返回空结果时的降级格式。

集成测试：

- TypeScript fixture：接口、类、函数、引用、类型定义。
- Go fixture：module 内函数、方法、接口实现、跨包引用。
- Python fixture：函数、类、类型注解、`.pyi` stub。

VS Code 手工验证：

- 无语言扩展时返回清晰空结果或错误。
- Go 未安装 `gopls` 时有明确提示。
- Python interpreter 未选择时不阻塞 Agent。

CLI 手工验证：

- 未安装 `typescript-language-server` 时给出明确提示。
- 未安装 `gopls` 时给出明确提示。
- 未安装 `pyright-langserver` 时给出明确提示。
- 大量引用时结果截断并标记 `truncated = true`。

## 16. 分阶段实现计划

### Phase 1: Shared Core + VS Code Adapter

- `src/lsp` 共享类型、语言检测、位置转换、结果格式化。
- `src/vscode/lsp/adapter.ts` 实现 VS Code Adapter。
- `lsp_hover`
- `lsp_definition`
- `lsp_references`
- `lsp_document_symbols`
- `lsp_workspace_symbols`
- PromptBuilder 追加 LSP 工具指南。

### Phase 2: CLI Process Adapter

- `ProcessLspAdapter`。
- language server process pool。
- `initialize` / `initialized`。
- `didOpen` / 全量 `didChange`。
- TypeScript / Go / Python 三种 server 默认 command。
- idle timeout 和 dispose。

### Phase 3: 更强语义导航

- `lsp_call_hierarchy`
- `lsp_type_hierarchy`
- references 按文件聚合和排序
- symbol preview 更精细

### Phase 4: 安全编辑辅助

- `lsp_code_actions` 只列出 action，不执行。
- `lsp_prepare_rename` 只判断是否可 rename。
- 如果未来支持执行 rename，必须生成 reviewable change proposal，不能直接写文件。

## 17. Agent 示例

用户：

```text
这个函数在哪里被调用了？
```

Agent 流程：

1. 如果用户光标/上下文能定位到符号，调用 `lsp_references`。
2. 对返回的关键引用调用 `read_file`。
3. 总结调用点和影响面。

用户：

```text
解释这个 TypeScript 类型为什么报错
```

Agent 流程：

1. 调用 `lsp_hover` 看当前位置类型。
2. 调用 `lsp_definition` 找类型定义。
3. 调用 `read_file` 读取定义附近代码。
4. 结合 diagnostics 给出解释。

用户：

```text
这个 Python 类有哪些方法？
```

Agent 流程：

1. 调用 `lsp_document_symbols`。
2. 如果符号树不足，再调用 `read_file` 读取类范围。
3. 总结方法、属性和继承关系。
