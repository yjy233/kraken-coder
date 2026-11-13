# 03 · L0～L6 学习路线

目标不是背 API 字段，而是能解释每一次模型请求为什么发生、每一个副作用经过了哪些检查，以及程序停止后哪些事实仍然可信。

## 开始前

需要 Node.js 24+、基本 TypeScript/async-await 知识和终端。无需 Rust 基础、API Key 或已有 Codex 安装。

```bash
npm install
npm run demo -- --mode reference --trace
npm run check -- --all --mode learner
```

先保留两份已通过的实现。学习时只改 `src/learning/exercises.ts` 的一个函数，或在自己的分支中清空它的函数体；不要把 reference 导入 learner，也不要通过修改验收用例规避失败。

每个阶段使用同一组验收，但两份实现彼此独立。要确认改动真的生效，可以临时在 learner 函数中抛一个带自己名字的错误：learner 应失败，reference 应通过，随后恢复代码。

## L0 · Provider 与工具协议

阅读 `decodeChat`、`providers/compatible.ts`、`providers/responses.ts`。

在 `decodeChat` 第一行下断点，运行：

```bash
npm run check -- --stage 0 --mode learner --trace
```

观察本机 mock 返回的 assistant：它同时包含文本、`tool_calls` 和 `reasoning_content`。逐步确认调用 ID 在模型响应、tool 结果和下一次 HTTP 请求里没有变化。

任务：自己重写响应解码，区分 `finish_reason=stop/tool_calls` 与 `length`。对于 `length`，即使有文本也必须报未完成；不能让一半工具参数进入执行器。

验收标准：工具及推理字段正确回传，重复 ID 和截断响应被拒绝。进一步阅读 `tests/providers.test.ts` 的单字节 SSE 用例，理解网络 chunk 和协议 frame 的区别。

思考：为什么 `response.output_text` 或最后一段可见文本不足以恢复推理模型的工具回合？

## L1 · Agent 循环

阅读 `runLoop` 和 `LoopRuntime`。在 `provider.complete` 与 `runtime.execute` 两处下断点。

```bash
npm run check -- --stage 1 --mode learner --trace
```

每一步维护三个事实：已提交的历史、本次模型响应、按 ID 配对的工具结果。只有没有工具调用的有效响应才算完成。

任务：不看 reference 重写循环。输入数组不能被原地修改；每条 assistant 必须先 checkpoint，再执行工具；所有工具结果收齐后才发起下一次模型请求。

验收标准：同一响应多个工具按顺序执行，文本加工具不会提前结束，调用 ID 不能跨 step 重复，步数耗尽前不启动新工具但保存其意图，取消时不再请求模型。

思考：如果在执行补丁之后、保存结果之前进程崩溃，单纯重试这一个 step 会发生什么？答案会在 L5 用到。

## L2 · 工具注册与审批

阅读 `decide`、`ToolRegistry.execute`、`Tool.prepare`。

```bash
npm run check -- --stage 2 --mode learner --trace
```

流程依次是查工具、解析参数、schema 校验、策略决定、生成具体预览、用户审批、执行。`prepare` 可以读文件做检查，但不能产生修改。没有具体预览就请求用户批准，用户无法判断将发生什么。

任务：实现四种策略与 `shellEnabled` 的完整矩阵，并给自己的工具选择正确 effect。`read-only` 下的 plan 更新属于会话状态，不会写项目文件，因此允许。

验收标准：错误参数不会进入审批；拒绝后没有副作用；`full-auto` 也不能绕过未开启的 shell 开关。非交互审批返回 false，不偷偷视为同意。

思考：为什么不能把 `rm`、`git` 等命令做一个名字黑名单，就宣布“shell 是安全的”？本项目因此没有声称实现 OS 沙箱。

## L3 · 文件与补丁

阅读 `replaceText`、`preparePatch`、`applyChanges`、`Workspace.path`。

```bash
npm run check -- --stage 3 --mode learner --trace
```

