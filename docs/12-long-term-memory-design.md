# Kraken Coder 长期记忆设计

**设计稿 · 2026-11-23**

Kraken 已经用 JSONL 恢复同一个 session。长期记忆要让 Agent 在新会话中也能找到过去的工作、当时的验证结果和原始出处。以本机 `~/code/codex` 的提交 `5c3ff1dabf644169f4bd74b215719f381e4fdb3f` 为准，采用它的新用户 V2 路径。Kraken 的长期记忆功能和对应验收尚待实现。[当前会话存储](../src/session/store.ts) · [长任务实测](11-long-task-validation.md)

例如，新窗口里问「上次那个 shell 输出过长的问题修好了么？」理想回答能区分「48 步那次在候选副本通过了 8 项行为检查和 2 项日志检查」与「补丁已合入当前分支」。前一句应能定位到当时的会话摘要，后一句要检查当前工作树。这个差别也应进入验收。

## Codex 实际存在哪里

这个快照有 V1 和 V2。总开关 `features.memories` 默认关闭。启用后，若没有旧 `memories/` 目录、未显式选版本且未显式关闭双写，配置解析会为新用户选择 V2。旧版教程常见的 `raw_memories.md`、`MEMORY.md` 属于 V1 路径。V2 提取时只要求会话摘要和短文件名，整合产物只有一份必需的总览。[功能开关][feature] · [新用户版本选择][version] · [提取协议][output] · [两版的产物检查][validate]

| 数据 | Codex V2 的位置和职责 | Kraken 拟采用 |
| --- | --- | --- |
| 原始会话 | 每个线程的 rollout JSONL 提供原始证据，线程索引保存其路径 | 沿用现有 `<sessionHome>/sessions/<id>.jsonl`。续聊、审批和工具意图回放继续走它 |
| 线程目录 | `state_5.sqlite` 的 `threads` 记录来源、工作目录、更新时间、rollout 路径、是否允许提取等 | `<memoryHome>/state_1.sqlite` 的 `threads` 保存记忆所需的索引字段。文件名中的 1 是 Kraken 自己的首版 |
| 摘要和后台任务 | 独立的 `memories_v2_1.sqlite`，按需打开。V1 的库名是 `memories_1.sqlite`。两个版本共用线程目录 | `<memoryHome>/memories_v2_1.sqlite`，复用 V2 的表结构、租约和输入版本语义 |
| 模型可查的历史材料 | `$CODEX_HOME/memories_v2/rollout_summaries/*.md` 每个来源一份摘要，`memory_summary.md` 是跨会话索引 | `<memoryHome>/memories_v2/` 下使用相同布局。按文件名取证或做文本搜索 |

Codex 可单独指定 SQLite 的目录，Markdown 放在用户级 Codex home。Kraken 目前的运行目录默认是工作区里的 `.kraken-coder`。设计里保留原日志位置，另设用户级 `memoryHome`，默认 `~/.kraken-coder`，以 `KRAKEN_MEMORY_HOME` 覆盖。CLI、Web 和 SDK 使用同一用户目录时共享记忆，多个项目的摘要会出现在同一索引中，文件内保留各自的工作目录和来源。测试使用临时目录。[上游数据库命名][db] · [V2 按需打开][db-version] · [产物目录][dir] · [Kraken 现有目录解析](../src/cli.ts)

## SQLite 具体存什么

| 表 | 关键字段 | 用途 |
| --- | --- | --- |
| `threads`（线程库） | `id`、`rollout_path`、`cwd`、`source`、`updated_at_ms`、`archived`、`memory_mode` | 找出近期、空闲、允许提取的交互会话。`memory_mode` 区分 enabled、disabled、polluted。后者用于启用了外部上下文排除策略的线程 |
| `stage1_outputs`（记忆库） | `thread_id` 主键、`source_updated_at`、`rollout_summary`、`rollout_slug`、`raw_memory`、`generated_at`、`usage_count`、`last_usage`、`selected_for_phase2`、`selected_for_phase2_source_updated_at` | 一个来源一行，保留最新提取结果，以及上次成功整合所用的来源版本。V2 向兼容列 `raw_memory TEXT NOT NULL` 写空字符串 |
| `jobs`（记忆库） | 联合主键 `(kind, job_key)`、`status`、`worker_id`、`ownership_token`、`lease_until`、`retry_at`、`retry_remaining`、`last_error`、开始/完成时间、`input_watermark`、`last_success_watermark` | 每线程一条 `memory_stage1`，全局一条 `(memory_consolidate_global, global)`。记录谁可以提交、何时能重试、哪个版本已处理 |
| `consolidation_progress`（记忆库） | 单行 `singleton = 1`、`max_thread_count` | 上游记录成功整合覆盖线程数的历史最大值，供版本就绪度判断。可随同迁移保留。调度依据在 `jobs` 中 |

