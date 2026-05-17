# Model Provider API Technical Design

## 1. 背景与目标

Kraken Coder 后续主要面向 Claude、GPT/OpenAI、Qwen 三类模型。现有模型层只抽象了 OpenAI-compatible Chat Completions，请求固定发往 `/chat/completions`，消息结构也偏向 `messages + tool_calls`。这能覆盖基础对话和工具调用，但无法完整支持三家的推理强度、thinking/reasoning、prompt/block cache、provider 特有 streaming event。

本文调研三家官方 API，并定义后续实现方向。本文只做技术设计，不改运行代码。

目标：

- 支持三家模型的统一配置：provider、model、baseUrl、apiKey、reasoning/effort、cache 策略。
- 支持 GPT 系列的 `reasoning.effort`、Responses API、自动 prompt cache。
- 支持 Claude 的 Messages API、`output_config.effort`、adaptive/manual thinking、显式 `cache_control` block cache。
- 支持 Qwen 的 OpenAI-compatible 接口、`enable_thinking`、`thinking_budget`、`preserve_thinking`、显式/隐式 Context Cache。
- 保留一个 provider-neutral 中间层，避免业务逻辑直接依赖某一家 API 形状。

非目标：

- 不在第一版支持所有第三方 OpenAI-compatible 服务的私有扩展。
- 不把 provider 文档中的所有参数暴露到 UI；只暴露稳定且对 coding agent 有价值的参数。
- 不默认展示完整 reasoning/thinking 内容给用户。UI 可支持折叠的 thinking 区域，但上下文保留和展示策略要分开。

## 2. 当前状态

当前模型客户端集中在 `src/agent/modelClient.ts`：

- 使用 OpenAI-compatible Chat Completions。
- 请求体包含 `model`、`messages`、`tools`、`tool_choice: "auto"`、`temperature`、`stream`。
- streaming 解析 `choices[].delta.content` 与 `choices[].delta.tool_calls`。
- 不解析 usage、reasoning/thinking token、cache hit、provider-specific event。

当前类型集中在 `src/shared/types.ts`：

- `ModelSettings.provider` 只有 `'openai-compatible'`。
- `ModelMessage` 只支持 string content 和 OpenAI Chat tool call。
- 缺少 content block、cache boundary、reasoning item、thinking signature、provider usage 结构。

结论：不能直接在现有 client 里堆参数。需要先引入 provider-neutral request/response，再按 provider adapter 翻译。

## 3. Provider 对比

| 维度 | GPT/OpenAI | Claude/Anthropic | Qwen/Alibaba Model Studio |
| --- | --- | --- | --- |
| 推荐接口 | Responses API；Chat Completions 保留为 fallback | Messages API | OpenAI-compatible Chat Completions 优先；DashScope native 可后续补 |
| 推理强度 | `reasoning.effort`，值随模型变化，可包含 `none/minimal/low/medium/high/xhigh` | `output_config.effort`，值随模型变化，常见 `low/medium/high/xhigh/max` | 无统一 effort；通过 `enable_thinking`、`thinking_budget`、模型 profile 映射 |
| thinking/reasoning 保留 | Responses 返回 reasoning items；工具循环需要保留相关 output items | thinking block 带 signature；工具循环需要原样传回 thinking blocks | `reasoning_content` 可返回；多轮默认不参考，需 `preserve_thinking: true` |
| 缓存方式 | 自动 prefix cache；无 `cache_control` block 标记 | 顶层 automatic caching 或显式 `cache_control` block cache | 显式 `cache_control` 与隐式 cache；二者单请求互斥 |
| 缓存命中指标 | `usage.*.cached_tokens` | `cache_creation_input_tokens`、`cache_read_input_tokens` | OpenAI-compatible 下 `usage.prompt_tokens_details.cached_tokens`、`cache_creation_input_tokens` |
| 工具调用 | Responses 中 tool call/output 是 item，用 `call_id` 关联 | `tool_use` / `tool_result` content blocks | 基本 OpenAI-compatible `tool_calls`，但 streaming 可混入 `reasoning_content` |
| Streaming | Responses semantic events；Chat 是 delta chunks | SSE event + content block delta | OpenAI-compatible delta；DashScope 是 `event: result` |

## 4. GPT/OpenAI API 设计要点

OpenAI 官方建议新项目使用 Responses API，Chat Completions 仍支持，但 Responses 对 agentic workflow、工具、状态、多模态与 reasoning 模型更完整。

后续应拆成两个 adapter：

- `OpenAIResponsesAdapter`：GPT/OpenAI 默认 adapter。
- `OpenAIChatAdapter`：兼容旧模型或第三方 Chat Completions。

### 4.1 Effort

Responses API 使用：