先区分三个阶段：语法解析；读取目标并计算所有新内容；审批后重新检查旧内容并写入。这里的 `replaceText` 只是纯字符串算法，不能读写文件。

任务：实现唯一精确匹配，包括重叠匹配（`aaa` 中的 `aa` 有两个位置）。补丁解析器在调用它前加上完整行边界，防止把 `a` 替换到 `data` 的中间。

验收标准：没有匹配、多处匹配、过期内容、越界路径、受保护目录和链接均被拒绝；审批前的预览不改变文件；后面的目标校验失败不能先写前面的文件。

思考：全量预检与跨文件事务有什么区别？如果写第 2 个文件时磁盘出错，第 1 个文件不一定能回滚。

## L4 · 工作上下文

阅读 `fitContext` 和 `Agent` 传入的 `context` 回调。

```bash
npm run check -- --stage 4 --mode learner --trace
```

完整日志与模型请求窗口不是一回事。前者用于审计和恢复，后者受模型上下文大小限制。教学版用 JSON 字符数近似预算，并先扣除工具 schema 大小；它不估算真实 token 数。

任务：保留 system 与当前完整用户回合，仅按旧用户回合的边界删内容。如果当前回合本身就过大，必须报错，不能把刚读取的关键代码默默截断到“勉强能发”。

验收标准：工具声明与所有结果一起保留或一起删除；输入数组不变；删完旧回合仍然超限时明确失败。

思考：删除旧回合会失去用户曾经给过的约束。要升级为模型摘要，需要哪些摘要质量验证、超时兜底和持久化 checkpoint？本版把它保留为扩展问题，不假称已经实现。

## L5 · 会话恢复

阅读 `replay`、`SessionStore.open/append`。

```bash
npm run check -- --stage 5 --mode learner --trace
```

日志中有 assistant 工具意图、但缺少 tool 结果时，工具可能没执行，也可能已经执行成功。恢复算法不能知道，所以补上 `outcome unknown` 的失败观察，并让模型重新检查实际工作区。它不会重新执行旧调用。

任务：验证完整历史，识别尾部未配对工具，返回新的消息数组。恢复同一份已经修复的历史，结果应不再增加消息。

验收标准：未知结果得到明确标注；孤立或重复 tool 结果报错；同 session 并发写入被锁阻止；仅末尾未换行的残缺记录可截断，完整行损坏不能跳过。

思考：为什么这里不能承诺 exactly-once？日志和任意 shell/文件操作没有共同的事务提交机制。

## L6 · 项目指令与 Skills

阅读 `Instructions`、`listSkills` 和 `registerBuiltins`。这是扩展层练习，不在 exercises.ts 中新增算法。

```bash
npm run check -- --stage 6 --mode learner --trace
```

任务：复制示例 Skill 到某个练习工作区的 `.agents/skills/review/SKILL.md`，用 `skills` 查看索引，再用 Demo 的 `/skill review` 读取正文。添加 `src/AGENTS.md`，比较根提示词和 `read_file src/example.ts` 的工具结果。

验收标准：初始提示词只有 Skill 名称和描述；正文只在读取时进入对话；目录指令按从根到目标目录排序；指令改变后补丁要求重新读取；plan 更新发出结构化事件。

思考：Skill 与 Plugin 有什么区别？本版的 Skill 是文本，不能自己注册新代码。要执行扩展代码，需要额外的信任与生命周期设计。

## 毕业任务

```bash
npm run verify
npm run demo -- --mode learner --trace
```

在本地任选一个小项目，先用 `--approval read-only` 和真实模型理解代码，再在交互终端切换 `ask --allow-shell` 做一次完整修改。检查具体补丁、运行相关测试，并在新进程中用同一个 session 恢复。

你应该能回答：最终答案由谁判断完成；工具结果如何配对；审批与沙箱是否等价；完整历史在哪里；哪些旧上下文被裁掉；中断时什么状态未知；真实模型与离线脚本的能力差异是什么。
