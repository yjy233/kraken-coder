import type { Tool } from './types.js'
import { combineAbortSignals, throwIfAborted } from '../utils/abort.js'

const TAVILY_API_KEY = process.env.TAVILY_API_KEY || ''
const TAVILY_ENDPOINT = 'https://api.tavily.com/search'

export const searchTool: Tool = {
  name: 'search',
  description: 'Search the web using Tavily API and return summarized results with source URLs.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query string.',
      },
      max_results: {
        type: 'integer',
        minimum: 1,
        maximum: 10,
        description: 'Maximum number of results to return.',
      },
    },
    required: ['query'],
  },
  execute: async (input, ctx) => {
    throwIfAborted(ctx.signal)
    if (!TAVILY_API_KEY) {
      throw new Error('TAVILY_API_KEY is not configured. Add it to .env.')
    }

    const query = String(input.query || '').trim()
    if (!query) {
      throw new Error('query is required')
    }

    const maxResults = Math.min(Math.max(Number(input.max_results) || 5, 1), 10)

    const response = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        search_depth: 'basic',
        max_results: maxResults,
        include_answer: true,
        include_images: false,
      }),
      signal: combineAbortSignals([ctx.signal, AbortSignal.timeout(20000)]),
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`Tavily API error: ${response.status} ${errText}`)
    }

    const data = (await response.json()) as {
      answer?: string
      results?: Array<{
        title: string
        url: string
        content: string
        score: number
      }>
    }

    const parts: string[] = []

    if (data.answer) {
      parts.push(`Answer: ${data.answer}`)
      parts.push('')
    }

    if (data.results && data.results.length > 0) {
      parts.push('Sources:')
      for (const r of data.results) {
        parts.push(`- ${r.title}`)
        parts.push(`  URL: ${r.url}`)
        if (r.content) {
          const snippet = r.content.replace(/\s+/g, ' ').trim().slice(0, 300)
          parts.push(`  ${snippet}${r.content.length > 300 ? '...' : ''}`)
        }
        parts.push('')
      }
    }

    return {
      output: parts.join('\n') || '(no results)',
    }
  },
}