```json
{
  "model": "gpt-5.5",
  "reasoning": { "effort": "medium" },
  "input": []
}
```

官方文档说明 `reasoning.effort` 是“模型思考多少”的调节项，支持值是 model-dependent，可包含 `none`、`minimal`、`low`、`medium`、`high`、`xhigh`。因此实现上不能硬编码成所有 GPT 模型都支持同一组值，必须通过 model profile 校验并降级。

建议映射：

| Kraken effort | OpenAI Responses |
| --- | --- |
| `none` | `reasoning.effort = "none"`，仅在 profile 支持时发送 |
| `minimal` | `reasoning.effort = "minimal"`，仅在 profile 支持时发送 |
| `low` | `reasoning.effort = "low"` |
| `medium` | `reasoning.effort = "medium"` |
| `high` | `reasoning.effort = "high"` |
| `xhigh` | `reasoning.effort = "xhigh"`，仅在 profile 支持时发送 |

如果用户配置了模型不支持的 effort：

1. adapter 先查 model profile。
2. 找到同方向最近的支持值。
3. 在 debug/telemetry 中记录降级原因。
4. UI 可显示一次性 warning，避免静默误导。

### 4.2 Cache

OpenAI Prompt Caching 是自动 prefix cache：

- 无需显式 `cache_control`。
- 1024 tokens 以上的 prompt 才可被缓存。
- exact prefix match 才能命中；静态内容应放前面，动态用户输入放后面。
- 可用 `prompt_cache_key` 改善同类请求路由。
- 可用 `prompt_cache_retention` 控制 retention，具体可用值和模型支持需要 profile 判断。
- 命中情况从 usage 的 `cached_tokens` 读取。

对 Kraken 的含义：

- OpenAI adapter 不应该生成 `cache_control` block。
- Prompt builder 要保证系统提示、工具定义、AGENT.md、skills、workspace summary 的顺序稳定。
- 对不同 workspace/session 生成稳定 `prompt_cache_key`，例如 `workspaceHash + provider + model + toolSchemaVersion`。
- 工具定义 JSON 必须稳定序列化，否则 prefix cache 会被字段顺序打散。

### 4.3 Reasoning Items 与工具循环

Responses API 中，tool call 和 tool output 是独立 items，通过 `call_id` 关联。reasoning 模型做 function calling 时，官方建议把上一轮相关 reasoning items、function call items、function call output items 保留下来，或者用 `previous_response_id`。

Kraken 如果继续手动管理上下文，必须保存 provider 原始 output item 的最小必要形式，不能只保存 assistant 可见文本。否则工具循环中的 reasoning continuity 会下降。

## 5. Claude/Anthropic API 设计要点

Claude 使用 Messages API。它不是 OpenAI Chat 的简单变体，而是 content block 模型：

- assistant 输出由 `text`、`thinking`、`tool_use` 等 blocks 组成。
- 工具结果作为 user message 中的 `tool_result` block 传回。
- thinking block 可能带 `signature`，用于后续验证和 reasoning continuity。

### 5.1 Effort 与 Thinking

Claude 新模型支持 `output_config.effort`。官方文档说明 effort 影响整体 token 花费，包括文本、工具调用和 extended thinking；它是行为信号，不是严格 token budget。

Claude thinking 有两条路径，另有一个跨 thinking/text/tool 的 `effort` 控制：

- Adaptive thinking：`thinking: { "type": "adaptive" }`，配合 `output_config: { "effort": "medium" }`。新模型推荐该方式，部分模型只支持 adaptive。
- Manual extended thinking：`thinking: { "type": "enabled", "budget_tokens": N }`。旧模型使用；在部分新模型上已 deprecated 或不支持。
- Effort：`output_config: { "effort": "medium" }`。它不是严格 token 上限，而是控制 Claude 多愿意花 token；会影响文本、工具调用参数和 extended thinking。

建议 model profile：

```ts
interface ClaudeModelProfile {
  supportsEffort: boolean;
  effortValues: Array<'low' | 'medium' | 'high' | 'xhigh' | 'max'>;
  thinkingMode: 'adaptive' | 'manual' | 'none';
  supportsBudgetTokens: boolean;
  defaultThinkingBudgetTokens?: number;
  maxThinkingBudgetTokens?: number;
  maxTokensDefault: number;
}
```

映射策略：

- 新 Claude：优先 `thinking.type = "adaptive"`，发送 `output_config.effort`。
- 旧 Claude：若用户开启 thinking，使用 `thinking.type = "enabled"` 和 `budget_tokens`。
- `effort = low/medium/high` 可以不一定开启 thinking，因为 Claude effort 本身也能影响普通文本和 tool call 行为。
- 需要最低延迟时，`thinking.display = "omitted"`，但仍保留 signature；展示层不显示 thinking 文本。

