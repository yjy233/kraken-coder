import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Tool, ToolContext } from './types.js'
import { resolveSandboxPath } from './sandbox.js'

export const listDirectoryTool: Tool = {
  name: 'list_directory',
  description: 'List files and directories in a project path. Returns names, types (file/dir), and sizes.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Project-relative directory path. Default is project root.',
      },
      recursive: {
        type: 'boolean',
        description: 'Whether to list recursively into subdirectories.',
      },
    },
    required: [],
  },
  execute: async (input, ctx) => {
    const targetPath = await resolveSandboxPath(ctx.sandboxPolicy, input.path || '.', { mode: 'read' })
    const recursive = Boolean(input.recursive)

    const entries = await listEntries(targetPath, recursive)
    const lines = entries.map((e) => {
      const size = e.isDirectory ? '<dir>' : formatBytes(e.size)
      return `${e.isDirectory ? 'd' : 'f'}  ${size.padStart(8)}  ${e.relativePath}`
    })

    return {
      output: lines.join('\n') || '(empty directory)',
    }
  },
}

interface Entry {
  relativePath: string
  isDirectory: boolean
  size: number
}

async function listEntries(dir: string, recursive: boolean): Promise<Entry[]> {
  const results: Entry[] = []
  const rootDir = dir

  async function visit(currentDir: string) {
    const items = await fs.readdir(currentDir, { withFileTypes: true })
    for (const item of items) {
      if (shouldSkip(item.name)) continue
      const abs = path.join(currentDir, item.name)
      const rel = path.relative(rootDir, abs)
      if (item.isDirectory()) {
        results.push({ relativePath: rel + '/', isDirectory: true, size: 0 })
        if (recursive) {
          await visit(abs)
        }
      } else {
        const stat = await fs.stat(abs)
        results.push({ relativePath: rel, isDirectory: false, size: stat.size })
      }
    }
  }

  await visit(dir)
  return results
}

function shouldSkip(name: string): boolean {
  return ['.git', 'node_modules', '.sessions', 'dist'].includes(name)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
