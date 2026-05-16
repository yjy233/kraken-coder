# Interactive Agent Runtime Technical Design

## 1. 背景与目标

当前 Kraken Coder 在 Agent 推理期间会禁用输入框。这种交互方式不符合主流 coding agent 的使用习惯：用户应该可以继续输入、排队追加任务、观察真实终端输出，并能用中断按钮真正停止当前模型请求和工具执行。

目标是把 Chat 从“单轮阻塞表单”升级为“交互式 Agent 会话”：

- Agent 运行时输入框不禁用。
- 支持 `Stop` / `Interrupt` 按钮，并且是真实中断。
- 中断时保留已经流出的 assistant 半截输出，并写入会话上下文。
- 用户在 Agent 运行期间可以多次输入。
- 多次输入需要被播到运行流里：要么进入 pending queue，要么作为 interrupt message 注入下一轮。
- 支持真实终端，终端输出能流式展示，必要时可被中断。
- 不丢消息、不乱序、不把中断状态伪装成正常完成。

非目标：

- 不在第一版实现多人协作。
- 不允许模型无限制控制用户当前 VS Code terminal。
- 不绕过现有 change proposal 安全边界。
- 不把所有 shell 输出永久塞进上下文；需要摘要和截断策略。

## 2. 期望产品行为

### 2.1 输入框

Agent 运行中：

- 输入框保持可编辑。
- 发送按钮仍可用，文案可以变成 `Queue` 或 `Send`。
- 旁边出现 `Stop` 按钮。
- 用户提交的新消息立即显示在 Chat 中，状态为 `queued` 或 `pending`。

Agent 空闲时：

- 输入框正常发送新任务。
- `Stop` 按钮隐藏或 disabled。

### 2.2 Stop / Interrupt

点击 Stop 后：

1. 立即禁用 Stop，避免重复点击。
2. 调用当前 run 的 `AbortController.abort()`。
3. 模型 streaming request 应停止。
4. 正在运行的工具应收到 abort signal。
5. 如果工具是 terminal/shell process，应发送真实终止信号。
6. 当前 assistant streaming message 保留为一条消息，状态标记为 `interrupted`。
7. 会话 busy 状态变成 false，或继续消费 pending queue。

用户可见结果：

```text
assistant · interrupted
这里是已经流出来的一半内容...
```

这条半截 assistant 消息后续要作为历史上下文传给模型。它不是 error，也不是被丢弃的临时 UI。

### 2.3 运行中多次输入

用户在 Agent 运行时输入：

```text
先别改 A，优先看 B
```

推荐第一版策略：默认排队。

- 新消息立即显示为 `queued`。
- 当前 run 不被自动打断。
- 当前 run 完成或中断后，队列按顺序继续执行。

后续可以支持“发送并中断”：

- 普通 Enter：排队。
- `Stop and send` 或 `Interrupt with message`：中断当前 run，并把新消息作为下一轮第一条 pending input。

## 3. 核心概念

### 3.1 Run

一次 Agent 执行称为 run。

```ts
interface AgentRun {
  id: string;
  sessionId: string;
  status: 'queued' | 'running' | 'completed' | 'interrupted' | 'failed';
  userMessageIds: string[];
  assistantMessageId?: string;
  abortController: AbortController;
  startedAt?: number;
  finishedAt?: number;
}
```

### 3.2 Message Status

现有 `ChatMessageStatus` 建议扩展：

```ts
type ChatMessageStatus =
  | 'queued'
  | 'running'
  | 'complete'
  | 'interrupted'
  | 'error';
```

语义：

- `queued`：用户消息已进入队列，但还没开始处理。
- `running`：assistant 或 tool 正在流式输出。
- `complete`：正常完成。
- `interrupted`：被用户或系统中断，内容保留。
- `error`：失败，内容保留但语义为异常。

### 3.3 Pending Input Queue

每个 Chat session 维护一个 pending queue：