### 5.2 budget_tokens

`budget_tokens` 是 Claude manual extended thinking 的参数：

```json
{
  "thinking": {
    "type": "enabled",
    "budget_tokens": 10000
  },
  "max_tokens": 16000
}
```

语义：

- `budget_tokens` 是 Claude 内部 reasoning 可使用的最大 token 数，不是保证会用满的 token 数。
- `max_tokens` 包含 thinking budget 和最终可见输出空间，因此普通 manual thinking 下 `budget_tokens` 必须小于 `max_tokens`。
- 不能和 `max_tokens: 0` 的 cache pre-warming 一起使用。
- 大 budget 可能提升复杂推理和长工具链质量，但会增加延迟和成本；超过 32k 后收益需要通过 eval 验证。
- 对支持 interleaved thinking + tool use 的模型，工具交错场景下 token 约束可能由整个上下文窗口决定；Kraken 不应把这个例外作为通用规则，仍应按 model profile 限制。

模型兼容策略：

| Claude 模型族 | 推荐控制 | Kraken 行为 |
| --- | --- | --- |
| Opus 4.7 / 新 adaptive thinking 模型 | `thinking.type = "adaptive"` + `output_config.effort` | 不发送 `budget_tokens`；用户配置了 budget 时给 warning 并忽略或降级 |
| Opus 4.6 / Sonnet 4.6 | 优先 adaptive thinking + effort；manual budget 已 deprecated | 默认不发送 `budget_tokens`；仅高级配置强制开启时发送，并提示 deprecated |
| Opus 4.5 / 其他 Claude 4 manual thinking 模型 | `thinking.type = "enabled"` + `budget_tokens`，可同时设置 effort | 发送 budget；effort 控制整体行为，budget 控制 thinking 上限 |
| 不支持 extended thinking 的模型 | 无 | 不发送 thinking 配置 |

建议预算档位只作为默认值，最终以 model profile 为准：

| Kraken effort | Manual thinking budget 建议 |
| --- | --- |
| `low` | 4k-8k |
| `medium` | 8k-16k |
| `high` | 16k-32k |
| `xhigh` | 32k-64k |
| `max` | 64k+，只在模型 profile 明确支持且用户显式开启时使用 |

如果 `max_tokens <= budget_tokens`：

1. 优先扩大 `max_tokens` 到 `budget_tokens + visibleOutputReserve`。
2. 如果 provider/model 限制不允许扩大，则降低 `budget_tokens`。
3. 记录降级原因，UI 显示一次性 warning。

### 5.3 Thinking 与工具调用

Claude extended/adaptive thinking 和工具循环有关键约束：

- 使用 thinking 时，工具循环期间要原样保留 thinking blocks。
- 不能随意修改、重排、截断 thinking block 序列。
- 某些 thinking 模式下 `tool_choice` 只能是 `auto` 或 `none`，不能强制指定某个 tool。
- 切换 thinking mode 可能破坏 message-level cache breakpoint。

因此 provider-neutral history 里必须保存：

- assistant visible text
- provider raw thinking block metadata
- tool_use id/name/input
- tool_result content
- block 顺序

### 5.4 Cache

Claude Prompt Caching 支持两种接入方式：

- 顶层 automatic caching：请求体加 `cache_control: { "type": "ephemeral" }`，系统自动选择最后一个可缓存 block 作为缓存边界。
- 显式 block cache：在 content block 上加 `cache_control: { "type": "ephemeral" }` 标记缓存边界。
- prefix 顺序为 `tools` -> `system` -> `messages`。
- 默认 TTL 5 分钟，也支持 1 小时 TTL。
- 最多 4 个 cache breakpoints；automatic caching 会占用其中一个 slot。
- cache 命中要求 exact matching。
- usage 中读取 `cache_creation_input_tokens` 与 `cache_read_input_tokens`。

Kraken cache planner 对 Claude 应做：

- 简单场景优先使用顶层 automatic caching，减少手动移动 breakpoint 的复杂度。
- 对稳定的大块内容使用显式 breakpoint，例如最后一个稳定工具定义、稳定 system/context block 末尾。
- 长 workspace summary、AGENT.md、已选 skill 内容可以作为 system blocks。
- 当前用户消息、最新工具输出、临时诊断不要放进长期 cache block。

## 6. Qwen API 设计要点

Qwen 在阿里云百炼 Model Studio 中支持 OpenAI-compatible Chat Completions，并通过非 OpenAI 标准参数扩展 thinking/cache 能力。Kraken 第一版建议基于 OpenAI-compatible endpoint：

```text
https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
```

DashScope native HTTP/SDK 后续可补，因为它的 streaming event 和响应结构与当前 client 差异更大。

### 6.1 Thinking

Qwen 深度思考分两类：

