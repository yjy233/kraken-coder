import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';
import * as tls from 'node:tls';
import type {
  JsonRecord,
  ModelMessage,
  ModelReasoningEffort,
  ModelRequest,
  ModelResponse,
  ModelToolDefinition,
  ModelUsageRecord
} from '../shared/types';

interface ChatCompletionsResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
  error?: {
    message?: string;
  };
  usage?: JsonRecord;
}

interface ChatCompletionsStreamChunk {
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
  error?: {
    message?: string;
  };
  usage?: JsonRecord;
}

interface ResponsesResponse {
  output?: Array<{
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    status?: string;
    summary?: Array<{
      type?: string;
      text?: string;
    }>;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  output_text?: string;
  status?: string;
  incomplete_details?: {
    reason?: string;
  };
  error?: {
    message?: string;
  };
  usage?: JsonRecord;
}

interface AnthropicMessageResponse {
  content?: Array<{
    type?: string;
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    input?: JsonRecord;
  }>;
  stop_reason?: string | null;
  error?: {
    message?: string;
  };
  usage?: JsonRecord;
}

interface ToolCallPart {
  id?: string;
  name?: string;
  arguments: string;
}

interface ParsedToolArguments {
  value: JsonRecord;
  error?: string;
}

interface HttpTrace {
  id: string;
  provider: string;
  api: string;
  model: string;
  url: string;
  method: string;
  streamed: boolean;
  sessionId?: string;
  runId?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  request: {
    headers: Record<string, string>;
    body: unknown;
  };
  response?: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    bodyText: string;
    bodyJson?: unknown;
  };
  error?: {
    message: string;
  };
}

interface PostedResponse {
  response: Response;
  trace: HttpTrace;
}

