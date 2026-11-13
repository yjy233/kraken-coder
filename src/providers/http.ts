export interface HttpOptions { baseUrl: string; apiKey?: string; model: string; timeoutMs: number }
export function apiUrl(base: string, endpoint: string): string {
  const url = new URL(base.replace(/\/$/, '') + '/' + endpoint);
  if (url.username || url.password || url.search || url.hash) throw new Error('API URL must not contain credentials, query, or fragment');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Use HTTPS, or HTTP on loopback for a local provider');
  return url.toString();
}
export async function post(options: HttpOptions, endpoint: string, body: unknown, signal: AbortSignal): Promise<Response> {
  const response = await fetch(apiUrl(options.baseUrl, endpoint), {
    method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json', ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) },
    body: JSON.stringify(body), signal,
  });
  // 不把未知远端响应体直接打印：它可能回显 Authorization 或用户内容。
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Provider HTTP ${response.status}`); }
  return response;
}
export async function boundedText(response: Response): Promise<string> {
  let size = 0, text = ''; const decoder = new TextDecoder();
  if (!response.body) throw new Error('Empty HTTP body');
  for await (const chunk of response.body) {
    size += chunk.length; if (size > 4_000_000) throw new Error('Provider response exceeds 4 MB');
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}
