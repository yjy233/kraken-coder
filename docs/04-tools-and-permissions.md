# 04 · 从工具提议到文件修改

模型返回的函数名和 JSON 参数只是一份提议。真正执行动作的是 `ToolRegistry`，不是 Provider。

## 工具接口

每个 Tool 绑定 `name/description/parameters/effect/prepare`。`prepare(args)` 返回可展示的 `preview` 和执行函数 `run(signal)`。

Schema 校验器实现本项目需要的有限 JSON Schema 子集：object、string、integer、boolean、array、enum、required、额外属性拒绝，以及长度/范围限制。它不是通用 JSON Schema 实现。模型仍可能输出不符合 schema 的参数，宿主必须重新检查。

未知工具、JSON 格式错误、参数错误和执行错误统一返回 tool 观察，保留原始 `callId`。取消则向外抛出，终止整个回合。

## 内置工具

| 工具 | effect | 关键限制 |
| --- | --- | --- |
| list_files | read | 默认最多 1000 文件，目录深度 20、访问条目 10000；不读取 `.gitignore` |
| read_file | read | 文本文件最大 256 KB；按行分页，每次最多 400 行 |
| search | read | 字面搜索，不执行正则；可用 `ignore_case` 忽略大小写；最多 80 条匹配，单条显示前 400 字符 |
| project_instructions | read | 获取目标文件作用域的 AGENTS.md，也支持尚不存在的目标 |
| apply_patch | write | 一次 1～32 文件、参数上限、唯一完整行匹配 |
| shell | shell | POSIX `/bin/sh`，默认 30 秒，最多 120 秒，输出上限 16000 字符 |
| update_plan | state | 1～12 步，最多一个 in_progress |
| read_skill | read | 只能读已索引的工作区 Skill 名称 |

所有工具输出最终还有一层 20000 字符限制；超长结果转成带 `truncated` 的头尾预览。读取大文件时缩小行数，搜索结果只作为定位依据。文件与搜索有明确扫描上限，空结果不等于大仓库绝对不存在目标。

`search` 的 `ignore_case` 是可省略的布尔参数，默认为 `false`。设为 `true` 后按不区分大小写的字面子串匹配，返回的路径、行号和文本预览仍保持原样。字符串、数字和 `null` 等非布尔值会被 schema 拒绝；目录范围、结果上限和空关键词错误行为不变。

## 策略和 shell 开关

`read-only` 拒绝项目修改和所有 shell。`ask` 把补丁和命令交给用户审批。`auto-review` 把同一份操作交给当前模型单独审核。`workspace-write` 自动应用文件补丁，shell 仍需审批。`full-auto` 自动允许两者。

服务启动时的 `--allow-shell` 决定能否使用 shell。运行中切换审批模式从下一回合生效。CLI 输入 `y` 批准本次，直接回车拒绝，有可记忆的规则时还可输入 `p`。

自动审核通过一次独立、无工具的模型请求读取本轮用户要求、已送达的调整、工作区路径及完整操作预览。审核结果为允许、拒绝或转人工。遇到离线 Demo、模型错误、无效回复或审核预算不足时，操作等待人工审批。审核文字不进入任务对话。

## 记住命令

人工审批卡片只对能识别的命令显示「此工作区以后允许」。`git status`、`git ls-files`、`ls`、`pwd` 可带实现中列出的展示参数。例如批准 `git status --short` 后，`git status -sb` 也可使用这条规则。带路径、管道、重定向或命令拼接的请求仍按当前审批模式处理。

`npm test` 和 `npm run test/build/typecheck/lint/verify` 按完整命令逐条记忆。例如记住 `npm run build` 只授权该工作区运行同名脚本，执行时使用项目当时的脚本内容，追加参数需要重新审批。

命令匹配先经过 shell 开关和权限策略。只有用户能保存规则，审核模型的同意只对当前操作生效。规则跨会话和重启有效。每条规则对应文件 `~/.kraken-coder/command-rules/<工作区真实路径的 SHA-256>/<命令名>`，删除对应文件即可撤销；下一次检查会重新读取。匹配和可记忆参数见[命令规则](../src/permissions/command-rules.ts)。

## Patch 子集

```diff
*** Begin Patch
*** Add File: notes.txt
+new file
*** Update File: calculator.js
@@
 export function add(a, b) {
-  return a - b;
+  return a + b;
 }
*** Delete File: obsolete.txt
*** End Patch
```

支持多文件和一个 Update 中的多个 bare `@@` hunk。每个 hunk 的旧文本必须非空且唯一匹配。新增内容每行以 `+` 开头。空白上下文行也需要一个前导空格。

不支持 git unified diff 的行号、`*** Move to`、`*** End of File`、模糊空白匹配。Update 保留原文件 LF/CRLF 和末尾换行状态；Add 默认使用 LF 并补末尾换行。新文件默认为 0644，更新保留已有常规权限。

`preparePatch` 为每个目标保存 before/after。审批后 `applyChanges` 再读取所有目标；任何内容与预览前不一致都停止。单文件更新采用同目录临时文件加 rename，避免读者看到半个文件。

多文件不是数据库事务：预检失败不会修改任何目标，但写入阶段遇到磁盘错误或取消，之前已完成的文件可能保留。崩溃后必须检查工作区；不要把 `files.changed` 事件缺失理解成文件肯定没有变化。

## 工作区边界

内置文件工具拒绝绝对路径、`..`、反斜杠、NUL、`.git`、`.kraken-coder`、`node_modules` 和真实 `.env*`（允许 `.env.example`）。同时逐级拒绝符号链接、特殊文件和多硬链接普通文件。

`list_files` 还跳过 `dist/out/coverage` 等生成目录。根目录外的 AGENTS.md 不会被加载。

这些检查适合单用户教学场景，不抵御敌对进程在校验与读写之间替换目录的竞态。如果需要处理不可信仓库或模型命令，应该把整个练习环境放在合适的隔离环境中；本项目没有 OS 沙箱和网络隔离实现。

shell 只继承 PATH、HOME、USER、TMPDIR、LANG、LC_ALL，不自动继承 API Key 或 NODE_OPTIONS。它仍然可以主动读本机文件，所以“环境变量未继承”不等于敏感数据不可访问。自定义 `--home` 应放在工作区外或使用默认受保护目录，避免把日志混进代码搜索。

## 写自己的工具

`ToolRegistry.register` 是公开扩展点，可通过 `src/index.ts` 导入。添加内置工具时，在 `registerBuiltins` 注册，并补能覆盖其实际副作用的案例。

设计时首先决定 effect，再写参数约束；先把动作准备成具体预览，再把真正写入放进 `run`。如果一个工具既读又写，应按 write 分类。如果会执行任意命令，应按 shell 分类。不要把自定义写入工具伪装成 read 来绕过审批。
