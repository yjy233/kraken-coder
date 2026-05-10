import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Tool, ToolContext } from './types.js'
import { resolveSandboxPath, toDisplayPath } from './sandbox.js'
import { clampInteger } from '../utils/helpers.js'

export const grepTool: Tool = {
  name: 'grep',
  description: 'Search the project for a text pattern using regular expressions and return matching lines with filenames.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Text or regular expression pattern to search for.',
      },
      path: {
        type: 'string',
        description: 'Project-relative file or directory path to search in. Default is project root.',
      },
      max_results: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        description: 'Maximum number of matches to return.',
      },
    },
    required: ['pattern'],
  },
  execute: async (input, ctx) => {
    const pattern = String(input.pattern || '').trim()
    if (!pattern) {
      throw new Error('pattern is required')
    }
    const regex = new RegExp(pattern, 'i')
    const searchPath = await resolveSandboxPath(ctx.sandboxPolicy, input.path || '.', { mode: 'read' })
    const maxResults = clampInteger(input.max_results, 50, 1, 200)

    const files = await collectFiles(searchPath)
    const matches: string[] = []

    for (const absoluteFile of files) {
      if (matches.length >= maxResults) break
      const relativeFile = toDisplayPath(ctx.sandboxPolicy, absoluteFile)
      let raw = ''
      try {
        raw = await fs.readFile(absoluteFile, 'utf8')
      } catch {
        continue
      }
      const lines = raw.split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? ''
        if (regex.test(line)) {
          matches.push(`${relativeFile}:${index + 1}: ${line}`)
          if (matches.length >= maxResults) break
        }
      }
    }

    return {
      output: matches.join('\n') || '(no matches)',
    }
  },
}

async function collectFiles(dir: string): Promise<string[]> {
  const results: string[] = []
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true })
  for (const entry of entries) {
    if (shouldSkip(entry.name)) continue
    const abs = path.join(dir, entry.parentPath || dir, entry.name)
    if (entry.isFile()) {
      results.push(abs)
    }
  }
  return results
}

function shouldSkip(name: string): boolean {
  return ['.git', 'node_modules', '.sessions', 'dist'].includes(name)
}
