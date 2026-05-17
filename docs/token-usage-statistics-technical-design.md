# Token Usage Statistics Technical Design

Status: draft
Last updated: 2026-05-17

## 1. 背景

Kraken Coder 已经开始支持 Qwen、OpenAI/GPT、Anthropic/Claude 三类模型。下一步需要统计每次模型请求的 token 使用情况，并能在 agent run、session、全局维度汇总。

本文只写技术设计，不改运行代码。实现前建议先对所有供应商 API 做一轮最小请求探测，确认实际返回的 `usage` 结构与文档一致，再落实现。

目标：

- 记录每一次 provider API 请求的真实 usage，而不是只做本地估算。
- 覆盖非流式和流式请求。
- 区分 input/output/reasoning/cache/multimodal/tool usage。
- 支持按 step、run、session、provider、model 聚合。
- 为 UI 展示 `last request`、`current run`、`session total`、`cache hit`、`reasoning tokens` 留出数据结构。

非目标：

- 第一版不做价格计算；价格表变化频繁，后续单独做 pricing profile。
- 第一版不把本地 tokenizer 估算当作计费依据。
- 不为了统计 token 而默认多发一次完整生成请求。

## 2. 官方字段事实

### 2.1 OpenAI Responses

OpenAI Responses response object 返回：

- `usage.input_tokens`
- `usage.input_tokens_details.cached_tokens`
- `usage.output_tokens`
- `usage.output_tokens_details.reasoning_tokens`
- `usage.total_tokens`

Responses 还提供输入 token 预估接口：

- `POST /v1/responses/input_tokens`

流式时应从最终 `response.completed` 事件里的 `response.usage` 读取 usage。若 stream 被中断，可能拿不到最终 usage。

参考：

- https://platform.openai.com/docs/api-reference/responses
- https://platform.openai.com/docs/guides/reasoning

### 2.2 OpenAI Chat Completions

Chat Completions response object 返回：

- `usage.prompt_tokens`
- `usage.prompt_tokens_details.cached_tokens`
- `usage.completion_tokens`
- `usage.completion_tokens_details.reasoning_tokens`
- `usage.total_tokens`

流式时需要在请求里加：

