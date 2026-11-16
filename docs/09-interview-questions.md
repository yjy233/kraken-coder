# 09 · Harness 工程师面试：本项目可能被问什么

面向 Coding Agent harness 工程师面试，基于本仓库实现与 [eval 实证](../eval/results/report.md)整理。本项目是教学复刻，有意简化了许多生产机制（见 [02 差异表](02-codex-reference.md)）；面试中**主动诚实交代边界**比被追问出来更加分。

题目是根据项目和公开资料推断的备考题，不是任何公司的真实题库。已有实验和测评由助手运行，不等于用户独立实现或验收；未实现的改进应作为设计方案介绍。

## 答题框架

每个问题按四段准备：

1. **项目怎么做**：指出具体实现位置与机制。
2. **为什么这样设计**：设计动机与取舍，而不是复述代码。
3. **边界/失败模式在哪**：教学简化、竞态、协议限制。
4. **生产级怎么补**：上游 Codex 或其他生产系统的做法。

有实验的问题再补充**如何验证改进有效**：固定对照条件，说明指标、失败类型与结论的适用范围。

## 1. Agent 主循环

- **模型、工具和 harness 分别负责什么？不换模型如何改善效果？**
  锚点：模型选择读取、假设和补丁；工具提供读写与执行能力；harness 组织上下文、执行调用和反馈，并管理权限、预算与恢复。可从工具反馈、上下文选择和验证环境入手做对照；不能把 `DemoProvider` 写死的成功轨迹当作模型能力。
- 模型返回文本 + 工具调用，为什么不能算回合结束？终止条件怎么定义？
  锚点：唯一正常结束是"有效响应且无工具调用"（[runLoop](../src/learning/exercises.ts)），对应上游 `session/turn.rs` 的 `needs_follow_up`。
- **模型说完成了，任务就完成了吗？**
  锚点：无工具调用意味着本轮正常结束，不证明需求已满足；区分模型结束、预算耗尽、用户取消与独立验收通过。可根据任务选择测试、工作区状态或人工检查作为证据，不能只凭最终自述。
- 为什么 assistant 意图必须先落盘再执行工具？顺序反了会怎样？
  锚点：崩溃窗口——副作用已发生但日志无记录；先 checkpoint 再 execute。
- 工具调用 ID 为什么不能跨 step 重复？配对断裂对下一次 API 请求意味着什么？
- `maxSteps` 为什么最后一次请求不允许启动工具？步数耗尽时为什么仍要保存意图？
  锚点：必须留出一次请求解释工具结果；意图落盘后恢复按 `outcome unknown` 处理，不丢弃响应。
- 取消信号怎么贯穿 provider → 工具 → shell 子进程？
  锚点：`AbortSignal.any` 组合回合超时；shell 用进程组 SIGKILL 取消子孙进程（[shell.ts](../src/tools/shell.ts)）。
- 追问陷阱：为什么串行执行工具？要并发需要声明什么？
  锚点：只读性、依赖与写冲突关系需显式声明，不能裸 `Promise.all`；还需处理并发上限、部分失败、取消及调用结果配对。同一 session 的锁不等于工作区锁；见 [01 架构](01-architecture.md)末节。

## 2. 工具审批与安全

- `prepare`/`run` 分离解决什么问题？为什么预览必须具体到补丁/命令本身？
  锚点：prepare 只读检查、零副作用；没有具体预览用户无法判断将发生什么（[registry.ts](../src/tools/registry.ts)）。
- effect 四分类（read/write/shell/state）怎么决定？为什么 `update_plan` 在 read-only 下允许？
  锚点：plan 是会话状态而非项目副作用；既读又写按 write 分类，能执行任意命令按 shell 分类。
- **审批和沙箱为什么不等价？** 应用层路径检查防得住什么、防不住什么？
  锚点：防君子不防敌对进程——TOCTOU 竞态、shell 开启后 cwd 不是权限边界；见 [04 工具与权限](04-tools-and-permissions.md)。
- 为什么不做 `rm`/`git` 命令黑名单就宣布安全？上游 OS 沙箱怎么做？
  锚点：黑名单可绕过（别名、脚本、间接执行）；上游用 macOS Seatbelt / Linux Landlock 做系统级隔离，要能讲大致机制。
- 模型输出的参数为什么宿主必须重新 schema 校验？`strict:false` 的取舍？
  锚点：模型输出不可信；校验器是有限 JSON Schema 子集，不是通用实现。
- 工具结果 / AGENTS.md 里的提示注入怎么防？
  锚点：本项目只有"指令不能授予工具权限"的提示词约定，无强隔离；生产需要内容来源标记与权限分离。

