import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Tool, ToolContext } from './types.js'
import { resolveSandboxPath, toDisplayPath } from './sandbox.js'

export const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Write UTF-8 content to a project file. Disabled unless ALLOW_FILE_WRITE_TOOL=true.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Project-relative file path.',
      },
      content: {
        type: 'string',
        description: 'Full file content to write.',
      },
    },
    required: ['path', 'content'],
  },
  execute: async (input, ctx) => {
    if (!ctx.allowFileWriteTool) {
      throw new Error('write_file is disabled. Set ALLOW_FILE_WRITE_TOOL=true to enable it.')
    }
    const filePath = await resolveSandboxPath(ctx.sandboxPolicy, input.path, { mode: 'write', allowMissing: true })
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, String(input.content || ''), 'utf8')
    return {
      output: `Wrote ${toDisplayPath(ctx.sandboxPolicy, filePath)}`,
    }
  },
}