建表直接对照上游记忆库的两份 migration。旧 `state/migrations/0006` 中的记忆表已由 `0035` 移出。Kraken 拟用 Node 24 自带的 `node:sqlite`。本机已在内存库执行上游两份记忆 migration，实际建出了表中的后三张表。本地磁盘上的短事务采用 WAL、busy timeout 和 `BEGIN IMMEDIATE` 领取任务，调用模型时先结束事务。线程和记忆分库，两端以稳定的线程 ID 关联。Kraken 允许两个工作区都使用 `--session demo`，因此新日志在 `session.created` 里记录独立的记忆线程 UUID，线程表对规范化日志路径设唯一键。已有 JSONL 照常续聊。对没有 UUID 的旧日志，在纳入提取范围时按规范化路径幂等登记。[线程字段][threads] · [记忆表与索引][schema] · [就绪度表][progress] · [旧表迁移][drop] · [领取与提交事务][claim] · [SQLite 连接策略][connect]

## 一条记忆怎样写进去、怎样再被找到

1. **新回合提供后台处理机会。** 上游 app-server 在有输入、实际启动了新 turn 且主环境就绪时触发。steer 追加到已在运行的 turn，因此跳过这一步。后台排除临时会话和子 Agent，检查库和可用配额，然后依次运行两个阶段。第一次筛选只考虑允许的交互来源，排除当前线程和禁用线程。默认看最近 10 天、已空闲至少 6 小时的历史，每次最多取 2 个。因而刚结束 A 就打开 B，B 可能还读不到 A。[触发点][trigger] · [后台入口][start] · [默认参数][defaults] · [候选查询][candidates]
2. **阶段一把一段历史变成一份有出处的摘要。** 领取线程和当时的输入版本，从 JSONL 尾部有界读取，上游保留的输入最多 8 MiB，单条记录上限 1 MiB。Kraken 的提取器应逐段读文件，避开现有回放器整文件加载及 32 MB 上限。更早且未被选中的证据不会自动进入摘要。V2 优先保留人的要求与纠正、最终答复等证据，再按原始顺序呈现，对媒体和超长工具输出限量。单次提取调用返回严格的 `{rollout_summary, rollout_slug}`。输出脱敏，摘要限 9,000 字节。验证租约后，在同一记忆库事务中写摘要、记成功并通知全局整合。空摘要也记成功水位，相同输入下次可直接跳过。模型或解析错误进入退避。Kraken 的证据投影只取需要的消息、可见结论、工具动作和结果，送往模型前先脱敏。reasoning、完整 Provider 回包和历史索引不进入提取请求。[输入投影][input] · [V2 提取格式][output] · [结果处理][phase1] · [状态事务][claim]
3. **阶段二把多份摘要整理成短索引。** 全局任务先取得记忆目录的跨进程文件锁和数据库租约。上次整合成功后有 6 小时冷却，新提取的摘要也可能要等下次触发。最多选择 256 份有效摘要，按引用次数、最近使用时间排序。从未用过时按来源更新时间算，默认未使用窗口 30 天。按选择结果同步 `rollout_summaries/`，清除已出选的文件，和记忆目录自己的 Git 基线比较。没有差异且总览有效就完成，有变化或总览无效才启动专用整合 Agent，读取 `phase2_workspace_diff.md` 并更新 `memory_summary.md`。校验通过、复核所有权后，更新基线并登记所消费的确切输入版本。失败时保留上次成功水位，重试重新比较磁盘和数据库。每个线程只有一行最新摘要，上次选中的版本另存标记。摘要文件在整合前就会更新或移除，因此读取旧索引时要能处理来源已变化或缺失。[排序与保留][selection] · [文件锁][lock] · [整合流程][phase2] · [整合提示][consolidate]
4. **新会话先读索引，有需要才打开来源。** 只将非空的 `memory_summary.md` 和读取说明注入线程上下文，索引最多约 2,500 token。V2 总览格式首行仍是 `v1`，全文小于 10,000 个 UTF-8 字节，四节分别是 `User Profile`、`User preferences`、`General Tips`、`What's in Memory`。最后一节按项目和日期指向摘要文件及完整线程 ID。需要历史细节时按文件名读取或搜索，变化快的结论回到当前源码核实。回答若使用了读到的摘要，引用来源文件与行号。按有效引用中的线程 ID 去重更新 `usage_count/last_usage`。仅注入索引不增加计数。[注入及上限][inject] · [格式校验][validate] · [使用与引用协议][read] · [引用计数][usage]