export class OpenAICompatibleModelClient {
  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.settings.provider === 'anthropic') {
      return this.completeAnthropicMessages(request);
    }

    if (request.settings.provider === 'aicodemirror') {
      return this.completeAICodeMirrorResponses(request);
    }

    if (request.settings.provider === 'openai' && resolveOpenAIApi(request) === 'responses') {
      return this.completeOpenAIResponses(request);
    }

    return this.completeChatCompletions(request);
  }

  private async completeChatCompletions(request: ModelRequest): Promise<ModelResponse> {
    const posted = await postJson(
      request,
      '/chat/completions',
      buildBearerHeaders(request.apiKey),
      buildChatCompletionsBody(request)
    );
    const { response, trace } = posted;

    if (request.onDelta && isEventStream(response)) {
      return this.readChatCompletionsStreamingResponse(response, request.onDelta, request.onThinkingDelta, trace, request);
    }

    return this.readChatCompletionsNonStreamingResponse(response, request.onDelta, request.onThinkingDelta, trace, request);
  }

  private async completeOpenAIResponses(request: ModelRequest): Promise<ModelResponse> {
    const posted = await postJson(
      request,
      '/responses',
      buildBearerHeaders(request.apiKey),
      buildOpenAIResponsesBody(request)
    );
    const { response, trace } = posted;

    if (request.onDelta && isEventStream(response)) {
      return this.readOpenAIResponsesStreamingResponse(response, request.onDelta, request.onThinkingDelta, trace, request);
    }

    return this.readOpenAIResponsesNonStreamingResponse(response, request.onDelta, request.onThinkingDelta, trace, request);
  }

  private async completeAICodeMirrorResponses(request: ModelRequest): Promise<ModelResponse> {
    const posted = await postJson(
      request,
      '/responses',
      buildBearerHeaders(request.apiKey),
      buildAICodeMirrorResponsesBody(request)
    );
    const { response, trace } = posted;

    if (request.onDelta && isEventStream(response)) {
      return this.readOpenAIResponsesStreamingResponse(response, request.onDelta, request.onThinkingDelta, trace, request);
    }

    return this.readOpenAIResponsesNonStreamingResponse(response, request.onDelta, request.onThinkingDelta, trace, request);
  }

  private async completeAnthropicMessages(request: ModelRequest): Promise<ModelResponse> {
    const posted = await postJson(
      request,
      '/messages',
      {
        'x-api-key': request.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      buildAnthropicMessagesBody(request)
    );
    const { response, trace } = posted;

    if (request.onDelta && isEventStream(response)) {
      return this.readAnthropicStreamingResponse(response, request.onDelta, request.onThinkingDelta, trace, request);
    }

    return this.readAnthropicNonStreamingResponse(response, request.onDelta, request.onThinkingDelta, trace, request);
  }

  private async readChatCompletionsNonStreamingResponse(
    response: Response,
    onDelta?: (delta: string) => void,
    onThinkingDelta?: (delta: string) => void,
    trace?: HttpTrace,
    request?: ModelRequest
  ): Promise<ModelResponse> {
    const parsed = await parseJsonResponse<ChatCompletionsResponse>(response, trace, request);
    if (!response.ok) {
      throw new Error(parsed.error?.message ?? `Model request failed with HTTP ${response.status}.`);
    }

    const choice = parsed.choices?.[0];
    const message = choice?.message;
    if (!message) {
      throw new Error('Model response did not include an assistant message.');
    }

    const content = message.content ?? '';
    const thinking = message.reasoning_content ?? '';
    if (thinking && onThinkingDelta) {
      onThinkingDelta(thinking);
    }
    if (content && onDelta) {
      onDelta(content);
    }

    const toolCalls = (message.tool_calls ?? [])
      .filter((toolCall) => toolCall.id && toolCall.function?.name)
      .map((toolCall) => {
        const rawArguments = String(toolCall.function?.arguments ?? '{}');
        const parsedArguments = parseToolArguments(toolCall.function?.arguments);
        return {
          id: String(toolCall.id),
          name: String(toolCall.function?.name),
          rawArguments,
          arguments: parsedArguments.value,
          ...(parsedArguments.error ? { argumentsParseError: parsedArguments.error } : {})
        };
      });

    assertHasModelOutput(content, toolCalls.length);

    return {
      content,
      thinking,
      toolCalls,
      finishReason: choice?.finish_reason,
      usage: request ? normalizeModelUsage(request, parsed.usage, 'provider-final') : null
    };
  }

  private async readChatCompletionsStreamingResponse(
    response: Response,
    onDelta: (delta: string) => void,
    onThinkingDelta?: (delta: string) => void,
    trace?: HttpTrace,
    request?: ModelRequest
  ): Promise<ModelResponse> {
    try {
      await assertOkStreamResponse(response, trace, request);

      const body = response.body;
      if (!body) {
        throw new Error('Model provider returned an empty streaming response.');
      }
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      let thinking = '';
      let finishReason: string | undefined;
      let finalUsage: JsonRecord | undefined;
      const toolCallParts = new Map<number, ToolCallPart>();

      const handleData = (data: string) => {
        if (data === '[DONE]') {
          return;
        }

        let parsed: ChatCompletionsStreamChunk;
        try {
          parsed = JSON.parse(data) as ChatCompletionsStreamChunk;
        } catch {
          return;
        }

        if (parsed.error?.message) {
          throw new Error(parsed.error.message);
        }

        if (isRecord(parsed.usage)) {
          finalUsage = parsed.usage;
        }

        const choice = parsed.choices?.[0];
        if (!choice) {
          return;
        }

        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }

        const deltaText = choice.delta?.content ?? '';
        if (deltaText) {
          content += deltaText;
          onDelta(deltaText);
        }

        const thinkingDelta = choice.delta?.reasoning_content ?? '';
        if (thinkingDelta) {
          thinking += thinkingDelta;
          onThinkingDelta?.(thinkingDelta);
        }

        collectStreamingToolCalls(toolCallParts, choice.delta?.tool_calls ?? []);
      };

      buffer = await readServerSentEventStream(reader, decoder, buffer, handleData, trace, request);
      for (const data of parseServerSentEventData(buffer.trim())) {
        handleData(data);
      }

      const toolCalls = toolCallPartsToModelToolCalls(toolCallParts);
      assertHasModelOutput(content, toolCalls.length);

      return {
        content,
        thinking,
        toolCalls,
        finishReason,
        usage: request ? normalizeModelUsage(request, finalUsage, finalUsage ? 'provider-stream-final' : 'missing', finalUsage ? 'complete' : 'interrupted') : null
      };
    } catch (error) {
      if (trace && request) {
        await finalizeTrace(trace, request, {
          message: error instanceof Error ? error.message : String(error)
        });
      }
      throw error;
    }
  }

  private async readOpenAIResponsesNonStreamingResponse(
    response: Response,
    onDelta?: (delta: string) => void,
    onThinkingDelta?: (delta: string) => void,
    trace?: HttpTrace,
    request?: ModelRequest
  ): Promise<ModelResponse> {
    const parsed = await parseJsonResponse<ResponsesResponse>(response, trace, request);
    if (!response.ok) {
      throw new Error(parsed.error?.message ?? `Model request failed with HTTP ${response.status}.`);
    }

    const modelResponse = parseOpenAIResponsesResponse(parsed);
    if (modelResponse.thinking && onThinkingDelta) {
      onThinkingDelta(modelResponse.thinking);
    }
    if (modelResponse.content && onDelta) {
      onDelta(modelResponse.content);
    }
    return {
      ...modelResponse,
      usage: request ? normalizeModelUsage(request, parsed.usage, 'provider-final') : null
    };
  }

  private async readOpenAIResponsesStreamingResponse(
    response: Response,
    onDelta: (delta: string) => void,
    onThinkingDelta?: (delta: string) => void,
    trace?: HttpTrace,
    request?: ModelRequest
  ): Promise<ModelResponse> {
    try {
      await assertOkStreamResponse(response, trace, request);

      const body = response.body;
      if (!body) {
        throw new Error('Model provider returned an empty streaming response.');
      }
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      let thinking = '';
      let finalResponse: ResponsesResponse | undefined;
      let finalUsage: JsonRecord | undefined;
      const toolCallParts = new Map<number, ToolCallPart>();

      const handleData = (data: string) => {
        if (data === '[DONE]') {
          return;
        }

        let event: JsonRecord;
        try {
          event = JSON.parse(data) as JsonRecord;
        } catch {
          return;
        }

        const error = asRecord(event.error);
        if (typeof error?.message === 'string') {
          throw new Error(error.message);
        }

        const type = typeof event.type === 'string' ? event.type : '';
        if (isRecord(event.usage)) {
          finalUsage = event.usage;
        }
        if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
          content += event.delta;
          onDelta(event.delta);
          return;
        }

        if (isOpenAIThinkingDeltaEvent(type) && typeof event.delta === 'string') {
          thinking += event.delta;
          onThinkingDelta?.(event.delta);
          return;
        }

        if (type === 'response.function_call_arguments.delta') {
          const index = numberFromUnknown(event.output_index) ?? 0;
          const existing = toolCallParts.get(index) ?? { arguments: '' };
          if (typeof event.delta === 'string') {
            existing.arguments += event.delta;
          }
          toolCallParts.set(index, existing);
          return;
        }

        if (type === 'response.output_item.added' || type === 'response.output_item.done') {
          const item = asRecord(event.item);
          if (item?.type === 'function_call') {
            const index = numberFromUnknown(event.output_index) ?? toolCallParts.size;
            const existing = toolCallParts.get(index) ?? { arguments: '' };
            if (typeof item.call_id === 'string') {
              existing.id = item.call_id;
            } else if (typeof item.id === 'string') {
              existing.id = item.id;
            }
            if (typeof item.name === 'string') {
              existing.name = item.name;
            }
            if (typeof item.arguments === 'string') {
              existing.arguments = item.arguments;
            }
            toolCallParts.set(index, existing);
          }
          return;
        }

        if (type === 'response.completed') {
          const responseValue = asRecord(event.response);
          if (responseValue) {
            finalResponse = responseValue as ResponsesResponse;
          }
        }
      };

      buffer = await readServerSentEventStream(reader, decoder, buffer, handleData, trace, request);
      for (const data of parseServerSentEventData(buffer.trim())) {
        handleData(data);
      }

      const parsedFinal = finalResponse ? parseOpenAIResponsesResponse(finalResponse) : undefined;
      const toolCalls = parsedFinal?.toolCalls.length ? parsedFinal.toolCalls : toolCallPartsToModelToolCalls(toolCallParts);
      const responseContent = parsedFinal?.content || content;
      const responseThinking = parsedFinal?.thinking || thinking;
      assertHasModelOutput(responseContent, toolCalls.length);

      return {
        content: responseContent,
        thinking: responseThinking,
        toolCalls,
        finishReason: parsedFinal?.finishReason ?? finalResponse?.status,
        usage: request ? normalizeModelUsage(request, finalResponse?.usage ?? finalUsage, finalResponse?.usage || finalUsage ? 'provider-stream-final' : 'missing', finalResponse?.usage || finalUsage ? 'complete' : 'interrupted') : null
      };
    } catch (error) {
      if (trace && request) {
        await finalizeTrace(trace, request, {
          message: error instanceof Error ? error.message : String(error)
        });
      }
      throw error;
    }
  }

  private async readAnthropicNonStreamingResponse(
    response: Response,
    onDelta?: (delta: string) => void,
    onThinkingDelta?: (delta: string) => void,
    trace?: HttpTrace,
    request?: ModelRequest
  ): Promise<ModelResponse> {
    const parsed = await parseJsonResponse<AnthropicMessageResponse>(response, trace, request);
    if (!response.ok) {
      throw new Error(parsed.error?.message ?? `Model request failed with HTTP ${response.status}.`);
    }

    const modelResponse = parseAnthropicMessageResponse(parsed);
    if (modelResponse.thinking && onThinkingDelta) {
      onThinkingDelta(modelResponse.thinking);
    }
    if (modelResponse.content && onDelta) {
      onDelta(modelResponse.content);
    }
    return {
      ...modelResponse,
      usage: request ? normalizeModelUsage(request, parsed.usage, 'provider-final') : null
    };
  }

  private async readAnthropicStreamingResponse(
    response: Response,
    onDelta: (delta: string) => void,
    onThinkingDelta?: (delta: string) => void,
    trace?: HttpTrace,
    request?: ModelRequest
  ): Promise<ModelResponse> {
    try {
      await assertOkStreamResponse(response, trace, request);

      const body = response.body;
      if (!body) {
        throw new Error('Model provider returned an empty streaming response.');
      }
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      let thinking = '';
      let finishReason: string | undefined;
      let finalUsage: JsonRecord | undefined;
      const toolCallParts = new Map<number, ToolCallPart>();

      const handleData = (data: string) => {
        let event: JsonRecord;
        try {
          event = JSON.parse(data) as JsonRecord;
        } catch {
          return;
        }

        const error = asRecord(event.error);
        if (typeof error?.message === 'string') {
          throw new Error(error.message);
        }

        const type = typeof event.type === 'string' ? event.type : '';
        if (type === 'content_block_start') {
          const index = numberFromUnknown(event.index) ?? 0;
          const block = asRecord(event.content_block);
          if (block?.type === 'tool_use') {
            toolCallParts.set(index, {
              id: typeof block.id === 'string' ? block.id : undefined,
              name: typeof block.name === 'string' ? block.name : undefined,
              arguments: ''
            });
          }
          return;
        }

        if (type === 'content_block_delta') {
          const delta = asRecord(event.delta);
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            content += delta.text;
            onDelta(delta.text);
            return;
          }
          if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            thinking += delta.thinking;
            onThinkingDelta?.(delta.thinking);
            return;
          }
          if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            const index = numberFromUnknown(event.index) ?? 0;
            const existing = toolCallParts.get(index) ?? { arguments: '' };
            existing.arguments += delta.partial_json;
            toolCallParts.set(index, existing);
          }
          return;
        }

        if (type === 'message_delta') {
          const delta = asRecord(event.delta);
          if (typeof delta?.stop_reason === 'string') {
            finishReason = delta.stop_reason;
          }
          if (isRecord(event.usage)) {
            finalUsage = event.usage;
          }
        }
      };

      buffer = await readServerSentEventStream(reader, decoder, buffer, handleData, trace, request);
      for (const data of parseServerSentEventData(buffer.trim())) {
        handleData(data);
      }

      const toolCalls = toolCallPartsToModelToolCalls(toolCallParts);
      assertHasModelOutput(content, toolCalls.length);

      return {
        content,
        thinking,
        toolCalls,
        finishReason,
        usage: request ? normalizeModelUsage(request, finalUsage, finalUsage ? 'provider-stream-final' : 'missing', finalUsage ? 'complete' : 'interrupted') : null
      };
    } catch (error) {
      if (trace && request) {
        await finalizeTrace(trace, request, {
          message: error instanceof Error ? error.message : String(error)
        });
      }
      throw error;
    }
  }
}

