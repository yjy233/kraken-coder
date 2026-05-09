import { ModelRequest } from '../shared/types';

interface ChatCompletionsResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  error?: {
    message?: string;
  };
}

export class OpenAICompatibleModelClient {
  async complete(request: ModelRequest): Promise<string> {
    const response = await fetch(`${request.settings.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: request.settings.model,
        messages: request.messages,
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

    const content = parsed.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Model response did not include assistant content.');
    }

    return content;
  }
}