```ts
interface PendingInput {
  id: string;
  messageId: string;
  text: string;
  createdAt: number;
  mode: 'queue' | 'interrupt';
}
```

第一版只需要 `mode = "queue"`。如果后续加入“带消息中断”，则使用 `mode = "interrupt"`。

### 3.4 Run Controller

`KrakenViewProvider` 不应该只用一个 `session.busy` 判断所有状态。建议引入 run controller：

```ts
class AgentRunController {
  currentRun?: AgentRun;
  queue: PendingInput[];

  enqueue(input: PendingInput): void;
  stopCurrentRun(reason: 'user' | 'system'): Promise<void>;
  drainQueue(): Promise<void>;
}
```

`session.busy` 可以继续作为 UI 派生状态，但实际调度以 `currentRun` 和 `queue` 为准。

## 4. 消息协议设计

### 4.1 Webview -> Extension

```ts
type WebviewToExtensionMessage =
  | { type: 'chat.send'; text: string; mode?: 'queue' | 'interrupt' }
  | { type: 'agent.stop'; runId?: string }
  | { type: 'terminal.input'; terminalId: string; data: string }
  | { type: 'terminal.resize'; terminalId: string; cols: number; rows: number };
```

说明：

- `chat.send` 在 running 状态下也允许发送。
- `mode = "queue"`：排队。
- `mode = "interrupt"`：先中断当前 run，再排到队列头或作为下一轮立即执行。
- `agent.stop` 真实中断当前 run。
- terminal 消息给未来真实 PTY 使用。

### 4.2 Extension -> Webview

```ts
type ExtensionToWebviewMessage =
  | { type: 'session.updated'; session: ChatSession; runs?: AgentRunSummary[] }
  | { type: 'agent.runStarted'; runId: string }
  | { type: 'agent.runStopped'; runId: string; reason: 'user' | 'system' }
  | { type: 'agent.progress'; message: string }
  | { type: 'terminal.output'; terminalId: string; data: string }
  | { type: 'terminal.closed'; terminalId: string; exitCode?: number; signal?: string }
  | { type: 'error'; message: string; recoverable: boolean };
```

现有 `session.updated` 可以继续作为主状态同步，但 terminal output 需要独立事件，否则大输出会导致整段 session 频繁重绘。

## 5. Agent 中断模型

### 5.1 AbortController 贯穿全链路

当前 run 创建时生成：

```ts
const abortController = new AbortController();
```

这个 `signal` 必须传给：

- `AgentRuntime.run()`
- model client fetch request
- ReAct loop
- tool execute context
- shell/terminal tool
- browser/LSP 等可能耗时工具

如果任何一层忽略 signal，就不是真实中断。

### 5.2 Runtime 中断语义

`AgentRuntime.run()` 应区分：

- 正常完成：返回 `AgentResult`
- 用户中断：抛 `AgentInterruptedError` 或返回 `RunInterruptedResult`
- 运行失败：抛普通 Error

推荐使用专用错误：

```ts
class AgentInterruptedError extends Error {
  readonly reason: 'user' | 'system';
}
```

Provider 捕获后：

- 不显示红色 error。
- 当前 streaming assistant message 标为 `interrupted`。
- tool running message 标为 `interrupted` 或 `error`，取决于工具是否正常响应中断。
- 继续 drain queue。

### 5.3 半截 assistant 输出保留

流式 delta 当前已经追加到 assistant message。中断时不能删除。

中断处理：

```ts
finishStreamingAssistantMessage({ status: 'interrupted' });
```

后续构造 history 时应包含：

```text
assistant: <partial content>
```

可附加 metadata：

```ts
metadata: {
  interrupted: true,
  runId,
  interruptedAt,
}
```

PromptBuilder 不需要特殊处理；模型看到半截 assistant 历史，会理解之前被打断。如果要更明确，可以在下一轮 user message 前注入系统风格上下文：

```text
Previous assistant response was interrupted by the user and may be incomplete.
```