function buildChatCompletionsBody(request: ModelRequest): JsonRecord {
  const provider = request.settings.provider;
  const body: JsonRecord = {
      model: request.settings.model,
    messages: provider === 'qwen' ? addQwenCacheControl(request.messages, request) : request.messages,
      tools: request.tools?.length ? request.tools : undefined,
      tool_choice: request.tools?.length ? 'auto' : undefined,
      temperature: 0.2,
      stream: Boolean(request.onDelta)
  };

  if (request.onDelta) {
    body.stream_options = { include_usage: true };
  }

  if (request.maxOutputTokens) {
    body[provider === 'openai' ? 'max_completion_tokens' : 'max_tokens'] = request.maxOutputTokens;
  }

  if (provider === 'openai') {
    const effort = normalizeOpenAIReasoningEffort(resolveOpenAIEffort(request));
    if (request.settings.reasoning.enabled && effort) {
      body.reasoning_effort = effort;
    }
    addOpenAICacheParams(body, request);
  }

  if (provider === 'qwen') {
    const thinkingEnabled = isQwenThinkingEnabled(request);
    body.enable_thinking = thinkingEnabled;
    if (thinkingEnabled) {
      const budget = resolveQwenThinkingBudget(request);
      if (budget > 0) {
        body.thinking_budget = budget;
      }
      if (request.settings.providers.qwen.preserveThinking || request.settings.reasoning.preserve) {
        body.preserve_thinking = true;
      }
    }
  }

  if (provider === 'openrouter') {
    addOpenRouterReasoningParams(body, request);
  }

  return body;
}

