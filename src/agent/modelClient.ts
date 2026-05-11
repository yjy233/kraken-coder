import * as http from 'node:http';
import * as https from 'node:https';
import * as tls from 'node:tls';
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

interface ChatCompletionsStreamChunk {
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
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
}

export class OpenAICompatibleModelClient {
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const url = `${request.settings.baseUrl}/chat/completions`;
    const requestBody = JSON.stringify({
      model: request.settings.model,
      messages: request.messages,
      tools: request.tools?.length ? request.tools : undefined,
      tool_choice: request.tools?.length ? 'auto' : undefined,
      temperature: 0.2,
      stream: Boolean(request.onDelta)
    });
    const headers = {
      Authorization: `Bearer ${request.apiKey}`,
      'Content-Type': 'application/json'
    };

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

    if (request.onDelta) {
      return this.readStreamingResponse(response, request.onDelta);
    }

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

  private async readStreamingResponse(response: Response, onDelta: (delta: string) => void): Promise<ModelResponse> {
    if (!response.ok) {
      const body = await response.text();
      throw new Error(extractErrorMessage(body) ?? `Model request failed with HTTP ${response.status}.`);
    }

    if (!response.body) {
      throw new Error('Model provider returned an empty streaming response.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let finishReason: string | undefined;
    const toolCallParts = new Map<number, {
      id?: string;
      name?: string;
      arguments: string;
    }>();

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? '';

      for (const event of events) {
        for (const data of parseServerSentEventData(event)) {
          if (data === '[DONE]') {
            continue;
          }

          let parsed: ChatCompletionsStreamChunk;
          try {
            parsed = JSON.parse(data) as ChatCompletionsStreamChunk;
          } catch {
            continue;
          }

          if (parsed.error?.message) {
            throw new Error(parsed.error.message);
          }

          const choice = parsed.choices?.[0];
          if (!choice) {
            continue;
          }

          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
          }

          const deltaText = choice.delta?.content ?? '';
          if (deltaText) {
            content += deltaText;
            onDelta(deltaText);
          }

          for (const toolCall of choice.delta?.tool_calls ?? []) {
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
      }
    }

    const trailing = buffer.trim();
    if (trailing) {
      for (const data of parseServerSentEventData(trailing)) {
        if (data !== '[DONE]') {
          const parsed = JSON.parse(data) as ChatCompletionsStreamChunk;
          const choice = parsed.choices?.[0];
          if (choice?.finish_reason) {
            finishReason = choice.finish_reason;
          }
        }
      }
    }

    const toolCalls = Array.from(toolCallParts.entries())
      .sort(([left], [right]) => left - right)
      .filter(([, toolCall]) => toolCall.id && toolCall.name)
      .map(([, toolCall]) => ({
        id: String(toolCall.id),
        name: String(toolCall.name),
        rawArguments: toolCall.arguments || '{}',
        arguments: parseToolArguments(toolCall.arguments)
      }));

    if (!content && !toolCalls.length) {
      throw new Error('Model response did not include assistant content or tool calls.');
    }

    return {
      content,
      toolCalls,
      finishReason
    };
  }
}

function parseServerSentEventData(event: string): string[] {
  return event
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
}

function extractErrorMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as ChatCompletionsResponse;
    return parsed.error?.message;
  } catch {
    return undefined;
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
      port: Number(proxyUrl.port || 80),
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
      port: Number(proxyUrl.port || 80),
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
      const request = http.request({
        createConnection: () => tlsSocket,
        host: targetUrl.hostname,
        port: Number(targetUrl.port || 443),
        protocol: 'https:',
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