- 混合思考模型：`enable_thinking: true | false` 控制是否思考。
- 仅思考模型：总是思考，无法关闭。

OpenAI-compatible 调用时：

- Python SDK 通常通过 `extra_body` 传 `enable_thinking`、`thinking_budget`、`preserve_thinking`。
- Node.js SDK/HTTP 可作为顶层参数传入。
- 思考内容在 `reasoning_content` 字段，回复内容在 `content` 字段。
- 流式输出中要同时解析 `delta.reasoning_content` 和 `delta.content`。

`thinking_budget` 用于限制推理过程最大 token 数。它不是统一 effort，所以 Kraken 应把 `effort` 映射为模型 profile 下的预算档位：

| Kraken effort | Qwen mixed-thinking 模型 |
| --- | --- |
| `none` | `enable_thinking: false` |
| `low` | 简单任务默认 `enable_thinking: false`；复杂 coding 可 `true` + 小 budget |
| `medium` | `enable_thinking: true` + profile medium budget |
| `high` | `enable_thinking: true` + profile high budget |
| `xhigh/max` | 只有 profile 明确支持时启用更高 budget，否则降级到 high |

多轮保留：

- Qwen 默认不会参考历史 message 里的 `reasoning_content`。
- 如果要让模型参考之前 thinking，需要 `preserve_thinking: true`。
- 该参数只支持部分模型；开启后历史 `reasoning_content` 会计入输入 token 和计费。

默认建议：

- Kraken 内部保存 `reasoning_content`，但默认不发回给 Qwen。
- 仅在模型 profile 支持且用户开启 `preserveThinking` 时发送。
- 对工具循环可以单独启用，因为 reasoning continuity 对 agentic coding 更有价值。

### 6.2 Cache

Qwen Context Cache 有两种：

- 显式缓存：在 `messages.content` block 中加 `cache_control: { "type": "ephemeral" }`，最少 1024 tokens，有效期 5 分钟，最多 4 个标记。
- 隐式缓存：自动识别公共前缀，最少 256 tokens，命中率不确定，无法关闭。

显式和隐式在单个请求中互斥。只要发送了显式 `cache_control`，该请求就按显式缓存处理。

Qwen 与 Claude 的重要差异：

- Qwen 的 `cache_control` 只能加在 `messages.content` 上。
- `tools` 不支持独立添加缓存标记；Function Calling 场景下，工具定义作为系统消息的一部分参与缓存计算。
- 因此 Qwen adapter 要把稳定 context 放进 `messages` content blocks，不能试图给 tool schema 加 `cache_control`。
- 为提高工具缓存命中率，工具列表顺序、字段顺序、字段结构必须稳定。

usage：

- OpenAI-compatible 下从 `usage.prompt_tokens_details.cached_tokens` 读取命中缓存 token。
- 显式缓存创建 token 可从 `cache_creation_input_tokens` 读取。

### 6.3 工具调用

Qwen Function Calling 基本兼容 OpenAI Chat Completions：

- request 使用 `tools`、`tool_choice`、`parallel_tool_calls` 等。
- response 使用 `tool_calls`。
- streaming 下可能同时出现 `reasoning_content`、`content`、`tool_calls` 增量。

Qwen adapter 必须扩展现有 stream parser：

- 收集 `delta.reasoning_content` 到 reasoning buffer。
- 收集 `delta.content` 到 visible assistant buffer。
- 按 index 拼接 `delta.tool_calls[].function.arguments`。
- 最终 response 同时返回 text、reasoning metadata、tool calls、usage。

## 7. 统一抽象设计

### 7.1 Provider

建议配置中显式区分 provider：

```ts
type ModelProvider =
  | 'openai'
  | 'anthropic'
  | 'qwen'
  | 'openai-compatible';
```

含义：

- `openai`：使用 OpenAI 官方 API，默认 Responses。
- `anthropic`：使用 Claude Messages API。
- `qwen`：使用阿里云百炼 OpenAI-compatible 扩展。
- `openai-compatible`：尽量只发送标准 Chat Completions 字段，不发送 provider 私有参数。

### 7.2 Model Request

中间层需要从 string message 升级为 block message：

```ts
type ModelBlock =
  | { type: 'text'; text: string; cache?: CacheHint }
  | { type: 'tool_use'; id: string; name: string; input: JsonRecord }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean; cache?: CacheHint }
  | { type: 'reasoning'; provider: string; data: JsonRecord; visibility: 'hidden' | 'summary' | 'visible' };

interface CacheHint {
  mode: 'ephemeral';
  ttl?: '5m' | '1h' | '24h';
  boundary?: boolean;
}

interface UnifiedModelRequest {
  provider: ModelProvider;
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    blocks: ModelBlock[];
  }>;
  tools: ModelToolDefinition[];
  reasoning?: {
    effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    enabled?: boolean;
    budgetTokens?: number;
    preserve?: boolean;
    display?: 'hidden' | 'summary' | 'visible';
    maxStoredTokens?: number;
  };
  cache?: {
    strategy: 'auto-prefix' | 'explicit-blocks' | 'implicit' | 'disabled';
    key?: string;
    retention?: 'in_memory' | '5m' | '1h' | '24h';
  };
}
```

