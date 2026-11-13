/** SSE 帧可被任意 TCP chunk 切开，UTF-8 字符也可能跨 chunk。 */
export async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder(); let buffer = '', total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > 4_000_000) throw new Error('SSE response exceeds 4 MB');
    buffer += decoder.decode(chunk, { stream: true });
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
      const data = frame.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
      if (data && data !== '[DONE]') yield JSON.parse(data);
    }
    if (buffer.length > 2_000_000) throw new Error('SSE frame too large');
  }
  buffer += decoder.decode();
  if (buffer.trim()) throw new Error('Truncated SSE frame');
}