用户明确说「记住」「纠正」或「忘记」某条内容时，上游把请求追加到 `extensions/ad_hoc/notes/`，下次整合应用它。它还提供全局 `memory/reset`，清除派生库中的记忆数据和产物目录，原始会话仍在。启用的历史会话将来可能再次被提取。Kraken 应把「提交更正」「排除来源线程」「清空已生成记忆」表达清楚，分别测试生效时机。拟议的清空操作与发布共用写锁，并使在途任务的提交令牌失效。[显式更正与遗忘][read] · [全局重置][reset]

## Kraken 怎样接入

- **开关放在服务端。** 拟增加 `memories.enabled`（默认关）、`generate_memories`（新线程是否可提取）、`use_memories`（是否向当前会话提供记忆）。后两个开关默认均为真，受总开关控制。沿用现有 `.env` 加载机制，分别映射到 `KRAKEN_MEMORIES_ENABLED`、`KRAKEN_GENERATE_MEMORIES`、`KRAKEN_USE_MEMORIES`。启动根回合时调度一次，在两次运行之间靠 SQLite 续接。普通聊天的成功与否独立判定。长驻 Server 和交互 CLI 可以完成后台工作，一次性 CLI 退出时取消未完成请求、释放租约，由后续有足够运行时间的进程接手。若只使用短命令，可用拟议的前台入口 `kraken-coder memory sync` 运行同一轮调度并等到完成。阶段一和阶段二先复用用户已配置的 Provider，均会消耗该模型额度。兼容服务未提供余额窗口时沿用 Codex 的放行策略。[现有配置](../src/config.ts) · [主循环](../src/core/agent.ts) · [上游配额检查][quota]
- **记忆读取与正常回放分开接入。** 在共享 `runTurn` 首次构建线程上下文时加载索引，作为低优先级的历史材料，与已有系统和项目指令分段。留足当前用户输入、工具 schema 和响应预算，小窗口下先缩减或省略记忆片段。同时继续用 `SessionStore.messages()` 恢复原线程。同一上下文窗口后续回合复用快照，重建窗口时再读当前索引。快照与用户消息分开记录，提取器跳过它。读取细节使用 Codex 提供的专用工具形式，支持列目录、文本搜索、按行读取，以及按用户明确要求追加 note。上游专用工具默认关闭，Kraken 在开启记忆读取时提供它们，以适配现有工作区的文件访问范围。限定记忆根和可见文件，拒绝路径穿越、符号链接及内部 Git 文件。网页和 CLI 共用这一套实现。[上下文组装](../src/core/agent.ts) · [预算](../src/context/budget.ts) · [工作区路径规则](../src/tools/workspace.ts) · [上游线程上下文][session-context] · [上游可选专用工具][tools]
- **后台写入限制在记忆目录。** 单线程提取无需工具。整合 Worker 只读已选摘要、用户 note、当前总览和 diff，只能写候选总览，禁用 shell、网络工具、插件和递归记忆。宿主验证后原子替换总览，读者只会看到完整文件。宿主负责调用 Git 和操作 SQLite。跨进程文件锁须在进程退出时由系统释放，发布前再次检查数据库所有权 token，丢弃租约失效后迟到的结果。这个能力集在 Kraken 各审批模式下相同。上游是在 managed 权限下收窄写目录和网络，其余父权限配置另有分支。[上游 Worker 权限与收尾][phase2] · [记忆目录锁][lock]