function buildOpenAIResponsesBody(request: ModelRequest): JsonRecord {
  const body: JsonRecord = {
    model: request.settings.model,
    input: convertMessagesToResponsesInput(request.messages),
    tools: request.tools?.length ? convertToolsToResponsesTools(request.tools) : undefined,
    tool_choice: request.tools?.length ? 'auto' : undefined,
    stream: Boolean(request.onDelta),
    max_output_tokens: request.maxOutputTokens
  };

  const effort = normalizeOpenAIReasoningEffort(resolveOpenAIEffort(request));
  if (request.settings.reasoning.enabled && effort) {
    const reasoning: JsonRecord = { effort };
    if (request.settings.reasoning.display === 'summary' || request.settings.reasoning.display === 'visible') {
      reasoning.summary = 'auto';
    }
    body.reasoning = reasoning;
  }
  addOpenAICacheParams(body, request);

  return body;
}

function buildAICodeMirrorResponsesBody(request: ModelRequest): JsonRecord {
  return {
    model: request.settings.model,
    input: convertMessagesToResponsesInput(request.messages),
    tools: request.tools?.length ? convertToolsToResponsesTools(request.tools) : undefined,
    tool_choice: request.tools?.length ? 'auto' : undefined,
    stream: Boolean(request.onDelta),
    ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
  };
}

function buildAnthropicMessagesBody(request: ModelRequest): JsonRecord {
  const converted = convertMessagesToAnthropic(request.messages, request);
  const thinking = buildAnthropicThinking(request);
  const thinkingBudget = thinking?.type === 'enabled' ? numberFromUnknown(thinking.budget_tokens) ?? 0 : 0;
  const configuredMaxTokens = request.settings.providers.anthropic.maxTokens;
  const maxTokens = Math.max(request.maxOutputTokens ?? 0, configuredMaxTokens, thinkingBudget + 1024, 1);

  const body: JsonRecord = {
    model: request.settings.model,
    max_tokens: maxTokens,
    system: converted.system,
    messages: converted.messages,
    tools: request.tools?.length ? convertToolsToAnthropicTools(request.tools) : undefined,
    tool_choice: request.tools?.length ? { type: 'auto' } : undefined,
    stream: Boolean(request.onDelta)
  };

  const effort = normalizeAnthropicEffort(request.settings.providers.anthropic.effort || request.settings.reasoning.effort);
  if (effort) {
    body.output_config = { effort };
  }
  if (thinking) {
    body.thinking = thinking;
  }
  if (isCacheEnabled(request)) {
    body.cache_control = { type: 'ephemeral', ttl: normalizeAnthropicCacheTtl(request.settings.providers.anthropic.cacheTtl) };
  }

  return body;
}

function parseServerSentEventData(event: string): string[] {
  return event
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
}

function isEventStream(response: Response): boolean {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  return contentType.includes('text/event-stream');
}

function extractErrorMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    const record = asRecord(parsed);
    const error = asRecord(record?.error);
    return typeof error?.message === 'string' ? error.message : undefined;
  } catch {
    return undefined;
  }
}

function isOpenAIThinkingDeltaEvent(type: string): boolean {
  return type === 'response.reasoning_summary_text.delta'
    || type === 'response.reasoning_text.delta';
}

