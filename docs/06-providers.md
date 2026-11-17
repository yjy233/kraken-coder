# 06 · 模型接口与流式响应

循环只依赖 `Provider.complete(messages, tools, signal)`，返回统一的 `ModelReply`。它不关心 HTTP endpoint，也不直接处理 SSE。新增服务时，应先实现这个边界，并用本机 mock 测试协议，再接真实账户。

## 三种 Provider

| Provider | 用途 | 网络 | 传输 |
| --- | --- | --- | --- |
| demo | 确定性离线教学脚本 | 无 | 直接返回模型协议对象 |
| responses | OpenAI Responses 工具循环 | 配置的 endpoint | SSE；兼容返回完整 JSON 的网关 |
| compatible | OpenAI-compatible Chat Completions 服务 | 配置的 endpoint | 非流式 JSON |

Demo 不理解一般自然语言。它支持 `/files`、`/read PATH`、`/search TEXT`、`/skill NAME`，以及专用计算器项目的 `/fix`。执行过程中若工具被拒绝或失败，Demo 明确停止，不假装修复成功。

## 配置优先级

命令行 > 环境变量 > `<home>/config.json` > 默认值。`.env` 在启动时读入，但不覆盖已有 shell 环境。`--env-file PATH` 指定文件，`--cwd` 不会改变默认 `.env` 的查找位置。

运行 `init` 可生成不含密钥的配置。所有支持字段见 `src/config.ts` 和 `examples/config.*.json`。未知字段直接报错，所以不要把 `apiKey` 放进 config.json。

| 配置 | 默认值 | 作用 |
| --- | --- | --- |
| provider | demo | 协议选择 |
| mode | reference | 学习算法选择 |
| approval | ask | 工具审批策略 |
| model | 空 | 线上服务必须指定 |
| baseUrl | 空；responses 自动使用 OpenAI v1 | API 根地址，不包含具体资源路径 |
| maxSteps | 16 | 每回合模型请求数，包含最终答复 |
| contextChars | 120000 | 消息与工具 schema 的近似字符预算 |
| requestTimeoutMs | 180000（3 分钟） | 单次 HTTP 请求和读取响应总超时，最长 10 分钟 |
| turnTimeoutMs | 10800000（3 小时） | 整个回合，包括审批等待与工具执行，最长 3 小时 |

`--allow-shell` 是独立 CLI 开关，不存入配置文件。`KRAKEN_HOME` 可设置运行数据目录，CLI `--home` 优先。

时限也可在 `.env` 中手动配置，单位为毫秒：

```dotenv
KRAKEN_REQUEST_TIMEOUT_MS=180000
KRAKEN_TURN_TIMEOUT_MS=10800000
```

手动修改后重启服务。网页右上角“运行设置”可修改同一组字段，保存到服务启动时使用的环境文件（`--env-file` 或默认 `.env`），并立即更新服务内的配置，从下一轮生效；正在执行的回合使用启动时的配置快照。页面只写这两个时限字段，不读回或展示 API Key。服务重启后仍按命令行 > 环境变量 > config.json > 默认值的顺序取值。

单次请求时限包含思考及整个流式输出，收到增量不会重置计时。报错会明确区分“模型单次请求超时”和“整轮任务超时”；`update_plan` 的 completed 只是模型更新的计划状态，不等于最终答案已经成功返回。

## Chat Completions

POST `<baseUrl>/chat/completions`，发送 messages 和函数 tools。工具调用通过 assistant 的 `tool_calls` 声明，结果使用 `role=tool` 与 `tool_call_id` 回传。

默认请求 `stream: true`，逐块读取 SSE 的 `delta.content` 和 `delta.reasoning_content`，以 `model.delta` 临时事件交给客户端；思考文本的事件附带 `channel: "reasoning"`。工具调用按 `index` 分别拼接 ID、函数名和参数，只有收到 `finish_reason`、`[DONE]` 并通过完整回复校验后才落盘和执行工具。断流、取消、超时或截断不会执行半个工具调用。兼容服务忽略流式请求而返回完整 JSON 时，仍支持原有解码，但该次请求只能完成后显示。字段参考 [火山方舟 Chat API](https://docs.volcengine.com/docs/ark/chat-api?lang=en)。

`decodeChat` 只接受 `stop/tool_calls`。`length/content_filter` 等结束状态报未完成；空文本且没有工具调用也拒绝。来自服务的 `reasoning_content` 保存在 `reasoningContent`，在后续消息中原样回传，但不拼到最终用户答复。

该实现可以连接实现相同协议的服务，包括兼容的 Kimi endpoint；并未声称支持每家服务的专有参数。通过 `KRAKEN_API_KEY` 提供凭据；不自动借用 `OPENAI_API_KEY`。本地无鉴权服务可省略凭据。

## Responses

POST `<baseUrl>/responses`，使用：

```json
{"model":"YOUR_MODEL","input":[],"tools":[],"stream":true,"store":false,"include":["reasoning.encrypted_content"]}
```

这里手动管理历史。assistant 的原始 `output` 数组整体保存在 `responseItems`，下一次请求按原序回传 reasoning、message 和 function_call；工具结果转换为独立的 `function_call_output`，通过 `call_id` 关联。没有使用 `previous_response_id`，所以会话可以从本地日志重建请求。

工具使用 `strict:false`，允许本项目带可选参数的 schema；执行前仍由本地校验器检查。这里只支持函数工具，不包含 OpenAI 托管的搜索或代码执行工具。

这部分依据 [官方 Function calling 指南](https://developers.openai.com/api/docs/guides/function-calling) 核对：工具调用需要把输出关联回原调用，推理模型在后续工具请求中也需要保留返回的 reasoning items。实现和本地固定 Codex 快照的 Responses item 设计相呼应。

## SSE 的完整性

网络 chunk 可以结束在任意位置，包括一个 UTF-8 字符或一行 JSON 的中间。`sse.ts` 先用流式 TextDecoder 重建字符串，再以空行解析 SSE frame，支持 CRLF、多行 data 和注释。

`response.output_text.delta` 只生成临时显示事件。只有 `response.completed` 且完整 response 状态为 `completed` 时，Provider 才返回供循环执行的结果。断线、失败事件或只有部分文本，都会报错；绝不据半个 function_call 执行工具。

`--json` 输出增量事件；普通终端模式只显示最终文本。原始流不逐块保存到 JSONL。

## HTTP 行为

支持 HTTPS，以及 loopback 地址上的 HTTP。URL 不能包含用户名、密码、query 或 fragment。fetch 拒绝跳转，避免凭据在重定向时发给意外目标。单次响应最大 4 MB，SSE 未完成单帧最大 2 MB。

HTTP 失败只报告状态码，不直接打印未知服务返回的错误 body，避免对方回显密钥。没有自动重试、模型切换或服务回退；在线出现错误时，会话轨迹保留已发生的工具操作，读者可以明确选择下一步。

`doctor` 不调用网络，只检查配置。自动化测试与阶段验收仍使用本机 HTTP mock 和离线场景。2026-11-14，compatible 通过 Kimi 官方中国站 API（`https://api.moonshot.cn/v1`，模型 `kimi-k3.1-pro`）完成了 `search.ignore_case` 的真实修改任务：模型自行选择工具、生成补丁、执行验收和完整验证。任务准备、宿主介入边界与实际结果见 [学习记录](08-learning-progress.md)。Responses 尚未完成线上联调；更换账户、模型或服务后，仍需实际请求确认兼容性。
