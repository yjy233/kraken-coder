# 02 · 对照本地 Codex 源码

本项目参考的是 openai/codex 的本地 checkout（位置因人而异，下文以 `$CODEX_REPO` 指代），固定提交：

```text
5c3ff1dabf644169f4bd74b215719f381e4fdb3f
2026-11-12
Validate the issue labeler's API key before sending requests (#60964)
```

它不是把旧版 TypeScript Codex CLI 复制下来。该快照的核心实现是 Rust，主循环已经拆分到 `core/src/session/turn.rs`；网上一些文章提到的 `core/src/codex.rs` 在这个快照中并不存在。

下面的路径均相对上游仓库根目录。线上链接固定到上述提交，不随 main 漂移；本地 checkout 才是此次实现实际阅读的依据。

| 主题 | 上游入口 | 教学版入口 | 保留的概念 |
| --- | --- | --- | --- |
| 回合主循环 | [`codex-rs/core/src/session/turn.rs`](https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/core/src/session/turn.rs) | `src/core/agent.ts`、`learning/runLoop` | turn 与 model step、工具后续请求、终止 |
| Responses 请求 | `codex-rs/codex-api/src/common.rs` | `src/providers/responses.ts` | input items、tools、stream、store、include |
| 工具协议 | `codex-rs/tools/src/tool_executor.rs` | `src/tools/registry.ts` | schema 与执行器绑定 |
| 审批编排 | `codex-rs/core/src/tools/orchestrator.rs` | `learning/decide`、`ToolRegistry.execute` | 执行前决定权限和审批 |
| 补丁解析 | `codex-rs/apply-patch/src/parser.rs` | `src/tools/patch.ts` | Begin/End、Add/Update/Delete、上下文匹配 |
| 会话轨迹 | `codex-rs/rollout/src/recorder.rs` | `src/session/store.ts` | JSONL 顺序记录、恢复 |
| 上下文压缩 | `codex-rs/core/src/compact.rs` | `learning/fitContext` | 工作上下文与完整历史分开 |
| 压缩 checkpoint | `codex-rs/history/src/compaction_checkpoint.rs` | 本版无对应远端 checkpoint | 通过阅读理解为何生产实现还需模型兼容性 |
| Skill 元数据 | `codex-rs/skills/src/parser.rs` | `src/context/instructions.ts` | 名称、描述、正文按需读取 |
| 指令上下文 | `codex-rs/core/src/context/` | `Instructions`、`systemPrompt` | 环境与项目指令组成请求上下文 |

## 推荐的上游阅读顺序

1. 在 `session/turn.rs` 搜索 `run_turn`，先看输入进入回合和取消信号怎么传递。
2. 搜索 `needs_follow_up`，理解工具调用为何意味着还需要请求模型。对照 Kraken 的 `runLoop`，看同一回合何时接收 steer，以及 follow-up 何时另起一轮。
3. 看 `tools/orchestrator.rs` 文件开头和 `ToolOrchestrator`，区分审批决策、沙箱选择、沙箱失败后的重试。
4. 看 `apply-patch/src/parser.rs` 的语法和 `Hunk` 枚举，再对照教学版的 `preparePatch` 与 `applyChanges`。
5. 看 `rollout/src/recorder.rs`，理解为什么消息和状态事件不是简单存一条最终答案。
6. 最后看 `compact.rs` 与 `history`；带着“裁剪会丢什么、哪些 item 必须保留”的问题阅读。

可以在本机运行：

```bash
cd "$CODEX_REPO"  # 你的 codex 本地 checkout
rg -n 'run_turn|needs_follow_up' codex-rs/core/src/session/turn.rs
rg -n 'ToolOrchestrator|run_attempt' codex-rs/core/src/tools/orchestrator.rs
rg -n 'enum Hunk|UpdateFileChunk' codex-rs/apply-patch/src/parser.rs
```

## 明确的实现差异

