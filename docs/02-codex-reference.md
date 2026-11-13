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
2. 搜索 `needs_follow_up`，理解工具调用为何意味着还需要请求模型。上游还会考虑等待中的新用户输入；教学版一次只有一个用户回合。
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
| 语言与入口 | Rust workspace，多个 UI/服务入口 | TypeScript，一套 CLI + 可导出的核心 |
| 模型传输 | 更完整的 HTTP/WebSocket、配置与重试体系 | Responses SSE + Compatible 非流式 HTTP；不自动重试 |
| 执行隔离 | 平台原生沙箱、网络规则、审批编排 | 应用层文件路径检查、逐次审批；本机 shell 无沙箱 |
| Patch | 更宽的语法、移动文件、多种上下文定位 | 严格子集，仅 bare `@@` 和唯一完整行匹配 |
| 历史 | 更多事件、状态索引、压缩与持久化策略 | 单个 session 一个 JSONL，独占目录锁、fsync |
| 上下文 | 本地/远端 compaction 和不透明 checkpoint | 删除完整旧轮次；不生成摘要，不伪装成无损压缩 |
| 扩展 | 多种 Skill、插件、MCP、工具发现 | 工作区 Skill 文本索引和公开 ToolRegistry |
| 任务控制 | 更复杂的并发输入、子 Agent、后台执行 | 串行工具、单次 shell、一个活动回合 |

这些差异体现在行为与文档里，不能把“教学版通过了测试”理解成复现了 Codex 的全部工程保障。

## 与 my-hermes 的共同点和不同点

共同点是 TypeScript、低依赖、独立 learner/reference、中文说明、阶段验收、离线 Demo、真实 Provider 和调试入口。

`my-hermes` 更强调通用助手的记忆、Gateway、连接器、技能演化与持续目标。本项目把学习预算集中在 Coding Agent 的代码读写、补丁、审批、执行结果和会话轨迹上，因此没有复制 Hermes 的 Curator、SQLite 长期记忆或 IM Gateway。

## 许可与来源

Codex 上游使用 Apache-2.0。本项目依据模块职责与协议做独立 TypeScript 实现，没有复制或翻译其 Rust 源文件，也未导入其图片、提示词资产或运行时。项目自身使用根目录 MIT 许可证；本文件保留参考提交与路径，便于追溯。后续若直接引入上游代码，应同时保留对应许可证及必要声明。