首个版本做通 V2 的提取、整合、注入与引用闭环。Kraken 没有 V1 用户，省去 V1 数据迁移和双写。检索走 Markdown 路径及文本搜索，SQLite 负责记录来源、选择和并发控制。这样就能验证跨会话体验，无需引入 embedding 服务或向量数据库。

## 首次实现的验收

| 用例 | 独立观察到什么才算通过 |
| --- | --- |
| A → 重启 → B | A 的真实 JSONL 有一个随机标记、一项用户明确偏好和一项只在候选副本通过的测试。用可控时钟跨过空闲期及已有的整合冷却期，让另一个根回合触发处理。检查 SQLite、摘要和索引均产生后重启。新建 B，检查首个 Provider 请求中的历史材料仅有短索引，需要细节时读到 A 的正确文件及行号，回答保留候选副本这一范围 |
| 默认关闭、读写分离 | 总开关关闭时后台模型调用为零。`generate_memories=false` 创建的会话不被选中。`use_memories=false` 的新会话不包含历史索引，也看不到记忆工具。没有索引或记忆库不可用时，普通回合仍能完成 |
| 去重、并发、崩溃 | 用两进程争抢同一版本，只有一个持有有效租约。模拟中断、租约到期和旧回复延迟到达，由新持有者提交。相同输入及成功的空结果不重复提取。整合中断后，读者仍可解析上一份完整总览，下一轮能修复基线或水位 |
| 范围、纠正与成本 | 同名 session 位于两个工作区，摘要保留各自来源。一次性命令只出现在对应任务下。用于测试的假密钥在提取请求和记忆产物中都已脱敏。来源被排除或显式纠正后，下一次成功整合不再沿用旧说法。直接注入只消耗索引预算，读到并引用的线程才增加使用计数 |

调度、竞态、格式和预算用临时目录、可控时钟与脚本 Provider 离线验收。另用已配置的真实模型做 A → B 盲测，让独立判分同时核对答案、范围和来源。上表目前都是待跑用例。前一份长任务报告中的 8+2 项检查验证的是多步交付与 JSONL 保真，属于另一组证据。

[feature]: https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/features/src/lib.rs#L1452
[version]: https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/core/src/config/mod.rs#L3727
[db]: https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/state/src/sqlite.rs#L127
[db-version]: https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/state/src/runtime/memory_versions.rs#L11
[dir]: https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/protocol/src/memory_version.rs#L17
[threads]: https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/state/migrations/0001_threads.sql
[schema]: https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/state/memory_migrations/0001_memories.sql
[progress]: https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/state/memory_migrations/0002_consolidation_progress.sql
[drop]: https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/state/migrations/0035_drop_memory_tables.sql
[claim]: https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/state/src/runtime/memories.rs#L686
[connect]: https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/state/src/sqlite/connection.rs#L70
[trigger]: https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/app-server/src/request_processors/turn_processor.rs#L772
[start]: https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/memories/write/src/start.rs#L24
[defaults]: https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/config/src/types.rs#L57
[candidates]: https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/state/src/runtime/memories.rs#L244
[input]: https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/memories/write/src/rollout_input.rs#L94
[output]: https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/memories/write/src/phase1_output.rs#L34
[phase1]: https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/memories/write/src/phase1.rs#L228
[selection]: https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/state/src/runtime/memories.rs#L478
[lock]: https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/memories/write/src/workspace_lock.rs#L16
[phase2]: https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/memories/write/src/phase2.rs#L63
[consolidate]: https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/memories/write/templates/memories/consolidation_v2.md
[validate]: https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/memories/write/src/workspace.rs#L76
[inject]: https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/ext/memories/src/prompts.rs#L33
[read]: https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/ext/memories/templates/memories/read_path_v2.md
[usage]: https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/core/src/stream_events_utils.rs#L194
[reset]: https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/app-server/src/request_processors/thread_processor.rs#L2031
[quota]: https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/memories/write/src/guard.rs#L9
[session-context]: https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/core/src/session/mod.rs#L5523
[tools]: https://github.com/openai/codex/blob/5c3ff1dabf644169f4bd74b215719f381e4fdb3f/codex-rs/ext/memories/src/extension.rs#L137