## 3. 补丁系统

- 为什么唯一精确匹配而不是模糊匹配？`aaa` 中匹配 `aa` 怎么处理？
  锚点：重叠匹配算多处匹配、判歧义；模糊匹配会把修改悄悄应用到错误函数（[replaceText](../src/learning/exercises.ts)）。
- 整行边界 framing（前后补 `\n`）防什么事故？
  锚点：防止 `a` 匹配进 `data` 中间；见 [patch.ts](../src/tools/patch.ts)。
- 为什么审批后要重读所有目标再写？
  锚点：审批期间用户可能改文件；全量预检失败则一个文件都不写。
- temp + rename 保证什么、不保证什么？多文件为什么不是事务？
  锚点：单文件原子可见性 ≠ 跨文件崩溃一致性；写入阶段磁盘错误可能留下部分已写文件。
- 与上游 apply-patch 的差异：Move、行号、`seek_sequence` 宽松定位——为什么砍掉？代价？
  锚点：教学版是严格子集（bare `@@` + 唯一完整行匹配）；上游宽松定位提高模型补丁成功率但引入误匹配风险。

## 4. 上下文管理（eval 实证瓶颈，最可能被穷追）

- 完整历史和模型窗口为什么必须分离？
  锚点：前者用于审计与恢复（JSONL 从不裁剪），后者受模型上下文限制。
- 为什么按 user 回合边界裁剪？工具配对为什么必须同删？
  锚点：从 assistant/tool 中间切开会产生孤立结果，API 直接拒绝（[fitContext](../src/learning/exercises.ts)）。
- 字符预算和真实 token 差在哪？为什么先扣工具 schema？
  锚点：JSON 字符数是可检查的近似，不估 token；schema 每次请求都发送，必须先扣除。
- 当前轮超限为什么报错而不是悄悄截断？
  锚点：不能把刚读取的关键代码截断到"勉强能发"；报错文案区分指令超限与当前轮超限。
- **eval 里 8/13 个 SWE 实例记录了 `Context budget exceeded`，你怎么改？**
  锚点：[报告](../eval/results/report.md)第 3、4 节——13 个有效结果中 9 个未解决，其中 8 个回合以该错误终止；不能推断这些实例本来都会成功。整轮裁剪无法缩减不断增长的当前回合，可设计回合内压缩、工具输出外存与按需读取，并保留任务约束、重要证据及工具配对。两个 400k 字符探针仍失败：一个补丁未过 FTP，一个请求超时；这说明在这两个探针中放大预算不足以解决问题，不能证明摘要已提升成功率。
- 摘要式压缩的质量怎么验证？超时兜底怎么做？为什么要持久化 checkpoint？
  锚点：固定模型、任务、环境和预算，比较无压缩与候选策略的任务成功率、信息丢失、费用和延迟，检查用户约束、失败证据和未完成工作是否可恢复；还需测试压缩失败与中断恢复。上游可参考 `core/src/compact.rs` 与 `history/src/compaction_checkpoint.rs`；本项目的语义压缩是待设计内容。
- **面对大仓库，如何让 Agent 找到相关代码？搜索无结果能证明代码不存在吗？**
  锚点：由问题关键词缩小目录，沿命中行扩展到实现、调用方和测试；检查目录范围、同义命名、返回截断和跳过文件。当前 [search](../src/tools/builtins.ts) 是有上限的字面匹配，未实现符号索引或语义检索；改进应评估定位质量、读取成本和最终任务效果。

## 5. 会话持久化与恢复

- 逐事件 `fsyncSync` 的代价？flush 和 fsync 的区别？
  锚点：上游 `flush()` 等待 writer 确认、最终调文件 flush，不等同 fsync；教学版逐事件 fsync 换取可检查的崩溃语义（[store.ts](../src/session/store.ts)）。
- 为什么恢复补 `outcome unknown` 而不是自动重放工具？为何不能仅靠 call ID 保证 exactly-once？
  锚点：日志与任意 shell/文件操作没有共同事务提交；缺失结果 ≠ 执行失败，模型须先检查实际工作区（[replay](../src/learning/exercises.ts)）。call ID 用于关联，并不自动使操作幂等；特定工具可结合幂等键、事务或状态核对设计更强保证。
- 锁为什么用 `mkdir`？为什么不做 PID 存活自动过期？
  锚点：mkdir 原子性；PID 复用会误判锁过期，宁可手动核对 owner.json。
- 末尾残缺行可截断、完整行损坏必须报错——为什么区别对待？
  锚点：尾行可能是崩溃时的半截写入；完整行损坏意味着数据已不可信，不能静默跳过。