### 7.3 Model Response

统一 response 应包含可见输出、工具调用、provider metadata 和 usage：

```ts
interface UnifiedModelResponse {
  text: string;
  toolCalls: ModelToolCall[];
  reasoning?: {
    provider: string;
    blocks: JsonRecord[];
    summaryText?: string;
    visibleText?: string;
  };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  };
  providerRaw?: JsonRecord;
}
```

`providerRaw` 只用于调试、重放和后续迁移，不直接展示给用户。

## 8. Think / Reasoning 生命周期

Kraken 需要把 think/reasoning 当成一等状态管理，而不是把它拼进 assistant 文本。原因是三家语义不同：

- OpenAI：通常不暴露 raw reasoning。可返回 reasoning summary 或 encrypted reasoning item；工具循环需要保留相关 response items。
- Claude：暴露 `thinking` / `redacted_thinking` content blocks，thinking block 可能带 signature，必须在后续工具循环中原样保留。
- Qwen：暴露 `reasoning_content` 文本；默认不会被下一轮参考，只有 `preserve_thinking: true` 时才会参与多轮输入。

### 8.1 内部状态

建议把每轮 assistant 输出拆成三层：

```ts
interface AssistantTurnState {
  visibleText: string;
  toolCalls: ModelToolCall[];
  reasoning: {
    provider: ModelProvider;
    mode: 'none' | 'summary' | 'raw' | 'encrypted' | 'redacted';
    streamText?: string;
    summaryText?: string;
    providerBlocks: JsonRecord[];
    interrupted?: boolean;
    preservedForContext: boolean;
  };
}
```

含义：

- `visibleText`：用户真正看到的 assistant 正文。
- `reasoning.streamText`：可选的 thinking 流式文本，仅 provider 允许且用户开启展示时存在。
- `reasoning.providerBlocks`：用于后续 API 回传的 provider 原始块，例如 OpenAI reasoning item、Claude thinking block、Qwen reasoning_content metadata。
- `preservedForContext`：表示这部分是否会进入下一轮 provider request。

### 8.2 Streaming 展示

UI 推荐策略：

- 默认显示一个折叠的 `Thinking` 区域，只展示状态和耗时，不展示完整内容。
- 若 provider 返回 summary，展示 summary；不要伪造 summary。
- 若 provider 返回 raw thinking 且用户开启 `display = "visible"`，可流式展示，但应有独立样式，不能混入 assistant 正文。
- 若 provider 返回 encrypted/redacted thinking，只显示状态，不显示内容。
- 停止或中断时，已经流出的 visibleText 和允许展示的 thinking summary/raw text 都保留，但标记为 interrupted。

Streaming adapter 必须发出结构化事件：

```ts
type ModelStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string; visibility: 'hidden' | 'summary' | 'visible' }
  | { type: 'reasoning_block'; block: JsonRecord; preserveForContext: boolean }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: 'usage'; usage: UnifiedModelResponse['usage'] };
```

不要让 UI 直接解析 provider SSE。provider adapter 负责把不同事件翻译成上面的统一事件。

### 8.3 上下文保留策略

默认策略：

| Provider | 默认保存 | 默认回传给下一轮 | 说明 |
| --- | --- | --- | --- |
| OpenAI | 保存 response item id / encrypted reasoning / summary metadata | 是，使用 `previous_response_id` 或保留必要 items | 不保存 raw chain-of-thought；优先用 provider 原生连续性 |
| Claude | 保存完整 thinking/redacted_thinking blocks 和 signature | 是，尤其是 tool use 后续轮次 | 不允许改写、重排、截断 thinking blocks |
| Qwen | 保存 `reasoning_content` metadata | 否 | 只有 `preserve_thinking: true` 或工具循环 profile 需要时回传 |
| OpenAI-compatible | 默认不保存 reasoning | 否 | 只有明确识别 provider 字段时才保存 |

成本控制：

- `maxStoredTokens` 限制本地保存的可见 thinking 文本长度。
- provider 必须原样回传的 metadata 不按普通文本截断；如果超过会话预算，应丢弃更早的整轮 reasoning block，而不是截断 block 内部。
- 对 Qwen raw `reasoning_content`，默认只保存摘要或前后截断样本用于调试；只有 `preserve = true` 才保存完整文本用于上下文。