## 6. 队列与调度

### 6.1 默认排队策略

`sendChat(text)` 逻辑改为：

1. 创建 user message。
2. 如果当前无 run，立即开始 run。
3. 如果当前有 run：
   - user message 状态设为 `queued`。
   - 添加到 pending queue。
   - postSession。
4. 当前 run 完成/中断/失败后调用 `drainQueue()`。

### 6.2 drainQueue

```ts
async function drainQueue(): Promise<void> {
  if (currentRun || queue.length === 0) return;
  const next = queue.shift();
  markMessageRunning(next.messageId);
  await runAgentForQueuedInput(next);
}
```

关键点：

- 保持 FIFO 顺序。
- 每次只运行一个 Agent run。
- run 完成后递归/循环 drain。
- session 持久化要包含 queue 或至少包含 queued message。

### 6.3 Slash Commands

slash command 也进入同一套调度：

- 快速本地命令如 `/clear` 可以要求当前无 run，或提示需要先 stop。
- 会调用 Agent 的命令如 `/skill` 应进入 queue。
- `/clear` 如果当前有 run，建议弹确认：清空会话会中断当前 run。

## 7. 真实终端设计

### 7.1 为什么需要真实终端

现有 `shell_command` 更像“一次性命令执行工具”。主流 coding agent 通常需要真实终端能力：

- 流式输出。
- 长任务可停止。
- 交互式进程可输入。
- 输出可以被折叠、截断、摘要后进入上下文。

### 7.2 终端实现选择

VS Code 插件内有两种路线：

1. `node-pty`：
   - 最接近真实终端。
   - 支持 stdin/stdout、resize、signal。
   - 需要 native dependency，打包复杂。

2. `child_process.spawn`：
   - 无 native dependency。
   - 非完整 PTY，某些交互式命令表现差。
   - 第一版可以作为低风险实现。

建议：

- 第一版实现 `spawn` streaming terminal tool。
- 设计接口保持 PTY 抽象，后续可替换为 `node-pty`。

### 7.3 Terminal Session

```ts
interface TerminalSession {
  id: string;
  runId: string;
  cwd: string;
  command: string;
  args: string[];
  status: 'running' | 'exited' | 'killed';
  outputBuffer: RingBuffer<string>;
  process: ChildProcess;
}
```

终端输出：

- 通过 `terminal.output` 增量推给 Webview。
- tool message 只保留摘要和末尾输出。
- 完整输出可写入 session artifact 文件，但不要默认塞进模型上下文。

### 7.4 中断终端

Stop 当前 run 时：

1. 对当前 run 关联的 terminal session 调 `kill()`
2. 首选 `SIGINT`
3. 超时未退出再 `SIGTERM`
4. 再超时才 `SIGKILL`

```ts
async function stopTerminal(session: TerminalSession): Promise<void> {
  session.process.kill('SIGINT');
  await wait(1500);
  if (stillRunning(session)) session.process.kill('SIGTERM');
  await wait(1500);
  if (stillRunning(session)) session.process.kill('SIGKILL');
}
```

Windows 下 signal 行为不同，需要封装平台差异。

## 8. 上下文保留策略

### 8.1 半截 assistant

必须保留：

- 已流式输出的 assistant 文本。
- status = `interrupted`
- metadata 标记 interrupted。

进入下一轮 history。

### 8.2 queued user messages

queued message 也必须保留在 session.messages。进入模型 history 的时机：

- 尚未执行的 queued message 不进入当前 run history。
- 当它被 drain 成当前 run 时，状态从 `queued` 改成 `running` 或 `complete`，再进入 history。

### 8.3 terminal output

终端输出分三层：

- UI stream：完整实时输出。
- tool message：截断后的尾部输出 + exit code。
- context：摘要或最后 N 行。

建议默认：

- 每个 terminal tool result 最多注入 12k chars。
- 超出时保留开头 2k + 末尾 10k。
- 长输出可生成 artifact 文件路径。