| 维度 | 上游中看到的工程机制 | 本项目的教学选择 |
| --- | --- | --- |
| 语言与入口 | Rust workspace，多个 UI/服务入口 | TypeScript 核心供 CLI 和 Agent Server 调用，Web 通过服务协议接入 |
| 模型传输 | HTTP/WebSocket、请求重试和流式中断处理 | Responses 和 Compatible 都支持 SSE，兼容端也可返回完整 JSON，请求出错会结束本次调用 |
| 执行隔离 | 平台原生沙箱、网络规则、审批编排 | 应用层文件路径检查，支持人工审批、自动审核及命令规则，本机 shell 以当前用户身份执行 |
| Patch | 更宽的语法、移动文件、多种上下文定位 | 严格子集，仅 bare `@@` 和唯一完整行匹配 |
| 历史 | 更多事件、状态索引、压缩与持久化策略 | 单个 session 一个 JSONL，独占目录锁、fsync |
| 上下文 | 本地或远端压缩，可持久化用于恢复的上下文 | 按预算删除完整旧轮次、缩短当前回合的部分工具结果，尚无可恢复的语义摘要 |
| 扩展 | 多种 Skill、插件、MCP、工具发现 | 工作区与插件技能、同步与异步命令 Hook、本地 stdio MCP 工具 |
| 任务控制 | 并发输入、子 Agent、可持续运行的命令 | 每会话一个活动回合，支持 steer、follow-up 和取消，工具串行，shell 一次执行到退出或超时 |

这些差异体现在行为与文档里，不能把“教学版通过了测试”理解成复现了 Codex 的全部工程保障。

## 2026-11-24 可做的功能

对照 Kraken `dd5ea1a` 和上游 `5c3ff1d`。以长任务能继续执行、用户能核对交付为目标，建议先处理一个可以稳定复现的故障，再按下表选功能。

