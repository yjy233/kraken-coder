import { promises as fs } from 'node:fs'
import type { Tool, ToolContext } from './types.js'
import { resolveSandboxPath, toDisplayPath } from './sandbox.js'

export const replaceTool: Tool = {
  name: 'replace',
  description: 'Search and replace text inside a project file. Supports plain text or regex. Returns a diff preview of changes.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Project-relative file path.',
      },
      pattern: {
        type: 'string',
        description: 'Text or regex pattern to search for.',
      },
      replacement: {
        type: 'string',
        description: 'Replacement text.',
      },
      use_regex: {
        type: 'boolean',
        description: 'Whether to treat pattern as a regular expression. Default is false.',
      },
    },
    required: ['path', 'pattern', 'replacement'],
  },
  execute: async (input, ctx) => {
    if (!ctx.allowFileWriteTool) {
      throw new Error('replace is disabled. Set ALLOW_FILE_WRITE_TOOL=true to enable it.')
    }
    const filePath = await resolveSandboxPath(ctx.sandboxPolicy, input.path, { mode: 'write' })
    const pattern = String(input.pattern || '')
    const replacement = String(input.replacement || '')
    const useRegex = Boolean(input.use_regex)

    if (!pattern) {
      throw new Error('pattern is required')
    }

    const raw = await fs.readFile(filePath, 'utf8')

    let newContent: string
    let count: number

    if (useRegex) {
      const regex = new RegExp(pattern, 'g')
      count = (raw.match(regex) || []).length
      newContent = raw.replace(regex, replacement)
    } else {
      const escaped = escapeRegExp(pattern)
      const regex = new RegExp(escaped, 'g')
      count = (raw.match(regex) || []).length
      newContent = raw.replace(regex, replacement)
    }

    if (count === 0) {
      throw new Error(`Pattern not found in ${input.path}`)
    }

    await fs.writeFile(filePath, newContent, 'utf8')

    // 生成变更摘要（显示修改区域前后各几行）
    const diff = buildDiffPreview(raw, newContent)

    return {
      output: `Replaced ${count} occurrence(s) in ${toDisplayPath(ctx.sandboxPolicy, filePath)}\n\n${diff}`,
    }
  },
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildDiffPreview(oldText: string, newText: string): string {
  const oldLines = oldText.split(/\r?\n/)
  const newLines = newText.split(/\r?\n/)

  // 简单 diff：找出第一个变化的行，取前后 3 行
  let changeIndex = -1
  const limit = Math.min(oldLines.length, newLines.length)
  for (let i = 0; i < limit; i++) {
    if (oldLines[i] !== newLines[i]) {
      changeIndex = i
      break
    }
  }

  if (changeIndex === -1 && oldLines.length !== newLines.length) {
    changeIndex = limit
  }

  if (changeIndex === -1) {
    return '(no visual change)'
  }

  const start = Math.max(0, changeIndex - 2)
  const oldEnd = Math.min(oldLines.length, changeIndex + 4)
  const newEnd = Math.min(newLines.length, changeIndex + 4)

  const lines: string[] = []
  lines.push('--- before')
  for (let i = start; i < oldEnd; i++) {
    const prefix = i === changeIndex ? '-' : ' '
    lines.push(`${prefix} ${oldLines[i]}`)
  }
  lines.push('+++ after')
  for (let i = start; i < newEnd; i++) {
    const prefix = i === changeIndex ? '+' : ' '
    lines.push(`${prefix} ${newLines[i]}`)
  }

  return lines.join('\n')
}