function parseOpenAIResponsesResponse(parsed: ResponsesResponse): ModelResponse {
  const content = parsed.output_text || (parsed.output ?? [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === 'output_text' || item.type === 'text')
    .map((item) => item.text ?? '')
    .join('');
  const thinking = (parsed.output ?? [])
    .filter((item) => item.type === 'reasoning')
    .flatMap((item) => item.summary ?? [])
    .filter((item) => item.type === 'summary_text' || item.type === 'text')
    .map((item) => item.text ?? '')
    .join('');

  const toolCalls = (parsed.output ?? [])
    .filter((item) => item.type === 'function_call' && item.name)
    .map((item) => {
      const rawArguments = String(item.arguments ?? '{}');
      const parsedArguments = parseToolArguments(item.arguments);
      return {
        id: String(item.call_id ?? item.id ?? ''),
        name: String(item.name),
        rawArguments,
        arguments: parsedArguments.value,
        ...(parsedArguments.error ? { argumentsParseError: parsedArguments.error } : {})
      };
    })
    .filter((toolCall) => toolCall.id && toolCall.name);

  assertHasModelOutput(content, toolCalls.length);

  return {
    content,
    thinking,
    toolCalls,
    finishReason: parsed.incomplete_details?.reason ?? parsed.status,
    usage: null
  };
}

function parseAnthropicMessageResponse(parsed: AnthropicMessageResponse): ModelResponse {
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls = [];

  for (const block of parsed.content ?? []) {
    if (block.type === 'text' && block.text) {
      textParts.push(block.text);
      continue;
    }
    if (block.type === 'thinking' && block.thinking) {
      thinkingParts.push(block.thinking);
      continue;
    }
    if (block.type === 'tool_use' && block.id && block.name) {
      toolCalls.push({
        id: block.id,
        name: block.name,
        rawArguments: JSON.stringify(block.input ?? {}),
        arguments: block.input ?? {}
      });
    }
  }

  const content = textParts.join('');
  assertHasModelOutput(content, toolCalls.length);

  return {
    content,
    thinking: thinkingParts.join(''),
    toolCalls,
    finishReason: parsed.stop_reason ?? undefined,
    usage: null
  };
}

function normalizeModelUsage(
  request: ModelRequest,
  rawUsage: JsonRecord | undefined,
  source: ModelUsageRecord['source'],
  status: ModelUsageRecord['status'] = 'complete'
): ModelUsageRecord | null {
  if (!rawUsage) {
    return status === 'complete' ? null : {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      sessionId: request.debug?.sessionId,
      runId: request.debug?.runId,
      step: request.step,
      provider: request.settings.provider,
      api: request.settings.api,
      model: request.settings.model,
      stream: Boolean(request.onDelta),
      status,
      source,
      startedAt: Date.now(),
      completedAt: Date.now(),
    };
  }

  const inputTokens = pickFirstNumber(
    rawUsage.input_tokens,
    rawUsage.prompt_tokens
  );
  const outputTokens = pickFirstNumber(
    rawUsage.output_tokens,
    rawUsage.completion_tokens
  );
  const totalTokens = pickFirstNumber(
    rawUsage.total_tokens,
    sumDefined(inputTokens, outputTokens)
  );
  const inputDetails = asRecord(rawUsage.input_tokens_details) ?? asRecord(rawUsage.prompt_tokens_details);
  const outputDetails = asRecord(rawUsage.output_tokens_details) ?? asRecord(rawUsage.completion_tokens_details);
  const cacheCreation = asRecord(rawUsage.cache_creation);
  const reasoningOutputTokens = pickFirstNumber(outputDetails?.reasoning_tokens);
  const visibleOutputTokens = typeof outputTokens === 'number' && typeof reasoningOutputTokens === 'number'
    ? Math.max(0, outputTokens - reasoningOutputTokens)
    : undefined;

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    sessionId: request.debug?.sessionId,
    runId: request.debug?.runId,
    step: request.step,
    provider: request.settings.provider,
    api: request.settings.api,
    model: request.settings.model,
    stream: Boolean(request.onDelta),
    status,
    source,
    startedAt: Date.now(),
    completedAt: Date.now(),
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningOutputTokens,
    visibleOutputTokens,
    cachedInputTokens: pickFirstNumber(inputDetails?.cached_tokens, rawUsage.cached_tokens),
    cacheReadInputTokens: pickFirstNumber(rawUsage.cache_read_input_tokens),
    cacheCreationInputTokens: pickFirstNumber(rawUsage.cache_creation_input_tokens),
    cacheCreationInputTokens5m: pickFirstNumber(cacheCreation?.ephemeral_5m_input_tokens, rawUsage.ephemeral_5m_input_tokens),
    cacheCreationInputTokens1h: pickFirstNumber(cacheCreation?.ephemeral_1h_input_tokens, rawUsage.ephemeral_1h_input_tokens),
    textInputTokens: pickFirstNumber(inputDetails?.text_tokens),
    imageInputTokens: pickFirstNumber(inputDetails?.image_tokens),
    videoInputTokens: pickFirstNumber(inputDetails?.video_tokens),
    audioInputTokens: pickFirstNumber(inputDetails?.audio_tokens),
    textOutputTokens: pickFirstNumber(outputDetails?.text_tokens),
    audioOutputTokens: pickFirstNumber(outputDetails?.audio_tokens),
    serverToolUse: asRecord(rawUsage.server_tool_use),
    rawUsage,
  };
}

function pickFirstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function sumDefined(...values: Array<number | undefined>): number | undefined {
  let sum = 0;
  let found = false;
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      sum += value;
      found = true;
    }
  }
  return found ? sum : undefined;
}

function convertMessagesToResponsesInput(messages: ModelMessage[]): JsonRecord[] {
  const input: JsonRecord[] = [];
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'user') {
      input.push({
        type: 'message',
        role: message.role,
        content: message.content
      });
      continue;
    }

    if (message.role === 'assistant') {
      if (message.content) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: message.content
        });
      }
      for (const toolCall of message.tool_calls ?? []) {
        input.push({
          type: 'function_call',
          call_id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
          status: 'completed'
        });
      }
      continue;
    }

    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: message.content
      });
    }
  }
  return input;
}

function convertMessagesToAnthropic(
  messages: ModelMessage[],
  request: ModelRequest
): { system: string | JsonRecord[] | undefined; messages: JsonRecord[] } {
  let systemText = '';
  const converted: JsonRecord[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      systemText = systemText ? `${systemText}\n\n${message.content}` : message.content;
      continue;
    }

    if (message.role === 'user') {
      converted.push({
        role: 'user',
        content: message.content
      });
      continue;
    }

    if (message.role === 'assistant') {
      const content: JsonRecord[] = [];
      if (message.content) {
        content.push({ type: 'text', text: message.content });
      }
      for (const toolCall of message.tool_calls ?? []) {
        const parsedArguments = parseToolArguments(toolCall.function.arguments);
        content.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.function.name,
          input: parsedArguments.value
        });
      }
      if (content.length) {
        converted.push({ role: 'assistant', content });
      }
      continue;
    }

    if (message.role === 'tool') {
      converted.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: message.tool_call_id,
          content: message.content,
          is_error: message.content.startsWith('Error:')
        }]
      });
    }
  }

  return {
    system: buildAnthropicSystem(systemText, request),
    messages: dropLeadingNonUserMessages(converted)
  };
}

function dropLeadingNonUserMessages(messages: JsonRecord[]): JsonRecord[] {
  const firstUserIndex = messages.findIndex((message) => message.role === 'user');
  return firstUserIndex > 0 ? messages.slice(firstUserIndex) : messages;
}