### 8.4 工具循环

工具循环中，think/reasoning 不能丢：

- OpenAI Responses：保留 reasoning items、function call items、function call output items，或使用 `previous_response_id` 让服务端保持状态。
- Claude：assistant message 里的 thinking blocks、tool_use blocks、text blocks 顺序必须原样进入 history；tool_result 作为下一条 user content block 传回。
- Qwen：如果开启 `preserve_thinking`，要把上一轮 assistant 的 `reasoning_content` 放回对应 assistant message；否则只回传 content 和 tool_calls。

失败策略：

- 如果 provider 不接受历史 reasoning block，adapter 应降级为不回传 reasoning，并记录 warning。
- 如果 Claude thinking signature 丢失，不能伪造 signature；应丢弃该 thinking block 或重建一轮请求。
- 如果 OpenAI previous response state 过期，降级为显式 items replay；再失败则降级为普通 messages。

### 8.5 中断与半截输出

用户点击 Stop 时：

- visibleText 已流出的部分作为 assistant message 保留，状态为 `interrupted`。
- reasoning 已流出的部分也保留 metadata，但 `interrupted = true`。
- 对 Claude，不要把半截 thinking block 回传给下一轮；只有完整 block stop 后的 thinking 才能进入 provider history。
- 对 OpenAI，不要构造半截 reasoning item；如果 provider 已返回可引用的 response id 或完整 output item，才保留。
- 对 Qwen，半截 `reasoning_content` 可保存为 UI/debug metadata，但默认不回传。

下一轮继续时，建议在 system/developer context 中加入一条短状态：

```text
Previous assistant turn was interrupted by the user. Continue from the latest user request; do not assume the interrupted reasoning completed.
```

不要把半截 thinking 当成事实依据。

### 8.6 隐私与日志

thinking/reasoning 可能包含敏感内容或 provider 不希望暴露的内部推理。日志策略：

- 默认不写完整 raw thinking 到普通日志。
- debug 日志只记录 token 量、是否存在、provider block 类型、cache/reasoning usage。
- 用户显式开启 `display = "visible"` 时，也不代表可以写入持久日志。
- crash report 中只保留 hash、长度和 provider metadata，不保留 raw text。

## 9. 配置设计

`config.toml` 必须支持用户配置 API 模式、effort、thinking、budget token、cache。Config 页面可以只暴露常用项，但 TOML 要能覆盖三家的高级参数。

### 9.1 配置结构

建议结构：

```toml
[model]
provider = "openai"
model = "gpt-5.5"
base_url = "https://api.openai.com/v1"
api_key_env = "OPENAI_API_KEY"
api_key = ""
api = "responses"

[model.reasoning]
effort = "medium"
enabled = true
display = "hidden"
budget_tokens = 16000
preserve = false
max_stored_tokens = 4096

[model.cache]
enabled = true
strategy = "auto"
retention = "in_memory"

[providers.openai]
api = "responses"
effort = "medium"
prompt_cache_key = "workspace"
prompt_cache_retention = "in_memory"

[providers.anthropic]
api = "messages"
thinking = "adaptive"
effort = "medium"
thinking_budget_tokens = 16000
max_tokens = 32000
preserve_thinking = true
cache_ttl = "5m"

[providers.qwen]
api = "chat-completions"
enable_thinking = true
thinking_budget = 8192
preserve_thinking = false
cache_mode = "explicit"
```

字段说明：

| 字段 | 作用 | Provider 映射 |
| --- | --- | --- |
| `model.api` | 默认 API 模式 | OpenAI: `responses`/`chat-completions`；Anthropic: `messages`；Qwen: `chat-completions` |
| `model.reasoning.effort` | 全局推理强度 | OpenAI `reasoning.effort`；Claude `output_config.effort`；Qwen 映射到 thinking budget 档位 |
| `model.reasoning.enabled` | 是否启用 thinking/reasoning | OpenAI 是否发送 reasoning 配置；Claude 是否发送 thinking；Qwen `enable_thinking` |
| `model.reasoning.budget_tokens` | 全局 thinking token 预算 | Claude manual `budget_tokens`；Qwen `thinking_budget`；OpenAI 不直接支持，忽略并提示 |
| `model.reasoning.preserve` | 是否把 thinking 带入下一轮 | OpenAI/Claude 通常需要保留 provider metadata；Qwen 映射 `preserve_thinking` |
| `model.reasoning.display` | UI 展示策略 | 控制 hidden/summary/visible，不直接等同 provider 参数 |
| `model.cache.strategy` | 缓存策略 | OpenAI auto-prefix；Claude automatic/explicit；Qwen explicit/implicit |

### 9.2 配置优先级

同一项可以出现在全局和 provider section。优先级：