**先修长命令输出。** Kraken 的 shell 把合并后的输出放进 `result.output`，压缩器只查找 `stdout`、`stderr` 和 `text`。在当前主线用约 12,000 字符输出复跑，两种算法和两种预算组合下，长输出 4 项都失败，短输出 4 项都通过。两项 JSONL 端到端检查也都停在构造下一次模型请求时。另有一个独立限制：即使预算充足，shell 也只收前 16,000 字符。实测让命令在 18,000 个数字后写错误标记并以 7 退出，工具报告了 7，但返回内容缺少尾行。第一步让压缩器处理实际字段，收集超长输出时保留首尾并标出省略量。验收既要看模型能否读到报错和退出码，也要看日志是否保留了工具实际返回的观察。[Kraken shell](../src/tools/shell.ts) · [上下文预算](../src/context/budget.ts) · [长任务验收](11-long-task-validation.md) · [Codex 输出缓冲](https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/core/src/unified_exec/output.rs#L26)

| 建议顺序 | Codex 已有的机制 | Kraken 第一版与验收 |
| --- | --- | --- |
| 1. 可续读的长命令 | 命令首次等待结束时仍在运行，可以凭进程会话 ID 继续取输出。[Codex 进程管理](https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/core/src/unified_exec/process_manager.rs#L734) | Kraken 整轮默认 3 小时，但单条 shell 默认 30 秒、最多 120 秒。沿用现有审批，先支持启动、读新增输出和停止。用一条分两段输出、运行超过两分钟、最终以 7 退出的命令，核对首段可提前读到、退出码准确、取消会回收进程。[shell 参数](../src/tools/builtins.ts) |
| 2. 临时模型错误自动重试 | 上游分别配置 HTTP 请求重试与 SSE 中断重试。[Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference) | Kraken 的 Compatible 适配器在本地端点首次返回 503 时只发了一次请求，手动重发立即成功。先对短暂 5xx 或连接失败有限次退避，只重发尚未产生可见输出的这次模型请求。用「执行一次工具 → 下一次请求 503 → 恢复」验收，工具副作用只发生一次，取消能打断等待，模型名错误的 404 直接报告。[HTTP 适配层](../src/providers/http.ts) |
| 3. 网页查看本轮代码改动 | 上游根据成功应用的补丁，聚合每个文件在本轮的净差异。[Codex TurnDiffTracker](https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/core/src/turn_diff_tracker.rs#L47) | Kraken 已有补丁前后内容，页面收到的是文件名。第一版给成功的 `apply_patch` 加一个可展开的 diff。同一文件改两次只显示最终差异，改回原样后差异消失，拒绝的补丁和任务开始前已有的用户改动都排除在外。[补丁数据](../src/tools/patch.ts) · [Web 时间线](../web/app.js) |
| 4. 同一会话的可恢复摘要 | 上游本地压缩路径生成摘要、替换模型历史，重开会话时可从有效检查点接上后续记录。[压缩](https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/core/src/compact.rs#L394) · [恢复](https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/core/src/session/rollout_reconstruction.rs#L521) | 现有裁剪仍装不下时，总结原始目标、用户最新 steer、已改文件、验证结果和待办，将摘要及其覆盖范围写入 JSONL。用低预算强制触发，然后重启服务、续接会话，检查下一次请求保留约束、能引用失败测试并继续未完步骤。跨会话检索另见[长期记忆设计](12-long-term-memory-design.md)。 |
| 5. 重启后保留 follow-up | 上游快照把待发消息按线程和顺序存进 SQLite，有冷启动后投递的集成测试。[队列表结构](https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/state/queue_migrations/0001_queued_items.sql) · [冷启动测试](https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/app-server/tests/suite/v2/thread_queue.rs#L457) | Kraken 现有队列可以跨页面刷新，服务重启则清空。沿用「继续队列」入口，按消息 ID 恢复待发项及投递状态。验收时排两条、撤一条、重启，剩余的一条只启动一次。steer 绑定原回合，回合已结束时保留给用户处理。[现有队列行为](10-agent-server.md#命令状态与事件) |

**显示实际 token 用量**也可独立交付。当前设置页展示窗口和压缩阈值，Compatible 适配器会跳过只含 usage 的流式消息。可以在运行详情中显示最近一次请求和会话累计用量，供应商未回传时显示「未提供」。用两次请求后刷新页面验证合计，特别留意缓存 token 已包含在输入 token 的供应商口径。[Kraken 兼容适配器](../src/providers/compatible.ts) · [Codex 用量协议](https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L2147)

**从某一轮分叉对话**适合比较两种修复思路。Kraken 当前可以新建空会话或续聊。第一版可在已结束的回合提供「从这里分叉」，新会话继承截至该轮的历史，使用当前工作目录。验收时从三轮对话的第二轮末尾分叉，子会话能引用前两轮，第三轮内容只在父会话可见。[Kraken 会话路由](../src/server/server.ts) · [Codex 回合边界测试](https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/app-server/tests/suite/v2/thread_fork.rs#L622)

## 与 my-hermes 的共同点和不同点

共同点是 TypeScript、低依赖、独立 learner/reference、中文说明、阶段验收、离线 Demo、真实 Provider 和调试入口。

`my-hermes` 更强调通用助手的记忆、Gateway、连接器、技能演化与持续目标。本项目把学习预算集中在 Coding Agent 的代码读写、补丁、审批、执行结果和会话轨迹上，因此没有复制 Hermes 的 Curator、SQLite 长期记忆或 IM Gateway。

## 许可与来源

Codex 上游使用 Apache-2.0。本项目依据模块职责与协议做独立 TypeScript 实现，没有复制或翻译其 Rust 源文件，也未导入其图片、提示词资产或运行时。项目自身使用根目录 MIT 许可证；本文件保留参考提交与路径，便于追溯。后续若直接引入上游代码，应同时保留对应许可证及必要声明。