function buildAnthropicSystem(systemText: string, request: ModelRequest): string | JsonRecord[] | undefined {
  if (!systemText) {
    return undefined;
  }

  if (!isCacheEnabled(request)) {
    return systemText;
  }

  return [{
    type: 'text',
    text: systemText,
    cache_control: { type: 'ephemeral', ttl: normalizeAnthropicCacheTtl(request.settings.providers.anthropic.cacheTtl) }
  }];
}

function convertToolsToResponsesTools(tools: ModelToolDefinition[]): JsonRecord[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters
  }));
}

function convertToolsToAnthropicTools(tools: ModelToolDefinition[]): JsonRecord[] {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters
  }));
}

function addQwenCacheControl(messages: ModelMessage[], request: ModelRequest): JsonRecord[] {
  if (!isCacheEnabled(request)) {
    return messages as unknown as JsonRecord[];
  }

  let cacheApplied = false;
  return messages.map((message) => {
    if (!cacheApplied && message.role === 'system' && typeof message.content === 'string') {
      cacheApplied = true;
      return {
        ...message,
        content: [{
          type: 'text',
          text: message.content,
          cache_control: { type: 'ephemeral' }
        }]
      };
    }
    return message as unknown as JsonRecord;
  });
}

function buildAnthropicThinking(request: ModelRequest): JsonRecord | undefined {
  const config = request.settings.providers.anthropic;
  if (!request.settings.reasoning.enabled || config.thinking === 'disabled' || request.settings.reasoning.effort === 'none') {
    return undefined;
  }

  if (config.thinking === 'enabled') {
    const budget = Math.max(0, Math.floor(config.thinkingBudgetTokens || request.settings.reasoning.budgetTokens));
    return budget > 0 ? { type: 'enabled', budget_tokens: budget } : { type: 'enabled' };
  }

  return { type: 'adaptive' };
}

function addOpenRouterReasoningParams(body: JsonRecord, request: ModelRequest): void {
  if (!request.settings.reasoning.enabled || request.settings.reasoning.effort === 'none') {
    return;
  }

  const effort = normalizeOpenRouterReasoningEffort(request.settings.reasoning.effort);
  if (!effort) {
    return;
  }

  body.reasoning = {
    effort,
    exclude: request.settings.reasoning.display === 'hidden'
  };
}

function addOpenAICacheParams(body: JsonRecord, request: ModelRequest): void {
  if (!isCacheEnabled(request)) {
    return;
  }

  const key = request.settings.providers.openai.promptCacheKey.trim();
  if (key) {
    body.prompt_cache_key = key;
  }

  const retention = normalizeOpenAICacheRetention(request.settings.providers.openai.promptCacheRetention);
  if (retention) {
    body.prompt_cache_retention = retention;
  }
}

function isCacheEnabled(request: ModelRequest): boolean {
  return request.settings.cache.enabled && request.settings.cache.strategy !== 'disabled';
}

function resolveOpenAIApi(request: ModelRequest): 'responses' | 'chat-completions' {
  return request.settings.providers.openai.api || (request.settings.api === 'responses' ? 'responses' : 'chat-completions');
}

function resolveOpenAIEffort(request: ModelRequest): ModelReasoningEffort {
  return request.settings.providers.openai.effort || request.settings.reasoning.effort;
}

function normalizeOpenRouterReasoningEffort(effort: ModelReasoningEffort): string | undefined {
  if (effort === 'minimal') {
    return 'low';
  }
  if (effort === 'max') {
    return 'high';
  }
  if (effort === 'low' || effort === 'medium' || effort === 'high') {
    return effort;
  }
  return undefined;
}

function normalizeOpenAIReasoningEffort(effort: ModelReasoningEffort): string | undefined {
  if (effort === 'max') {
    return 'xhigh';
  }
  return effort;
}

function normalizeAnthropicEffort(effort: ModelReasoningEffort): string | undefined {
  if (effort === 'none') {
    return undefined;
  }
  if (effort === 'minimal') {
    return 'low';
  }
  return effort;
}

function normalizeOpenAICacheRetention(value: string): string | undefined {
  const normalized = value.trim().toLowerCase().replace('_', '-');
  if (normalized === 'in-memory' || normalized === '24h') {
    return normalized;
  }
  return undefined;
}

function normalizeAnthropicCacheTtl(value: string): string {
  return value.trim().toLowerCase() === '1h' ? '1h' : '5m';
}

function isQwenThinkingEnabled(request: ModelRequest): boolean {
  if (!request.settings.reasoning.enabled || request.settings.reasoning.effort === 'none') {
    return false;
  }
  return request.settings.providers.qwen.enableThinking;
}

function resolveQwenThinkingBudget(request: ModelRequest): number {
  const configured = request.settings.providers.qwen.thinkingBudget || request.settings.reasoning.budgetTokens;
  if (configured > 0) {
    return Math.floor(configured);
  }

  switch (request.settings.reasoning.effort) {
    case 'minimal':
    case 'low':
      return 4096;
    case 'high':
      return 16384;
    case 'xhigh':
    case 'max':
      return 32768;
    case 'medium':
    default:
      return 8192;
  }
}

function buildBearerHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };
}