1. 当前 provider section，例如 `[providers.anthropic].effort`。
2. 全局 `[model.reasoning].effort`。
3. model profile 默认值。
4. provider adapter 默认值。

例子：

- `provider = "anthropic"` 时，优先读 `[providers.anthropic].thinking_budget_tokens`。
- 如果没有，则读 `[model.reasoning].budget_tokens`。
- 如果模型不支持 manual thinking，则忽略 budget 并记录 warning。

### 9.3 Provider 参数映射

OpenAI:

| Config | API 参数 |
| --- | --- |
| `api = "responses"` | 使用 `/responses` |
| `effort = "high"` | `reasoning.effort = "high"` |
| `budget_tokens` | 不发送；OpenAI 没有等价字段 |
| `prompt_cache_key` | `prompt_cache_key` |
| `prompt_cache_retention` | `prompt_cache_retention`，按 model profile 校验 |

Claude:

| Config | API 参数 |
| --- | --- |
| `api = "messages"` | 使用 `/v1/messages` |
| `thinking = "adaptive"` | `thinking.type = "adaptive"` |
| `thinking = "enabled"` | `thinking.type = "enabled"` |
| `effort = "medium"` | `output_config.effort = "medium"` |
| `thinking_budget_tokens = 16000` | `thinking.budget_tokens = 16000`，仅 manual thinking |
| `max_tokens = 32000` | `max_tokens = 32000` |
| `cache_ttl = "5m"` | `cache_control.ttl` 或 block cache TTL |

Qwen:

| Config | API 参数 |
| --- | --- |
| `api = "chat-completions"` | `/compatible-mode/v1/chat/completions` |
| `enable_thinking = true` | `enable_thinking: true` |
| `thinking_budget = 8192` | `thinking_budget: 8192` |
| `preserve_thinking = true` | `preserve_thinking: true` |
| `cache_mode = "explicit"` | 在 message content block 写 `cache_control` |

### 9.4 校验与降级

启动或保存配置时必须做静态校验，请求前再做一次 runtime 校验：

- `effort` 不在 model profile 支持列表内：降级到最近可用值。
- `budget_tokens` 配给 OpenAI：忽略并提示“OpenAI 不支持 budget token”。
- Claude adaptive thinking 模型配置了 `thinking_budget_tokens`：忽略或提示改用 `effort`。
- Claude manual thinking 下 `max_tokens <= thinking_budget_tokens`：优先提高 `max_tokens`，否则降低 budget。
- Qwen 非 thinking 模型配置了 `enable_thinking`：忽略并提示。
- Qwen `preserve_thinking = true` 但模型不支持：忽略并提示。
- `display = "visible"` 但 provider 只返回 encrypted/redacted reasoning：降级为 `summary` 或 `hidden`。

错误级别：

- 不可恢复：缺少 api key、base_url 非法、provider 不支持。
- 可降级 warning：unsupported effort、unsupported budget、unsupported preserve thinking。
- 静默默认：用户未配置时使用 profile 默认值。

UI 不需要把所有 provider knobs 展开。推荐 UI 只暴露：

- Provider
- Model
- API Key
- Base URL
- Effort：Low / Medium / High / XHigh
- Thinking：Auto / Off / On
- Budget Tokens：高级折叠项，只在 Claude manual/Qwen thinking 模型可见
- Cache：Auto / Off

高级参数留在 TOML。

Claude 的 `thinking_budget_tokens` 只在 manual extended thinking 模型上生效。对 adaptive thinking 模型，配置存在也不应发送给 API；adapter 需要根据 model profile 忽略并提示。

## 10. Cache Planner

需要单独的 `CachePlanner`，输入 provider、model profile、当前 prompt parts，输出 cache hints。

推荐稳定前缀顺序：

1. 核心 system prompt。
2. 工具定义。
3. 用户项目规则，例如 AGENT.md。
4. 已选择 skill 的说明文档。
5. workspace summary / memory summary。
6. 历史对话摘要。
7. 当前用户输入。
8. 最新工具结果。

不同 provider 输出：

- OpenAI：不加 block 标记；生成 `prompt_cache_key`，可设置 retention。
- Claude：优先顶层 automatic caching；对工具、system/context 等稳定大块内容可额外放显式 `cache_control`。
- Qwen：在 `messages.content` 的稳定 block 上放 `cache_control`；不标记 tools。
- OpenAI-compatible：默认不加 provider-specific cache 参数。

稳定性要求：

- tool schema 需要 deterministic serialization。
- provider adapter 不能因为对象属性顺序随机导致 cache miss。
- skill 和 workspace summary 需要版本 hash，内容变更后自然换 cache prefix。
- 当前用户消息不应插入到稳定前缀中间。

## 11. Adapter 实现计划

第一阶段：类型中间层

