# 05 · 完整轨迹、模型窗口与恢复

会话默认保存在 `<workspace>/.kraken-coder/sessions/<id>.jsonl`。`--home` 可以改变数据根目录。session ID 只允许 1～80 个字母、数字、下划线或短横线。

## 日志格式

每行是一个完整记录：

```json
{"version":1,"seq":0,"time":"2026-11-12T02:00:00.000Z","event":{"type":"session.created","id":"study","workspace":"/path/project","provider":"demo:v1"}}
```

`seq` 从 0 连续增加，时间使用 UTC ISO 格式。会话创建记录绑定实际工作区和 Provider；换模型、协议、服务地址或工作区时，应使用新 session。

常见事件：

| 事件 | 用途 |
| --- | --- |
| session.created | 身份和工作区元数据 |
| turn.started | 当前模式、策略、shell 开关 |
| instructions.snapshot | 本轮实际加载的根提示词 |
| message | 原始 user / assistant / tool 消息，恢复输入来源 |
| model.start / model.end | 模型请求边界 |
| tool.start / tool.end | 工具执行与 ok 状态 |
| approval.request / approval.result | 具体审批预览与决定 |
| files.changed / plan.updated | 文件路径和计划事件 |
| context.trimmed | 本次请求删去了多少条旧消息 |
| turn.completed / turn.failed / turn.cancelled | 回合结束状态 |

每次 append 后调用 fsync。API Key 不写入配置或元数据，但用户输入、文件内容、命令输出、推理协议字段会进入日志。它不是加密存储，也不是自动脱敏系统。新建日志权限为 0600。

## 恢复顺序

1. 为该 session 原子创建 `.jsonl.lock` 目录，写入进程 PID。
2. 读取并检查日志格式、版本和连续 seq。
3. 检查 workspace/Provider 是否与创建记录一致。
4. 提取 `message` 事件，运行 L5 `replay`。
5. 对末尾缺少结果的工具调用补上“结果未知”的观察并保存。
6. 加载当前根指令与 Skill 索引，加入新用户消息，再进入 L1。

不会重新执行历史工具。已经有结果的工具也不会因为某个后续模型请求失败而被回滚。恢复保留事实，不承诺自动完成上次中断的任务；新输入应告诉模型接下来做什么。

## 崩溃窗口

```text
assistant 调用意图落盘
        ↓
工具可能已经修改文件
        ↓  ← 在这里崩溃时，日志没有结果，文件却可能已改变
工具结果落盘
```

这里无法做 exactly-once，因为任意 shell 和日志没有共同事务。恢复消息明确告诉模型先检查实际工作区，不能把缺失结果当成“执行失败，可以盲目重试”。

如果日志最后几个字节还没有换行，恢复时只截断这个未完成尾记录。完整行 JSON 损坏、seq 不连续、孤立 tool 结果一律报错。不要删除坏行假装没有发生过。

## 锁恢复

正常完成或异常退出的 finally 会释放目录锁；强杀进程或机器重启后可能留下锁。

先查看 `<session>.jsonl.lock/owner.json`，确认对应进程已经停止，再手动删除该 lock 目录。不要在仍有进程写日志时解锁。实现没有依赖 PID 自动猜测锁是否过期，避免 PID 复用造成错误判断。

单 session 只允许一个写者。不同 session 可以并行运行，但**没有工作区级修改锁**；如果两个 session 编辑同一项目，补丁内容检查只能发现部分冲突。教学时建议每个工作副本同时运行一个修改任务。

## L4 的预算

每次模型请求前计算消息 JSON 字符数，预算预先扣除工具 schema 的 JSON 字符数。超限时从最早旧 user 消息开始，删到下一个 user 之前；system 与当前用户回合始终保留。

```text
system | user1 assistant tool assistant | user2 assistant | user3 assistant tool
         └────完整旧轮次，可删除─────┘      可删除           当前轮次，必须保留
```

此处按整个用户回合裁剪，所有 call_id 配对自然一起移动。对于 Responses，`responseItems` 包含 reasoning 和 function_call，它们也随整轮保留或删除。

这只是可解释的字符预算，不等于模型真实 token 上限，也不会处理所有远端 context length 错误。若当前回合本身过大，运行会报错，读者可缩小读取结果、开始新会话或调整 `--context-chars`。不要无限增大到服务本身不支持的大小。

完整消息从未被裁剪出 JSONL。下次恢复仍从完整历史重新计算请求窗口。这里没有摘要生成、长期记忆、向量检索或远端 compaction checkpoint；想添加这些机制时，应在“工作上下文”和“原始轨迹”之间保留清楚边界。

## 查看数据

```bash
npm run dev -- sessions
npm run dev -- history study
npm run dev -- exec --provider demo --session study --message '/read package.json'
```

history 是只读命令，不获取写锁，最多读到当前完整记录。单份日志读取上限为 32 MB；这是教学规模限制。达到限制时应保留旧日志并新建 session，而非依赖无限增长。
