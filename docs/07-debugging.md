# 07 · 调试、排错与验证

## 常用命令

所有命令在项目根目录执行，参数前的 `--` 用来交给 npm 脚本。

```bash
npm run dev -- help
npm run demo -- --mode learner --trace
npm run check -- --stage 1 --mode learner --trace --debug
npm run check -- --all --mode reference
npm run typecheck
npm test
npm run build
node dist/cli.js demo --mode learner
```

`npm run verify` 串联类型检查、测试、两种模式的完整阶段验收和构建。测试没有真实模型调用，HTTP 验证只监听 127.0.0.1。

根目录测试不包含 `examples/buggy-calculator` 的故意失败测试。贯穿演示会复制相同缺陷到临时项目，先验证失败、再修改并验证成功；不要直接在仓库示例中执行全量验收并把故意失败误判成项目回归。

## VS Code

按 F5，选择 `Kraken：阶段验收（离线）`，再选择 stage 和 mode。学习版断点放在 `src/learning/exercises.ts`；网络边界放在 Provider；副作用边界放在 `ToolRegistry.execute` 的 `prepared.run`。

建议观察以下变量：

| 断点 | 观察 |
| --- | --- |
| runLoop / provider.complete 之前 | history、context 窗口、maxSteps |
| assistant checkpoint | toolCalls 和调用 ID 是否已经持久化 |
| ToolRegistry / decision | schema 校验后的 args、effect、policy |
| preparePatch 返回前 | 每个文件 before/after，磁盘尚未变化 |
| applyChanges 写入前 | 预览后文件是否被别人改动 |
| SessionStore.open | records、seq、未完成尾记录 |
| replay 返回前 | 缺失结果如何补成 unknown 观察 |

不使用 VS Code 时：

```bash
node --inspect-brk --import tsx src/cli.ts check --stage 1 --mode learner
```

## 事件与原始历史

```bash
npm run dev -- exec --provider demo --message '/read package.json' --session debug --trace
npm run dev -- history debug
npm run dev -- exec --provider demo --message /files --session debug --json
```

trace 只显示摘要，JSONL history 包含完整消息和审批预览。线上调试时不要把含项目源码的日志随意公开；配置诊断不需要打印密钥。

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| Demo 不帮我实现自然语言任务 | Demo 是固定脚本；配置 responses/compatible |
| Policy denied shell | 没开启 `--allow-shell`，或使用了 read-only |
| User denied apply_patch | 用户选了否，或非交互环境没有审批终端；交互运行或明确选择允许的策略 |
| Session belongs to a different… | 改了工作区/模型/endpoint；换新的 session ID |
| Session is locked | 有活动写者或陈旧锁；先核对 PID 再手动清理 lock 目录 |
| Patch context is ambiguous | 旧片段重复；读取更多上下文，并带上能唯一定位的完整行 |
| Patch context not found | 文件与模型看到的版本不同；重新读取，不使用模糊替换掩盖冲突 |
| File changed since patch preview | 审批期间文件改变；重新计算与审批新补丁 |
| Read project_instructions… | 新目标目录有未读或变化的 AGENTS.md；先读取该目标的指令 |
| Context budget exceeded… | 当前回合或指令太大；减少工具输出、开启新会话或合理调整预算 |
| Provider HTTP 401/403 | 核对对应服务密钥与权限；doctor 只检查是否配置，不验证有效性 |
| Incomplete response / stream ended… | 网络断线或模型输出未完成；已发生的工具结果仍在日志，恢复前查看实际状态 |

## 加一个自己的离线任务

先理解 `DemoProvider` 按最新用户消息划分当前回合，再按已有工具结果数量决定下一步。你可以在独立分支加入一个新命令，比如读取两个配置文件并比较。

更通用的测试方式是注入自己的 `Provider`：

```ts
import { runTurn, defaults, type Provider } from 'kraken-coder';

const provider: Provider = {
  name: 'my-script:v1',
  async complete(messages) {
    return { content: `观察到 ${messages.length} 条消息` };
  },
};

await runTurn({
  config: { ...defaults, approval: 'read-only' },
  workspace: '/path/to/your/project',
  home: '/path/to/your/project/.kraken-coder',
  session: 'custom-demo',
  provider,
}, '解释一次回合');
```

在当前源码仓库里，可以从 `../src/index.js` 导入，使用 tsx 运行；上例的包名导入用于安装或链接后的包。新增 Provider 应遵守 AbortSignal；HTTP 和内置 shell 已实现取消，自定义实现若忽略 signal，宿主无法强行停止其内部副作用。

## 打包

```bash
npm run build
npm pack --dry-run
node dist/cli.js help
```

dist 包含 `.js`、声明与 source map，Demo 项目由代码生成，所以构建后不依赖源码目录中的模板文件。Node.js 内置模块构成所有运行时依赖；typescript、tsx 与 @types/node 仅用于开发。
