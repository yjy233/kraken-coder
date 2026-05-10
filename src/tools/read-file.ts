import { promises as fs } from 'node:fs'
import type { Tool, ToolContext } from './types.js'
import { resolveSandboxPath } from './sandbox.js'
import { clampInteger } from '../utils/helpers.js'

export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read a UTF-8 text file from the project and optionally limit the line range.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Project-relative file path.',
      },
      start_line: {
        type: 'integer',
        minimum: 1,
        description: 'Optional starting line number.',
      },
      end_line: {
        type: 'integer',
        minimum: 1,
        description: 'Optional ending line number.',
      },
    },
    required: ['path'],
  },
  execute: async (input, ctx) => {
    const filePath = await resolveSandboxPath(ctx.sandboxPolicy, input.path, { mode: 'read' })
    const raw = await fs.readFile(filePath, 'utf8')
    const lines = raw.split(/\r?\n/)
    const start = clampInteger(input.start_line, 1, 1, lines.length || 1)
    const end = clampInteger(input.end_line, lines.length, start, lines.length || start)
    const snippet = lines
      .slice(start - 1, end)
      .map((line, index) => `${String(start + index).padStart(4, ' ')} | ${line}`)
      .join('\n')
    return {
      output: snippet || '(empty file)',
    }
  },
}