async function postJson(
  request: ModelRequest,
  path: string,
  headers: Record<string, string>,
  body: JsonRecord
): Promise<PostedResponse> {
  const url = joinUrl(request.settings.baseUrl, path);
  const requestBody = JSON.stringify(body);
  const trace = createHttpTrace(request, url, 'POST', headers, body);
  try {
    const response = request.settings.proxy
      ? await requestViaProxy(url, {
          method: 'POST',
          headers,
          body: requestBody,
          signal: request.signal,
          proxy: request.settings.proxy
        })
      : await fetch(url, {
          method: 'POST',
          headers,
          body: requestBody,
          signal: request.signal
        });
    populateResponseMetadata(trace, response);
    return { response, trace };
  } catch (error) {
    await finalizeTrace(trace, request, {
      message: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function createHttpTrace(
  request: ModelRequest,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: JsonRecord
): HttpTrace {
  const startedAt = new Date();
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    provider: request.settings.provider,
    api: request.settings.api,
    model: request.settings.model,
    url,
    method,
    streamed: Boolean(request.onDelta),
    sessionId: request.debug?.sessionId,
    runId: request.debug?.runId,
    startedAt: startedAt.toISOString(),
    request: {
      headers: sanitizeHeaders(headers),
      body,
    },
  };
}

function populateResponseMetadata(trace: HttpTrace, response: Response): void {
  trace.response = {
    status: response.status,
    statusText: response.statusText,
    headers: headersToObject(response.headers),
    bodyText: '',
  };
}

async function finalizeTrace(
  trace: HttpTrace,
  request: ModelRequest,
  error?: { message: string },
  bodyText?: string,
  bodyJson?: unknown
): Promise<void> {
  trace.completedAt = new Date().toISOString();
  trace.durationMs = new Date(trace.completedAt).getTime() - new Date(trace.startedAt).getTime();
  if (trace.response) {
    trace.response.bodyText = bodyText ?? trace.response.bodyText;
    if (bodyJson !== undefined) {
      trace.response.bodyJson = bodyJson;
    }
  }
  if (error) {
    trace.error = error;
  }
  await writeHttpTrace(request, trace);
}

async function writeHttpTrace(request: ModelRequest, trace: HttpTrace): Promise<void> {
  const dir = request.debug?.logDir;
  if (!dir) {
    return;
  }
  await fs.mkdir(dir, { recursive: true });
  const fileName = `${trace.id}.json`;
  await fs.writeFile(path.join(dir, fileName), JSON.stringify(trace, null, 2), 'utf8');
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = /authorization|x-api-key/i.test(key) ? redactSecret(value) : value;
  }
  return result;
}

function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function redactSecret(value: string): string {
  if (!value) {
    return value;
  }
  if (value.startsWith('Bearer ')) {
    return 'Bearer ***REDACTED***';
  }
  return '***REDACTED***';
}

async function parseJsonResponse<T>(response: Response, trace?: HttpTrace, request?: ModelRequest): Promise<T> {
  const body = await response.text();
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body) as T;
  } catch {
    if (trace && request) {
      await finalizeTrace(trace, request, undefined, body);
    }
    throw new Error(`Model provider returned non-JSON response (${response.status}).`);
  }
  if (trace && request) {
    await finalizeTrace(
      trace,
      request,
      response.ok ? undefined : {
        message: extractErrorMessage(body) ?? `Model request failed with HTTP ${response.status}.`
      },
      body,
      parsedJson
    );
  }
  return parsedJson as T;
}

async function assertOkStreamResponse(response: Response, trace?: HttpTrace, request?: ModelRequest): Promise<void> {
  if (!response.ok) {
    const body = await response.text();
    if (trace && request) {
      await finalizeTrace(trace, request, {
        message: extractErrorMessage(body) ?? `Model request failed with HTTP ${response.status}.`
      }, body);
    }
    throw new Error(extractErrorMessage(body) ?? `Model request failed with HTTP ${response.status}.`);
  }
  if (!response.body) {
    if (trace && request) {
      await finalizeTrace(trace, request, {
        message: 'Model provider returned an empty streaming response.'
      });
    }
    throw new Error('Model provider returned an empty streaming response.');
  }
}

async function readServerSentEventStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  buffer: string,
  onData: (data: string) => void,
  trace?: HttpTrace,
  request?: ModelRequest
): Promise<string> {
  let currentBuffer = buffer;
  let rawBody = '';
  const appendChunk = (text: string) => {
    if (!text) {
      return;
    }
    rawBody += text;
    if (trace?.response) {
      trace.response.bodyText += text;
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    const chunk = decoder.decode(value, { stream: true });
    appendChunk(chunk);
    currentBuffer += chunk;
    const events = currentBuffer.split(/\r?\n\r?\n/);
    currentBuffer = events.pop() ?? '';

    for (const event of events) {
      for (const data of parseServerSentEventData(event)) {
        onData(data);
      }
    }
  }
  appendChunk(decoder.decode());
  if (trace && request) {
    await finalizeTrace(trace, request, undefined, rawBody);
  }
  return currentBuffer;
}

function collectStreamingToolCalls(
  toolCallParts: Map<number, ToolCallPart>,
  toolCalls: Array<{
    index?: number;
    id?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }>
): void {
  for (const toolCall of toolCalls) {
    const index = toolCall.index ?? 0;
    const existing = toolCallParts.get(index) ?? { arguments: '' };
    if (toolCall.id) {
      existing.id = toolCall.id;
    }
    if (toolCall.function?.name) {
      existing.name = `${existing.name ?? ''}${toolCall.function.name}`;
    }
    if (toolCall.function?.arguments) {
      existing.arguments += toolCall.function.arguments;
    }
    toolCallParts.set(index, existing);
  }
}

function toolCallPartsToModelToolCalls(toolCallParts: Map<number, ToolCallPart>): ModelResponse['toolCalls'] {
  return Array.from(toolCallParts.entries())
    .sort(([left], [right]) => left - right)
    .filter(([, toolCall]) => toolCall.id && toolCall.name)
    .map(([, toolCall]) => {
      const rawArguments = toolCall.arguments || '{}';
      const parsedArguments = parseToolArguments(toolCall.arguments);
      return {
        id: String(toolCall.id),
        name: String(toolCall.name),
        rawArguments,
        arguments: parsedArguments.value,
        ...(parsedArguments.error ? { argumentsParseError: parsedArguments.error } : {})
      };
    });
}

function assertHasModelOutput(content: string, toolCallCount: number): void {
  if (!content && toolCallCount === 0) {
    throw new Error('Model response did not include assistant content or tool calls.');
  }
}

function parseToolArguments(raw: string | undefined): ParsedToolArguments {
  if (!raw?.trim()) {
    return { value: {} };
  }

  const direct = tryParseToolArguments(raw);
  if (!direct.error) {
    return direct;
  }

  // Some providers decode nested JSON string escapes while streaming tool arguments.
  // That turns `\\n` inside string values into literal newlines, which breaks a second JSON.parse.
  const normalized = normalizeJsonObjectString(raw);
  if (normalized !== raw) {
    const repaired = tryParseToolArguments(normalized);
    if (!repaired.error) {
      return repaired;
    }
  }

  return direct;
}

function tryParseToolArguments(raw: string): ParsedToolArguments {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {
        value: {},
        error: 'Tool arguments must be a JSON object.'
      };
    }
    return { value: parsed };
  } catch {
    return {
      value: {},
      error: 'Tool arguments were not valid JSON.'
    };
  }
}