- session 为什么绑定 workspace + provider/model？
  锚点：换模型/端点/工作区后历史协议上下文不再可信；eval 真实坑——复用 session ID 会让 L5 恢复"记得"上轮答案、污染测量（[eval-plan](../eval/eval-plan.md) 4.1）。

## 6. Provider 与流式协议

- Responses 的 reasoning items 为什么必须原序保存回传？只存可见文本会怎样？
  锚点：推理模型工具回合断裂；`store:false` + `reasoning.encrypted_content` 从本地日志无状态重建请求（[responses.ts](../src/providers/responses.ts)）。
- SSE frame 和 TCP chunk 的区别？UTF-8 跨 chunk 怎么处理？为什么只有 `response.completed` 才算成功？
  锚点：流式 TextDecoder 重建 + 空行分帧（[sse.ts](../src/providers/sse.ts)）；半个 function_call 绝不能进入执行器。
- fetch 为什么拒绝重定向？HTTP 错误为什么不回显远端 body？
  锚点：防凭据随重定向发给意外目标、防对方回显 Authorization；见 [http.ts](../src/providers/http.ts)。
- 无自动重试的取舍？429 瞬态 vs 持久怎么区分？
  锚点：eval 中断事件——余额耗尽是持久性 429，冷却重试无效，隔离存档不计分母（[eval-plan](../eval/eval-plan.md) 8.1）。

## 7. 评测方法论（eval/ 是简历亮点）

- 为什么黑盒、不改实现？gold 自检为什么必要？
  锚点：只通过公开 CLI 驱动，测量的是被测系统而非特调版本；先证明环境可信再花模型钱。
- FTP/P2P 双门判分、环境排除项怎么定口径？
  锚点：本次把 gold 补丁下仍失败的 P2P 作为环境差异候选排除，记录到 `env_excluded` 并在报告明示（flask-5063 的 16 个）；这是一项会影响分数可比性的判分选择，不保证失败全部由环境导致。判分独立于 agent 自述。
- 429 记录为什么隔离不计分母？子集分数为什么不能碰瓷官方榜单？
  锚点：额度失败 ≠ 模型答错；30/300 与 34/225 子集、无 Docker 官方镜像、单轨迹、单模型。
- 防泄漏做了哪些？
  锚点：不给 test_patch/gold patch/hints/FTP 测试名；polyglot 剔除 `.meta/example.py` 参考解。
- flask-4992 pilot 轮 resolved、正式轮失败说明什么？
  锚点：不同运行得到不同结果，可能涉及轨迹变化，但两轮协议也不同，不能仅归因于随机性；需要在相同协议下多次独立采样。
- 30.8% 这个数字怎么解读？
  锚点："agent 框架 × 单一模型"的组合结果，不能单独归因于任一方；历史测量未记录精确 agent 提交号。
- **只看已完成题目，分母和结果怎么报告？**
  锚点：SWE 计划 30，已有有效结果 13、resolved 4；Polyglot Python 计划 34，已有 33、首次通过 31、最多两次带反馈尝试通过 33。429 和未完成项单独披露；后者不等同两次独立采样的 `pass@2`，也不能与官方榜单直接比较。
- **独立脚本重跑测试就能保证判分可信？**
  锚点：[Polyglot 判分](../eval/harness/polyglot_eval.py)直接运行可由 Agent 修改的工作区测试；[SWE 判分](../eval/harness/swebench_eval.py)接受 `skipped`，且值得核对预期测试集合是否全部执行。可在干净环境应用候选源码补丁，用受保护的可信测试、完整测试清单和明确 skip 规则判分。以上是静态审查发现的风险，尚未证明历史分数受到污染或模型修改过测试。
- **429 后更换 session 重试，就一定是独立试验吗？**
  锚点：[agent_runner.py](../eval/harness/agent_runner.py) 更换 session，但沿用 `cwd`；若前次已写入文件，后次可能继承工作区状态。独立试验应恢复干净快照并保留各次日志与成本；如果有意接续，则明确标记接续并定义计分规则。这里是待验证风险，不断言已影响历史分数。