- 新增 provider-neutral message block 与 response block。
- 现有 OpenAI-compatible Chat adapter 从中间层翻译，行为保持不变。
- 保存 usage/reasoning/cache metadata，但 UI 暂不强展示。

第二阶段：OpenAI

- 新增 `OpenAIResponsesAdapter`。
- 支持 `reasoning.effort`、semantic streaming events、function call item/output item。
- 保存 reasoning items，工具循环时回传。
- 读取 `cached_tokens`、`reasoning_tokens`。

第三阶段：Claude

- 新增 `AnthropicMessagesAdapter`。
- 支持 content blocks、tool_use/tool_result。
- 支持 `output_config.effort`、adaptive/manual thinking。
- 支持 thinking signature 保留。
- 支持 `cache_control` 与 usage cache metrics。

第四阶段：Qwen

- 新增 `QwenOpenAICompatibleAdapter`。
- 在 request 中发送 `enable_thinking`、`thinking_budget`、`preserve_thinking`。
- streaming parser 支持 `reasoning_content`。
- 支持 Qwen 显式 Context Cache。

第五阶段：配置与 UI

- `config.toml` 扩展 provider sections。
- 解析并合并全局 `[model.reasoning]` 与 `[providers.*]` 的 effort/thinking/budget/cache 配置。
- 请求前按 model capability profile 做二次校验和降级。
- Config 页面按 provider 显示最少必要项。
- 对 unsupported effort/thinking/budget/cache 参数做 UI warning。

## 12. 测试计划

单元测试：

- provider-neutral messages 到 OpenAI Responses request 的 golden snapshot。
- provider-neutral messages 到 Claude Messages request 的 golden snapshot。
- provider-neutral messages 到 Qwen Chat request 的 golden snapshot。
- effort 降级规则。
- 全局/provider 配置优先级。
- Claude/Qwen budget token 映射与不支持时的 warning。
- cache planner 对 OpenAI/Claude/Qwen 的输出。
- deterministic tool schema serialization。

Streaming fixture：

- OpenAI Responses text delta、function call arguments delta。
- OpenAI reasoning summary/encrypted reasoning item 保留。
- Claude content block start/delta/stop、thinking_delta、redacted_thinking、tool_use。
- Qwen `reasoning_content` + `content` + `tool_calls` 混合 delta。

集成测试：

- mock server 验证 abort、中断后的半截 assistant text 保留。
- mock server 验证 tool loop 中 provider metadata 未丢。
- mock server 验证中断时半截 thinking 不回传给 Claude/OpenAI。
- mock server 验证 Qwen `preserve_thinking` 开关影响下一轮请求。
- 可选 live test 手动开启，默认 CI 不跑真实 API。

回归指标：

- 首包延迟。
- 总 token。
- reasoning token。
- cache hit token。
- tool call 成功率。
- adapter 降级次数。

## 13. 风险与决策

关键风险：

- 三家模型能力变化快，不能把当前支持值硬编码为永久事实。
- thinking/reasoning 内容可能很长，直接进上下文会增加成本。
- Claude/Qwen 显式 cache 对 block 顺序敏感，轻微序列化变化会造成 cache miss。
- OpenAI Responses 与 Chat Completions 工具调用形状不同，双栈期间容易丢 tool call metadata。

决策：

- 必须有 model capability profile。
- provider adapter 负责降级，不让业务层判断 provider 细节。
- thinking/reasoning 默认保存为 metadata，不默认展示完整内容。
- cache planner 独立于 prompt builder，方便 provider-specific 调整。
- `openai-compatible` 作为保守 fallback，不发送 Claude/Qwen/OpenAI 私有扩展。

## 14. 官方资料

- OpenAI Responses migration: https://developers.openai.com/api/docs/guides/migrate-to-responses
- OpenAI reasoning models: https://developers.openai.com/api/docs/guides/reasoning
- OpenAI prompt caching: https://developers.openai.com/api/docs/guides/prompt-caching
- OpenAI streaming responses: https://developers.openai.com/api/docs/guides/streaming-responses
- Anthropic Messages API: https://platform.claude.com/docs/en/api/messages
- Anthropic Effort: https://platform.claude.com/docs/en/build-with-claude/effort
- Anthropic Adaptive thinking: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
- Anthropic Extended thinking: https://platform.claude.com/docs/en/build-with-claude/extended-thinking
- Anthropic Prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Qwen deep thinking: https://help.aliyun.com/zh/model-studio/deep-thinking
- Qwen Context Cache: https://help.aliyun.com/zh/model-studio/context-cache
- Qwen Function Calling: https://help.aliyun.com/zh/model-studio/qwen-function-calling
- Qwen API reference: https://help.aliyun.com/zh/model-studio/qwen-api-reference/