function normalizeJsonObjectString(raw: string): string {
  let normalized = '';
  let inString = false;
  let escaping = false;

  for (const char of raw) {
    if (escaping) {
      normalized += char;
      escaping = false;
      continue;
    }

    if (char === '\\') {
      normalized += char;
      escaping = true;
      continue;
    }

    if (char === '"') {
      normalized += char;
      inString = !inString;
      continue;
    }

    if (inString) {
      if (char === '\n') {
        normalized += '\\n';
        continue;
      }
      if (char === '\r') {
        normalized += '\\r';
        continue;
      }
      if (char === '\t') {
        normalized += '\\t';
        continue;
      }
      if (char === '\b') {
        normalized += '\\b';
        continue;
      }
      if (char === '\f') {
        normalized += '\\f';
        continue;
      }

      const code = char.charCodeAt(0);
      if (code < 0x20) {
        normalized += `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
    }

    normalized += char;
  }

  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

async function requestViaProxy(url: string, options: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
  proxy: string;
}): Promise<Response> {
  const targetUrl = new URL(url);
  const proxyUrl = new URL(options.proxy);
  if (proxyUrl.protocol !== 'http:' && proxyUrl.protocol !== 'https:') {
    throw new Error(`Unsupported model proxy protocol: ${proxyUrl.protocol}. Use an http:// or https:// proxy URL.`);
  }

  if (targetUrl.protocol === 'http:') {
    return requestHttpViaProxy(targetUrl, proxyUrl, options);
  }
  if (targetUrl.protocol === 'https:') {
    return requestHttpsViaProxy(targetUrl, proxyUrl, options);
  }

  throw new Error(`Unsupported model base URL protocol: ${targetUrl.protocol}`);
}

function requestHttpViaProxy(targetUrl: URL, proxyUrl: URL, options: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const proxyClient = proxyUrl.protocol === 'https:' ? https : http;
    const request = proxyClient.request({
      host: proxyUrl.hostname,
      port: getUrlPort(proxyUrl),
      method: options.method,
      path: targetUrl.toString(),
      headers: {
        ...options.headers,
        Host: targetUrl.host,
        'Content-Length': Buffer.byteLength(options.body),
        ...buildProxyAuthorizationHeader(proxyUrl),
      },
    }, (response) => {
      resolve(nodeResponseToFetchResponse(response));
    });

    request.on('error', reject);
    attachAbortSignal(request, options.signal);
    request.end(options.body);
  });
}

function requestHttpsViaProxy(targetUrl: URL, proxyUrl: URL, options: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const proxyClient = proxyUrl.protocol === 'https:' ? https : http;
    const proxyRequest = proxyClient.request({
      host: proxyUrl.hostname,
      port: getUrlPort(proxyUrl),
      method: 'CONNECT',
      path: `${targetUrl.hostname}:${targetUrl.port || 443}`,
      headers: {
        Host: `${targetUrl.hostname}:${targetUrl.port || 443}`,
        ...buildProxyAuthorizationHeader(proxyUrl),
      },
    });

    proxyRequest.once('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed with HTTP ${response.statusCode}.`));
        return;
      }

      const tlsSocket = tls.connect({
        socket,
        servername: targetUrl.hostname,
      });

      const requestPath = `${targetUrl.pathname}${targetUrl.search}`;
      const request = https.request({
        createConnection: () => tlsSocket,
        host: targetUrl.hostname,
        port: Number(targetUrl.port || 443),
        method: options.method,
        path: requestPath,
        headers: {
          ...options.headers,
          Host: targetUrl.host,
          'Content-Length': Buffer.byteLength(options.body),
        },
      }, (modelResponse) => {
        resolve(nodeResponseToFetchResponse(modelResponse));
      });

      request.on('error', reject);
      attachAbortSignal(request, options.signal);
      request.end(options.body);
    });

    proxyRequest.on('error', reject);
    attachAbortSignal(proxyRequest, options.signal);
    proxyRequest.end();
  });
}

function nodeResponseToFetchResponse(response: http.IncomingMessage): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else if (value !== undefined) {
      headers.set(key, String(value));
    }
  }

  return new Response(response as unknown as BodyInit, {
    status: response.statusCode ?? 200,
    statusText: response.statusMessage,
    headers,
  });
}

function buildProxyAuthorizationHeader(proxyUrl: URL): Record<string, string> {
  if (!proxyUrl.username && !proxyUrl.password) {
    return {};
  }

  const credentials = `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`;
  return {
    'Proxy-Authorization': `Basic ${Buffer.from(credentials).toString('base64')}`,
  };
}

function getUrlPort(url: URL): number {
  if (url.port) {
    return Number(url.port);
  }
  return url.protocol === 'https:' ? 443 : 80;
}

function attachAbortSignal(request: http.ClientRequest, signal?: AbortSignal): void {
  if (!signal) {
    return;
  }

  if (signal.aborted) {
    request.destroy(new Error('Request aborted.'));
    return;
  }

  signal.addEventListener('abort', () => {
    request.destroy(new Error('Request aborted.'));
  }, { once: true });
}
