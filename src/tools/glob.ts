import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Tool, ToolContext } from './types.js'
import { resolveSandboxPath, toDisplayPath } from './sandbox.js'

export const globTool: Tool = {
  name: 'glob',
  description: 'Find files matching a glob pattern (e.g. "**/*.ts", "src/**/*.json"). Returns matching file paths.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern to match file paths. Use ** for recursive, * for wildcard.',
      },
      path: {
        type: 'string',
        description: 'Project-relative directory to start searching from. Default is project root.',
      },
    },
    required: ['pattern'],
  },
  execute: async (input, ctx) => {
    const pattern = String(input.pattern || '').trim()
    if (!pattern) {
      throw new Error('pattern is required')
    }
    const searchPath = await resolveSandboxPath(ctx.sandboxPolicy, input.path || '.', { mode: 'read' })
    const regex = globToRegex(pattern)

    const files = await collectFiles(searchPath)
    const matches = files
      .map((f) => toDisplayPath(ctx.sandboxPolicy, f))
      .filter((rel) => regex.test(rel))
      .sort()

    return {
      output: matches.join('\n') || '(no matches)',
    }
  },
}

function globToRegex(pattern: string): RegExp {
  // 简单 glob 转正则：**
  // ** 匹配任意目录层级
  // * 匹配任意字符（不含 /）
  // ? 匹配单个字符
  let regex = pattern
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*')
  regex = '^' + regex + '$'
  return new RegExp(regex, 'i')
}

async function collectFiles(dir: string): Promise<string[]> {
  const results: string[] = []
  async function visit(currentDir: string) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      if (shouldSkip(entry.name)) continue
      const abs = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        await visit(abs)
      } else {
        results.push(abs)
      }
    }
  }
  await visit(dir)
  return results
}

function shouldSkip(name: string): boolean {
  return ['.git', 'node_modules', '.sessions', 'dist'].includes(name)
}
