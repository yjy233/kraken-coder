# 文档导航

建议先运行根目录的 `npm run demo -- --trace`，看到真实修复发生，再沿以下路线阅读。

| 文档 | 要回答的问题 |
| --- | --- |
| [01 架构](01-architecture.md) | 为什么需要 Agent 外壳、循环、Provider 和工具运行时四层？ |
| [02 Codex 源码导读](02-codex-reference.md) | 教学版每个模块对应本地 Codex 的什么位置？哪些地方做了简化？ |
| [03 学习路线](03-learning-path.md) | L0～L6 如何下断点、改算法、独立验收？ |
| [04 工具与权限](04-tools-and-permissions.md) | 模型提议的 JSON 怎样成为一次受控文件修改？ |
| [05 会话与上下文](05-sessions-and-context.md) | 完整历史、模型窗口、崩溃恢复为什么是不同的问题？ |
| [06 模型接入](06-providers.md) | Responses 与 Chat Completions 怎样归一化？如何处理半截流？ |
| [07 调试与排错](07-debugging.md) | 如何跑完整命令、定位失败、恢复陈旧锁和接入自己的工具？ |

所有阶段默认离线；文档中的在线聊天命令只有在读者主动执行时才访问配置的模型服务。
