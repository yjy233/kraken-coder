import * as http from 'node:http';
import * as https from 'node:https';
import * as tls from 'node:tls';
import type {
  JsonRecord,
  ModelMessage,
  ModelReasoningEffort,
  ModelRequest,
  ModelResponse,
  ModelToolDefinition
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

export class OpenAICompatibleModelClient {
  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.settings.provider === 'anthropic') {
      return this.completeAnthropicMessages(request);
    }

    if (request.settings.provider === 'openai' && resolveOpenAIApi(request) === 'responses') {
      return this.completeOpenAIResponses(request);
    }

    return this.completeChatCompletions(request);
  }

  private async completeChatCompletions(request: ModelRequest): Promise<ModelResponse> {
    const response = await postJson(
      request,
      '/chat/completions',
      buildBearerHeaders(request.apiKey),
      buildChatCompletionsBody(request)
    );

    if (request.onDelta && isEventStream(response)) {
      return this.readChatCompletionsStreamingResponse(response, request.onDelta, request.onThinkingDelta);
    }

    return this.readChatCompletionsNonStreamingResponse(response, request.onDelta, request.onThinkingDelta);
  }

  private async completeOpenAIResponses(request: ModelRequest): Promise<ModelResponse> {
    const response = await postJson(
      request,
      '/responses',
      buildBearerHeaders(request.apiKey),
      buildOpenAIResponsesBody(request)
    );

    if (request.onDelta && isEventStream(response)) {
      return this.readOpenAIResponsesStreamingResponse(response, request.onDelta, request.onThinkingDelta);
    }

    return this.readOpenAIResponsesNonStreamingResponse(response, request.onDelta, request.onThinkingDelta);
  }

  private async completeAnthropicMessages(request: ModelRequest): Promise<ModelResponse> {
    const response = await postJson(
      request,
      '/messages',
      {
        'x-api-key': request.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      buildAnthropicMessagesBody(request)
    );

    if (request.onDelta && isEventStream(response)) {
      return this.readAnthropicStreamingResponse(response, request.onDelta, request.onThinkingDelta);
    }

    return this.readAnthropicNonStreamingResponse(response, request.onDelta, request.onThinkingDelta);
  }

  private async readChatCompletionsNonStreamingResponse(
    response: Response,
    onDelta?: (delta: string) => void,
    onThinkingDelta?: (delta: string) => void
  ): Promise<ModelResponse> {
    const parsed = await parseJsonResponse<ChatCompletionsResponse>(response);
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
      .map((toolCall) => ({
        id: String(toolCall.id),
        name: String(toolCall.function?.name),
        rawArguments: String(toolCall.function?.arguments ?? '{}'),
        arguments: parseToolArguments(toolCall.function?.arguments)
      }));

    assertHasModelOutput(content, toolCalls.length);

    return {
      content,
      thinking,
      toolCalls,
      finishReason: choice?.finish_reason
    };
  }

  private async readChatCompletionsStreamingResponse(
    response: Response,
    onDelta: (delta: string) => void,
    onThinkingDelta?: (delta: string) => void
  ): Promise<ModelResponse> {
    await assertOkStreamResponse(response);

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

    buffer = await readServerSentEventStream(reader, decoder, buffer, handleData);
    for (const data of parseServerSentEventData(buffer.trim())) {
      handleData(data);
    }

    const toolCalls = toolCallPartsToModelToolCalls(toolCallParts);
    assertHasModelOutput(content, toolCalls.length);

    return {
      content,
      thinking,
      toolCalls,
      finishReason
    };
  }

  private async readOpenAIResponsesNonStreamingResponse(
    response: Response,
    onDelta?: (delta: string) => void,
    onThinkingDelta?: (delta: string) => void
  ): Promise<ModelResponse> {
    const parsed = await parseJsonResponse<ResponsesResponse>(response);
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
    return modelResponse;
  }

  private async readOpenAIResponsesStreamingResponse(
    response: Response,
    onDelta: (delta: string) => void,
    onThinkingDelta?: (delta: string) => void
  ): Promise<ModelResponse> {
    await assertOkStreamResponse(response);

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

    buffer = await readServerSentEventStream(reader, decoder, buffer, handleData);
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
      finishReason: parsedFinal?.finishReason ?? finalResponse?.status
    };
  }

  private async readAnthropicNonStreamingResponse(
    response: Response,
    onDelta?: (delta: string) => void,
    onThinkingDelta?: (delta: string) => void
  ): Promise<ModelResponse> {
    const parsed = await parseJsonResponse<AnthropicMessageResponse>(response);
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
    return modelResponse;
  }

  private async readAnthropicStreamingResponse(
    response: Response,
    onDelta: (delta: string) => void,
    onThinkingDelta?: (delta: string) => void
  ): Promise<ModelResponse> {
    await assertOkStreamResponse(response);

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
      }
    };

    buffer = await readServerSentEventStream(reader, decoder, buffer, handleData);
    for (const data of parseServerSentEventData(buffer.trim())) {
      handleData(data);
    }

    const toolCalls = toolCallPartsToModelToolCalls(toolCallParts);
    assertHasModelOutput(content, toolCalls.length);

    return {
      content,
      thinking,
      toolCalls,
      finishReason
    };
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
    .map((item) => ({
      id: String(item.call_id ?? item.id ?? ''),
      name: String(item.name),
      rawArguments: String(item.arguments ?? '{}'),
      arguments: parseToolArguments(item.arguments)
    }))
    .filter((toolCall) => toolCall.id && toolCall.name);

  assertHasModelOutput(content, toolCalls.length);

  return {
    content,
    thinking,
    toolCalls,
    finishReason: parsed.incomplete_details?.reason ?? parsed.status
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
    finishReason: parsed.stop_reason ?? undefined
  };
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
        content.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.function.name,
          input: parseToolArguments(toolCall.function.arguments)
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
): Promise<Response> {
  const url = joinUrl(request.settings.baseUrl, path);
  const requestBody = JSON.stringify(body);
  return request.settings.proxy
    ? requestViaProxy(url, {
        method: 'POST',
        headers,
        body: requestBody,
        signal: request.signal,
        proxy: request.settings.proxy
      })
    : fetch(url, {
        method: 'POST',
        headers,
        body: requestBody,
        signal: request.signal
      });
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const body = await response.text();
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`Model provider returned non-JSON response (${response.status}).`);
  }
}

async function assertOkStreamResponse(response: Response): Promise<void> {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(extractErrorMessage(body) ?? `Model request failed with HTTP ${response.status}.`);
  }
  if (!response.body) {
    throw new Error('Model provider returned an empty streaming response.');
  }
}

async function readServerSentEventStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  buffer: string,
  onData: (data: string) => void
): Promise<string> {
  let currentBuffer = buffer;
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    currentBuffer += decoder.decode(value, { stream: true });
    const events = currentBuffer.split(/\r?\n\r?\n/);
    currentBuffer = events.pop() ?? '';

    for (const event of events) {
      for (const data of parseServerSentEventData(event)) {
        onData(data);
      }
    }
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
    .map(([, toolCall]) => ({
      id: String(toolCall.id),
      name: String(toolCall.name),
      rawArguments: toolCall.arguments || '{}',
      arguments: parseToolArguments(toolCall.arguments)
    }));
}

function assertHasModelOutput(content: string, toolCallCount: number): void {
  if (!content && toolCallCount === 0) {
    throw new Error('Model response did not include assistant content or tool calls.');
  }
}

function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
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
