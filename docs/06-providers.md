# 06 · 模型接口与流式响应

循环只依赖 `Provider.complete(messages, tools, signal)`，返回统一的 `ModelReply`。它不关心 HTTP endpoint，也不直接处理 SSE。新增服务时，应先实现这个边界，并用本机 mock 测试协议，再接真实账户。

## 三种 Provider

| Provider | 用途 | 网络 | 传输 |
| --- | --- | --- | --- |
| demo | 确定性离线教学脚本 | 无 | 直接返回模型协议对象 |
| responses | OpenAI Responses 工具循环 | 配置的 endpoint | SSE；兼容返回完整 JSON 的网关 |
| compatible | OpenAI-compatible Chat Completions 服务，包括火山方舟与 OpenRouter | 配置的 endpoint | SSE，也接受完整 JSON |

Demo 不理解一般自然语言。它支持 `/files`、`/read PATH`、`/search TEXT`、`/skill NAME`，以及专用计算器项目的 `/fix`。执行过程中若工具被拒绝或失败，Demo 明确停止，不假装修复成功。

## 火山方舟和 OpenRouter

点击 Web 输入框下方的模型名，选择服务商。首次配置时输入该平台的 API Key，点击「读取模型」，从列表中选择模型或手动输入 ID，保存后从下一轮起生效。同一平台的模型共用这把 Key。服务为每个平台记住上次使用的模型，两家预设可以在同一会话中切换，历史对话文本和工具结果会发送给新选的平台。

列表由服务端从平台的 `GET /models` 获取。火山普通按量端点也可手填已开通的 `ep-…` 推理接入点。列表中的模型仍受账号开通范围、额度及工具调用能力限制。[火山方舟模型列表](https://console.volcengine.com/ark/region%3Acn-beijing/docs/models-api) · [OpenRouter 模型列表](https://openrouter.ai/docs/api/api-reference/models/get-models)

也可以在启动目录的 `.env` 中配置，或者用 `--env-file` 指定文件。将示例中的模型 ID 替换为账户可用的 ID，再启动服务。

```dotenv
KRAKEN_MODEL_PROVIDER=volcengine
KRAKEN_VOLCENGINE_API_KEY=
KRAKEN_VOLCENGINE_MODEL=你的火山模型或接入点ID
KRAKEN_OPENROUTER_API_KEY=
KRAKEN_OPENROUTER_MODEL=厂商/模型ID
```

`KRAKEN_MODEL_PROVIDER` 可取 `volcengine`、`openrouter`，对应平台和它的模型名一起生效。Web 保存选择会更新启动所用的 `.env`。原先通过 `KRAKEN_BASE_URL` 指向这两家标准地址的配置，仍可使用原有的 `KRAKEN_API_KEY` 和 `KRAKEN_MODEL`。为另一家平台填写独立 Key 即可。

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
| contextChars | 120000 | 未获得 token 窗口时使用的本地字符预算 |
| contextWindowTokens | null（自动） | 手动填写 token 窗口，填 0 使用字符预算 |
| contextCompactRatio | 0.8 | token 窗口触发压缩的比例，可填 0.1–0.95 |
| requestTimeoutMs | 180000（3 分钟） | 单次 HTTP 请求和读取响应总超时，最长 10 分钟 |
| turnTimeoutMs | 10800000（3 小时） | 整个回合，包括审批等待与工具执行，最长 3 小时 |

`--allow-shell` 是独立 CLI 开关，不存入配置文件。`KRAKEN_HOME` 可设置运行数据目录，CLI `--home` 优先。

时限也可在 `.env` 中手动配置，单位为毫秒：

```dotenv
KRAKEN_REQUEST_TIMEOUT_MS=180000
KRAKEN_TURN_TIMEOUT_MS=10800000
KRAKEN_CONTEXT_WINDOW_TOKENS=auto
KRAKEN_CONTEXT_COMPACT_RATIO=0.8
```

手动修改后重启服务。网页右上角「运行设置」可以修改上述字段并保存到启动时使用的环境文件（`--env-file` 或默认 `.env`），从下一轮生效。正在执行的回合继续使用启动时的配置快照。保存时会保留 API Key 和其他环境设置。服务重启后仍按命令行 > 环境变量 > config.json > 默认值的顺序取值。

Kraken 从当前供应商的 `GET /models` 按模型 ID 读取窗口，支持 [火山方舟的 `context_window`](https://docs.volcengine.com/docs/ark/models-api?lang=zh) 和 [OpenRouter 的 `context_length`](https://openrouter.ai/docs/api/api-reference/models/get-model)。预算为 `floor(窗口 × 压缩比例)`，有单独的输入上限时取较小值。发现结果会缓存，缺少窗口字段或发现请求失败时使用本地字符预算。CLI 可用 `--context-window-tokens N|auto` 和 `--context-compact-ratio 0.7`。单独传 `--context-chars N` 会直接选择字符预算。请求前以 UTF-8 JSON 大小估算 token，触发后的处理见 [上下文裁剪](05-sessions-and-context.md#l4-的预算)。

单次请求时限包含思考及整个流式输出，收到增量不会重置计时。报错会明确区分“模型单次请求超时”和“整轮任务超时”；`update_plan` 的 completed 只是模型更新的计划状态，不等于最终答案已经成功返回。

## Chat Completions

POST `<baseUrl>/chat/completions`，发送 messages 和函数 tools。工具调用通过 assistant 的 `tool_calls` 声明，结果使用 `role=tool` 与 `tool_call_id` 回传。

默认请求 `stream: true`，逐块读取 SSE 的 `delta.content` 和 `delta.reasoning_content`，以 `model.delta` 临时事件交给客户端；思考文本的事件附带 `channel: "reasoning"`。工具调用按 `index` 分别拼接 ID、函数名和参数，只有收到 `finish_reason`、`[DONE]` 并通过完整回复校验后才落盘和执行工具。断流、取消、超时或截断不会执行半个工具调用。兼容服务忽略流式请求而返回完整 JSON 时，仍支持原有解码，但该次请求只能完成后显示。字段参考 [火山方舟 Chat API](https://docs.volcengine.com/docs/ark/chat-api?lang=en)。

`decodeChat` 只接受 `stop/tool_calls`。`length/content_filter` 等结束状态报未完成；空文本且没有工具调用也拒绝。来自服务的 `reasoning_content` 保存在 `reasoningContent`，在后续消息中原样回传，但不拼到最终用户答复。

该实现可以连接实现相同协议的服务，包括兼容的 Kimi endpoint；并未声称支持每家服务的专有参数。通过 `KRAKEN_API_KEY` 提供凭据；不自动借用 `OPENAI_API_KEY`。本地无鉴权服务可省略凭据。

OpenRouter 的 Chat 接口还可能返回 `reasoning` 和 `reasoning_details`。前者可作为思考文本展示，后者可能含下一步工具调用所需的签名或加密数据。Kraken 保存这些块供原模型继续调用，切换模型时只带上可移植的对话和工具结果。[OpenRouter 推理字段](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)

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