## 9. UI 设计

### 9.1 Composer

运行中：

```text
[ textarea: type next instruction...        ]
[ Send / Queue ] [ Stop ]
```

不要 disabled textarea。

### 9.2 Message 状态

用户消息：

- `queued`：显示 queued 标记。
- `running`：当前正在处理。
- `complete`：已经被处理。

assistant 消息：

- `running`：流式光标。
- `interrupted`：保留内容，显示 interrupted 标记。
- `complete`：正常完成。
- `error`：错误。

tool/terminal 消息：

- `running`：可展开输出。
- `interrupted`：显示已停止。
- `complete`：显示 exit code。
- `error`：显示错误和尾部输出。

### 9.3 Stop Button

Stop 按钮只在有 current run 时显示。

点击后文案变成：

```text
Stopping...
```

直到 Extension 回 `agent.runStopped`。

## 10. 持久化

session store 需要保存：

- message status
- partial assistant content
- queued user messages
- run metadata
- terminal artifact references

不建议持久化：

- live ChildProcess
- AbortController
- in-memory pending promises

VS Code reload 后：

- 所有 `running` message 标成 `interrupted` 或 `error`。
- queued message 保留 queued，可由用户手动继续，或自动 drain，需配置决定。

## 11. 错误处理

### 11.1 用户中断

不是 error。

状态：

- run: `interrupted`
- assistant: `interrupted`
- tool: `interrupted`

### 11.2 模型请求失败

是 error。

保留 partial assistant，如果有。

### 11.3 工具中断失败

如果工具没有在超时内停止：

- run 标为 `failed`
- tool 标为 `error`
- 提示哪个 process 没有停掉

这类问题需要浮窗或 error message，因为可能泄露后台进程。

## 12. 实施计划

### Phase 1: 输入不禁用 + Stop 真中断

- Webview composer 不再根据 busy 禁用 textarea。
- 新增 `agent.stop` message。
- Provider 维护 current run AbortController。
- `AgentRuntime.run()` 接收并传递 signal。
- model client fetch 使用 signal。
- 中断时保留 streaming assistant message，状态为 `interrupted`。

### Phase 2: Pending Queue

- session 增加 queued user message 状态。
- running 中发送消息进入 queue。
- run 结束后 drain queue。
- queued message 状态正确更新。
- slash commands 纳入同一调度。

### Phase 3: Tool Abort

- ToolDefinition execute 支持 signal。
- shell/browser/lsp/web fetch 等耗时工具接入 abort。
- tool running message 支持 `interrupted`。

### Phase 4: Terminal Streaming

- 新增 terminal session manager。
- `terminal.output` 独立流式事件。
- shell command tool 改为可流式、可停止。
- 支持 stdin/resize 的协议，后续接 PTY。

### Phase 5: Context 与恢复

- session store 保存 interrupted/queued 状态。
- reload 后恢复一致状态。
- terminal 长输出 artifact 化。
- 下一轮 prompt 明确说明上一轮 assistant 被 interrupted。

## 13. 验证场景

必须覆盖：

- Agent 正在输出时，用户能继续打字。
- 当前 run 中途 Stop，模型请求真正 abort。
- Stop 后半截 assistant 文本仍在 Chat，下一轮能作为 history。
- Agent 运行时连续发送 3 条消息，按顺序执行。
- queued 消息在 UI 中不会消失。
- shell/terminal 长命令运行时 Stop，进程被终止。
- VS Code reload 后不会显示永远 running 的消息。
- slash `/skill ...` 在 busy 时进入队列，而不是被丢弃。

## 14. 关键取舍

第一版推荐默认“排队，不自动打断”，原因：

- 行为最可预期。
- 不会因为用户补一句话就破坏正在执行的工具。
- 实现复杂度低。

但必须提供 Stop 按钮，因为用户需要主动控制运行。后续再加 “Interrupt with message” 会更接近 Claude Code / Cursor 等主流体验。
