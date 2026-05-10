import { ModelRequest, ModelResponse } from '../shared/types';

interface ChatCompletionsResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
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
}

export class OpenAICompatibleModelClient {
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await fetch(`${request.settings.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: request.settings.model,
        messages: request.messages,
        tools: request.tools?.length ? request.tools : undefined,
        tool_choice: request.tools?.length ? 'auto' : undefined,
        temperature: 0.2
      }),
      signal: request.signal
    });

    const body = await response.text();
    let parsed: ChatCompletionsResponse;
    try {
      parsed = JSON.parse(body) as ChatCompletionsResponse;
    } catch {
      throw new Error(`Model provider returned non-JSON response (${response.status}).`);
    }

    if (!response.ok) {
      throw new Error(parsed.error?.message ?? `Model request failed with HTTP ${response.status}.`);
    }

    const choice = parsed.choices?.[0];
    const message = choice?.message;
    if (!message) {
      throw new Error('Model response did not include an assistant message.');
    }

    const content = message.content ?? '';
    const toolCalls = (message.tool_calls ?? [])
      .filter((toolCall) => toolCall.id && toolCall.function?.name)
      .map((toolCall) => ({
        id: String(toolCall.id),
        name: String(toolCall.function?.name),
        rawArguments: String(toolCall.function?.arguments ?? '{}'),
        arguments: parseToolArguments(toolCall.function?.arguments)
      }));

    if (!content && !toolCalls.length) {
      throw new Error('Model response did not include assistant content or tool calls.');
    }

    return {
      content,
      toolCalls,
      finishReason: choice?.finish_reason
    };
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