```json
{
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

最终 chunk 的 `choices` 可以为空，`usage` 包含整次请求统计。若 stream 被中断，最终 usage chunk 可能收不到。

参考：

- https://platform.openai.com/docs/api-reference/chat/create
- https://platform.openai.com/docs/api-reference/chat-streaming
- https://platform.openai.com/docs/guides/prompt-caching

### 2.3 Anthropic Messages

Anthropic Messages response usage 返回：

- `usage.input_tokens`
- `usage.output_tokens`
- `usage.cache_creation_input_tokens`
- `usage.cache_read_input_tokens`
- `usage.cache_creation.ephemeral_5m_input_tokens`
- `usage.cache_creation.ephemeral_1h_input_tokens`
- `usage.server_tool_use`

流式时，`message_delta` 事件里的 `usage` 是累计值，应保留最后一次非空 usage 作为本次请求的最终 usage。

Anthropic 提供输入 token 预估接口：

- `POST /v1/messages/count_tokens`

Token counting API 返回的是发送前输入 token 估算；实际 `messages` 请求的 token 数可能因为 Anthropic 内部优化而有小差异，所以最终统计仍以真实 response usage 为准。

参考：

- https://docs.anthropic.com/en/api/messages
- https://docs.anthropic.com/claude/reference/messages-streaming
- https://docs.anthropic.com/en/docs/build-with-claude/token-counting
- https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching

### 2.4 Qwen OpenAI-Compatible Chat Completions

Qwen OpenAI-compatible Chat Completions 返回：

- `usage.prompt_tokens`
- `usage.completion_tokens`
- `usage.total_tokens`
- `usage.prompt_tokens_details.cached_tokens`
- `usage.prompt_tokens_details.text_tokens`
- `usage.prompt_tokens_details.image_tokens`
- `usage.prompt_tokens_details.video_tokens`
- `usage.prompt_tokens_details.audio_tokens`
- `usage.completion_tokens_details.reasoning_tokens`
- `usage.completion_tokens_details.text_tokens`
- `usage.completion_tokens_details.audio_tokens`
- `usage.cache_creation_input_tokens`
- `usage.cache_creation.ephemeral_5m_input_tokens`
- `usage.cache_type`

流式时同样需要：

```json
{
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

最终 chunk 才返回 usage。深度思考流式内容在 `choices[].delta.reasoning_content`，但最终 token 数应以 `usage` 为准，不应由前端 thinking 文本长度估算。

参考：

- https://help.aliyun.com/zh/model-studio/use-qwen-by-calling-api
- https://help.aliyun.com/zh/model-studio/deep-thinking
- https://help.aliyun.com/zh/model-studio/context-cache

## 3. API 探测计划

实现前先跑最小探测请求，保存 raw JSON 样本到本地临时目录，例如 `.kraken-coder/debug/usage-probes/`，不要提交 API key 或完整敏感 prompt。

探测维度：

| Provider | API | Non-stream | Stream | Thinking | Tool call | Cache |
| --- | --- | --- | --- | --- | --- | --- |
| OpenAI | Responses | 必测 | 必测 | 必测 | 必测 | 必测 |
| OpenAI | Chat Completions fallback | 必测 | 必测 | 视模型 | 必测 | 必测 |
| Anthropic | Messages | 必测 | 必测 | 必测 | 必测 | 必测 |
| Qwen | OpenAI-compatible Chat | 必测 | 必测 | 必测 | 必测 | 必测 |

最小 prompt：

```text
Reply with exactly: ok
```

Tool call prompt：

```text
Call the provided echo tool with {"text":"ok"}.
```

Cache 探测：

1. 发送一次包含稳定长 system/tool/context 的请求。
2. 立即发送第二次完全相同 prefix、不同末尾 user prompt 的请求。
3. 比较 cache read/hit 字段。

### 3.1 OpenAI Responses 探测

```bash
curl https://api.openai.com/v1/responses \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "input": "Reply with exactly: ok",
    "reasoning": { "effort": "low" },
    "max_output_tokens": 64
  }'
```

流式探测使用同一 body 加 `"stream": true`，记录 `response.completed.response.usage`。

输入 token 预估探测：

```bash
curl https://api.openai.com/v1/responses/input_tokens \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "input": "Reply with exactly: ok"
  }'
```

### 3.2 Anthropic Messages 探测

```bash
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4.6",
    "max_tokens": 64,
    "messages": [
      { "role": "user", "content": "Reply with exactly: ok" }
    ]
  }'
```

流式探测加 `"stream": true`，记录最后一个带 `usage` 的 `message_delta`。

输入 token 预估探测：

```bash
curl https://api.anthropic.com/v1/messages/count_tokens \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4.6",
    "messages": [
      { "role": "user", "content": "Reply with exactly: ok" }
    ]
  }'
```

### 3.3 Qwen OpenAI-Compatible 探测

```bash
curl https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions \
  -H "Authorization: Bearer $DASHSCOPE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.6-plus",
    "messages": [
      { "role": "user", "content": "Reply with exactly: ok" }
    ],
    "enable_thinking": true,
    "thinking_budget": 256,
    "stream": true,
    "stream_options": { "include_usage": true }
  }'
```

记录：

- thinking delta: `choices[].delta.reasoning_content`
- answer delta: `choices[].delta.content`
- final usage chunk: `choices: []` 且 `usage` 非空

## 4. Normalized Usage Schema

所有 provider usage 先保存 raw，再归一化。不要丢 raw 字段，因为供应商会扩展细节字段。

```ts
interface ModelUsageRecord {
  id: string;
  sessionId: string;
  runId?: string;
  step?: number;
  provider: 'openai' | 'anthropic' | 'qwen' | 'openai-compatible';
  api: 'responses' | 'chat-completions' | 'messages';
  model: string;
  stream: boolean;
  status: 'complete' | 'interrupted' | 'error';
  source: 'provider-final' | 'provider-stream-final' | 'preflight' | 'estimated' | 'missing';
  startedAt: number;
  completedAt?: number;
  providerRequestId?: string;
  providerResponseId?: string;

  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningOutputTokens?: number;
  visibleOutputTokens?: number;

  cachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheCreationInputTokens5m?: number;
  cacheCreationInputTokens1h?: number;

  textInputTokens?: number;
  imageInputTokens?: number;
  videoInputTokens?: number;
  audioInputTokens?: number;
  textOutputTokens?: number;
  audioOutputTokens?: number;

  serverToolUse?: Record<string, unknown>;
  rawUsage?: Record<string, unknown>;
}
```

Rules:

- Unknown 字段用 `undefined`，不要填 `0`。
- `visibleOutputTokens = outputTokens - reasoningOutputTokens` 只在二者都存在时计算。
- `totalTokens` 优先使用 provider 返回值；缺失时再用已知字段推导。
- `rawUsage` 永久保留，方便后续新增字段回填。
- `status = interrupted` 时，若没有最终 usage，记录 `source = missing`，不要用流式文本长度伪装真实 usage。

## 5. Provider Mapping

### 5.1 OpenAI Responses

| Normalized | Raw |
| --- | --- |
| `inputTokens` | `usage.input_tokens` |
| `outputTokens` | `usage.output_tokens` |
| `totalTokens` | `usage.total_tokens` |
| `cachedInputTokens` | `usage.input_tokens_details.cached_tokens` |
| `reasoningOutputTokens` | `usage.output_tokens_details.reasoning_tokens` |

### 5.2 OpenAI Chat / OpenAI-Compatible

| Normalized | Raw |
| --- | --- |
| `inputTokens` | `usage.prompt_tokens` |
| `outputTokens` | `usage.completion_tokens` |
| `totalTokens` | `usage.total_tokens` |
| `cachedInputTokens` | `usage.prompt_tokens_details.cached_tokens` |
| `reasoningOutputTokens` | `usage.completion_tokens_details.reasoning_tokens` |

### 5.3 Anthropic Messages

| Normalized | Raw |
| --- | --- |
| `inputTokens` | `usage.input_tokens` |
| `outputTokens` | `usage.output_tokens` |
| `cacheReadInputTokens` | `usage.cache_read_input_tokens` |
| `cacheCreationInputTokens` | `usage.cache_creation_input_tokens` |
| `cacheCreationInputTokens5m` | `usage.cache_creation.ephemeral_5m_input_tokens` |
| `cacheCreationInputTokens1h` | `usage.cache_creation.ephemeral_1h_input_tokens` |
| `serverToolUse` | `usage.server_tool_use` |

Anthropic cache read/write 是独立计费分类，不要简单塞进 `inputTokens`。聚合 UI 可以额外显示：

```text
input footprint = inputTokens + cacheReadInputTokens + cacheCreationInputTokens
```

但计费估算阶段必须按 provider pricing profile 分开算。

### 5.4 Qwen OpenAI-Compatible

| Normalized | Raw |
| --- | --- |
| `inputTokens` | `usage.prompt_tokens` |
| `outputTokens` | `usage.completion_tokens` |
| `totalTokens` | `usage.total_tokens` |
| `cachedInputTokens` | `usage.prompt_tokens_details.cached_tokens` |
| `reasoningOutputTokens` | `usage.completion_tokens_details.reasoning_tokens` |
| `textInputTokens` | `usage.prompt_tokens_details.text_tokens` |
| `imageInputTokens` | `usage.prompt_tokens_details.image_tokens` |
| `videoInputTokens` | `usage.prompt_tokens_details.video_tokens` |
| `audioInputTokens` | `usage.prompt_tokens_details.audio_tokens` |
| `textOutputTokens` | `usage.completion_tokens_details.text_tokens` |
| `audioOutputTokens` | `usage.completion_tokens_details.audio_tokens` |
| `cacheCreationInputTokens` | `usage.cache_creation_input_tokens` |
| `cacheCreationInputTokens5m` | `usage.cache_creation.ephemeral_5m_input_tokens` |

Qwen 的不同地域和不同 API 形态字段可能略有差异，因此 mapper 需要同时兼容：

- OpenAI-compatible `prompt_tokens` / `completion_tokens`
- DashScope native `input_tokens` / `output_tokens`
- `prompt_tokens_details.cached_tokens`
- `usage.cached_tokens`

## 6. Aggregation

统计粒度：

- Request: 每次 provider API 调用。
- Step: ReAct loop 的单步模型请求。
- Run: 用户一次输入触发的完整 agent run。
- Session: 当前聊天会话累计。
- Global: workspace 或全局累计，后续做。

建议聚合字段：

```ts
interface UsageTotals {
  requestCount: number;
  completedRequestCount: number;
  interruptedRequestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningOutputTokens: number;
  visibleOutputTokens: number;
  cachedInputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}
```

聚合规则：

- 只累加 number 类型字段。
- 缺失字段不按 0 展示为“真实 0”；UI 可显示 `unknown`。
- retries 要按 attempt 记录，因为每次 attempt 都可能产生计费。
- tool loop 中多次模型请求都算入同一个 run。

## 7. UI 展示建议

Composer 按钮旁已有 model/status pill，可以扩展 tooltip，不宜把所有 token 信息塞在一行。

短标签建议：

```text
gpt · gpt-5.5 · effort:low · ctx:42% · run:12.4k
```

Tooltip 建议：

```text
Last request
Input: 3,463
Output: 2,387
Reasoning: 1,024
Cache hit: 1,152

Current run
Requests: 3
Input: 9,210
Output: 4,880
Reasoning: 1,860
Cache read/hit: 4,096
```

Session 面板可后续增加：

- Session total tokens
- Cache hit rate
- Reasoning share
- Provider/model split

## 8. Storage

第一版建议跟 session 存一起，结构简单：

```ts
interface ChatSession {
  usage?: {
    records: ModelUsageRecord[];
    totals: UsageTotals;
  };
}
```

限制：

- `records` 最多保留最近 N 条完整 raw usage，例如 500 条。
- 更老记录只保留 daily/session aggregate，避免 session JSON 膨胀。
- `rawUsage` 只保存 usage 对象，不保存 prompt、response 正文或 API key。

后续如果需要跨 workspace 汇总，再写入：

```text
<workspace>/.kraken-coder/usage/YYYY-MM-DD.jsonl
~/kraken-coder/usage/YYYY-MM-DD.jsonl
```

## 9. Implementation Plan

Current implementation status:

- Model API request/response tracing is enabled in the request layer.
- Each actual HTTP call writes one JSON trace file containing:
  - request URL, method, provider, model, api
  - sanitized request headers
  - full request body
  - response status and headers
  - full response body text
  - parsed response JSON when applicable
  - stream raw SSE body for streaming requests
  - error message when the request fails
- Trace file locations:
  - `~/kraken-coder/debug/model-api/*.json`

### Phase 0: Provider Probe

- 手动或临时脚本请求 OpenAI Responses、OpenAI Chat、Anthropic Messages、Qwen OpenAI-compatible。
- 覆盖 non-stream、stream、thinking、tool call、cache。
- 保存脱敏 raw usage 样本。
- 根据样本修正 mapper。

### Phase 1: Types

- 新增 `ModelUsageRecord`、`UsageTotals`、`ModelResponse.usage`。
- Agent 层的 `ModelResponse.usage` 从 `null` 改为真实 normalized usage。
- `rawUsage` 用 `JsonRecord` 保存。

### Phase 2: Provider Parsers

- OpenAI Responses：解析 response object usage；stream 从 `response.completed` 取 final response usage。
- OpenAI Chat/Qwen：非流式解析 `parsed.usage`；流式设置 `stream_options.include_usage = true` 并捕获最终 chunk usage。
- Anthropic：非流式解析 `parsed.usage`；流式保存最后一个 `message_delta.usage`。

### Phase 3: Runtime Propagation

- `loopQuery` 返回 usage。
- `ReActAgent` 在 `RunStep` 中保存 usage record id 或 usage summary。
- `KrakenViewProvider` 把 usage records 写入 session，并给 webview 发送 totals。

### Phase 4: UI

- Composer model pill 显示 run total。
- Tooltip 展示 last request 和 current run。
- Message/tool/thinking 卡片 metadata 可显示该 step 的 token 使用。

### Phase 5: Pricing

- 单独维护 provider/model pricing profile。
- 按 input/output/reasoning/cache read/cache write 分类计费。
- 不在 usage 基础实现里硬编码价格。

## 10. Edge Cases

- Stream 中断：通常没有 final usage；记录 `source = missing`。
- Provider 返回 null details：保留 raw，normalized 字段 undefined。
- Reasoning tokens 缺失：不从 thinking 文本本地估算真实 reasoning token。
- Cache hit 字段为 0：这是真实 0；字段缺失才是 unknown。
- Retry：每次 provider 请求都要独立记录。
- Error response：如果 provider error 带 usage，记录；否则只记录 request metadata 和 status。
- Preflight token count：可用于 context window 和发送前提示，但不等于真实计费 usage。

## 11. Open Questions

- 是否默认开启 streaming usage collection 对所有 provider 都发送 `stream_options.include_usage`？建议开启。
- 是否把 token 统计写入全局历史？建议第一版只写 session。
- 是否做发送前 token preflight？建议只对 OpenAI Responses 和 Anthropic Messages 做可选项，Qwen 暂不默认。
- 是否显示价格？建议等 usage 稳定后再做。
