import type { Tool } from './types.js'

export const webFetchTool: Tool = {
  name: 'web_fetch',
  description: 'Fetch a web page and return its plain text content. Useful for reading documentation, articles, or any public URL.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Full URL to fetch (must include http:// or https://).',
      },
    },
    required: ['url'],
  },
  execute: async (input) => {
    const url = String(input.url || '').trim()
    if (!url) {
      throw new Error('url is required')
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      throw new Error('url must start with http:// or https://')
    }

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; KrakenAgent/1.0)',
      },
      signal: AbortSignal.timeout(15000),
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const contentType = response.headers.get('content-type') || ''
    const raw = await response.text()

    let text: string
    if (contentType.includes('text/html')) {
      text = htmlToText(raw)
    } else {
      text = raw
    }

    // 截断过长内容
    const maxLen = 12000
    if (text.length > maxLen) {
      text = text.slice(0, maxLen) + '\n\n[Content truncated]'
    }

    return { output: text || '(empty page)' }
  },
}

function htmlToText(html: string): string {
  // 去掉 script/style/noscript/iframe
  let t = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, ' ')

  // 把常见块级标签换成换行
  t = t.replace(/<(\/\s*)?(div|p|h[1-6]|li|tr|br)[^>]*>/gi, '\n')

  // 去掉所有剩余标签
  t = t.replace(/<[^>]+>/g, ' ')

  // 解码常见 HTML 实体
  t = t
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')

  // 压缩空白
  t = t.replace(/\s+/g, ' ').trim()
  t = t.replace(/(\n\s*)+/g, '\n').trim()

  return t
}