- **怎样证明 harness 的改动真正提高效果？**
  锚点：固定模型版本、任务集、环境、时间和 token 等预算，只改变待检验机制；重复运行并比较逐题结果、任务完成率、耗时、费用和失败类别，区分基础设施失败。保留未用于调参的任务，记录 revision 与配置；样本不足时报告不确定性。运行资源本身也会影响结果，见 [基础设施噪声研究](https://www.anthropic.com/research/infrastructure-noise)。
- **`model_requests` 一定等于实际 HTTP 请求数吗？**
  锚点：`runLoop` 在计算 `runtime.context(history)` 前发出 `model.start`，而 [agent_runner.py](../eval/harness/agent_runner.py) 根据该事件计数；上下文组装失败时事件已产生，但请求尚未发送。应分别记录上下文准备、请求发送与完成、usage、工具状态和进程退出码；工具 `ok: true` 不等于测试退出码为 0。

## 8. 开放设计题

- 把这个教学版推向生产，前三个改什么？
  建议结合部署场景排序，例如 OS 沙箱、回合内上下文管理、评测和可观测性；逐项解释威胁、成本和验证。上下文超限有本项目 eval 证据，其他优先级仍需结合实际场景，不能都称为已验证瓶颈。
- 怎么接入 MCP / 后台长任务 / 多 agent？现有 `ToolRegistry` 和事件流够不够？
  锚点：`ToolRegistry.register` 是扩展入口；事件与消息分离（[01 架构](01-architecture.md)）提供基础，但并未实现这些能力。长任务需设计进程标识、增量输出、轮询、取消与重启恢复；多 Agent 还需处理工作区隔离、任务交接、合并冲突和额外成本。
- 真实模型轨迹里观察到什么？
  锚点：Kimi 把 README 当 search 目录收到 ENOTDIR 后换 read_file（工具错误恢复）；补丁格式失败重试 ≠ 功能测试失败后重新定位（假设修正）——能区分这两者是深度信号，见 [08 学习进度](08-learning-progress.md)。

## 优先准备的五个深挖点

| 优先级 | 主题 | 为什么优先准备 | 素材位置 |
| --- | --- | --- | --- |
| 1 | 上下文预算瓶颈与 compaction 设计 | 有 eval 实证失败，无法回避 | [报告](../eval/results/report.md) 3/4 节、上游 compact.rs |
| 2 | 审批 ≠ 沙箱与 OS 隔离机制 | harness 岗核心区分度 | [04](04-tools-and-permissions.md)、上游 orchestrator.rs |
| 3 | 崩溃恢复与 exactly-once | 分布式系统基本功 | [05](05-sessions-and-context.md)、L5 replay |
| 4 | Responses reasoning 回传协议 | 推理模型工具回合的关键细节 | [06](06-providers.md)、responses.ts |
| 5 | eval 判分口径与效度威胁 | 简历亮点，必须能自洽 | [eval-plan](../eval/eval-plan.md) 第 6 节 |

## 现成故事素材

面试中讲具体事故比讲概念更有说服力，本项目有现成的：

- **eval session 污染坑**：复用 session ID 触发 L5 恢复，agent "记得"上轮答案——协议设计直接影响测量效度。
- **429 中断处置**：额度耗尽后持久性 429 重试无效；失败记录隔离存档，续跑使用新 run-tag 和独立会话。是否构成独立试验还取决于工作区是否恢复干净。
- **429 重试的进一步追问**：新 session 不会自动清空工作区；需要核实每次重试前的文件状态，才能声称试验独立。
- **pass@1 方差**：flask-4992 pilot resolved、正式轮 ftp_failed；400k 探针预算错误消失但补丁仍未过。
- **环境校准连环坑**：`git clean -x` 删掉 pytest 生成文件导致判分失真；sympy 裸测试名 grep 落到错误文件——gold 自检升级为 FTP+P2P 双门。
- **真实模型动作观察**：Kimi 的 ENOTDIR 换动作、补丁格式重试；以及"工具执行成功 ≠ 验证通过"（shell ok 但测试 exitCode 1）。

## 现场编码与设计练习

1. 为只读工具增加有并发上限的调度，处理顺序、结果配对、失败和取消；解释哪些操作不能并发。
2. 实现 SSE 解析：处理任意 chunk、UTF-8 跨块、帧边界和中断，确保不执行不完整的工具调用。
3. 为长工具输出设计外存、摘要和分页读取，处理内容丢失、访问权限及上下文预算。
4. 修正评测器：识别测试被修改、预期测试漏跑或全部 skip，并定义 429 重试的工作区隔离和计分。

练习目标是写出实现和验收方案；以上题目目前并不表示本项目已经具备这些能力。

## 公开参考

- [Claude Code Model Performance 工程师岗位](https://job-boards.greenhouse.io/anthropic/jobs/5098025008-112)：评测、研究基础设施与可靠性是该岗位的具体职责，不代表所有 Harness 岗位要求相同。
- [Demystifying evals for AI agents](https://www.anthropic.com/research/demystifying-evals-for-ai-agents)：Agent 评测的任务、轨迹、结果和判分。
- [Effective harnesses for long-running agents](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents)：跨会话接续、增量进度和环境状态。
