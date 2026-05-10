import type { Tool } from './types.js'
import type { FileChange } from '../shared/types'

let handler: ((summary: string, changes: FileChange[]) => Promise<string>) | null = null

export function configureProposeChangesHandler(nextHandler: (summary: string, changes: FileChange[]) => Promise<string>): void {
  handler = nextHandler
}

export const proposeChangesTool: Tool = {
  name: 'propose_changes',
  description: 'Create a reviewable VS Code change proposal. Use this for file edits when user review is desired.',
  inputSchema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'Short user-facing summary for the proposed changes.',
      },
      changes: {
        type: 'array',
        description: 'File changes with complete desired file content for created or modified files.',
        items: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Workspace-relative file path.',
            },
            type: {
              type: 'string',
              enum: ['create', 'modify', 'delete'],
            },
            fullText: {
              type: 'string',
              description: 'Complete desired file content for create or modify changes.',
            },
            rationale: {
              type: 'string',
              description: 'Brief rationale for this file change.',
            },
          },
          required: ['path', 'type'],
        },
      },
    },
    required: ['summary', 'changes'],
  },
  execute: async (input) => {
    if (!handler) {
      throw new Error('propose_changes handler is not configured.')
    }

    const summary = requireString(input.summary, 'summary')
    const changes = parseFileChanges(input.changes)
    return { output: await handler(summary, changes) }
  },
}

function parseFileChanges(value: unknown): FileChange[] {
  if (!Array.isArray(value)) {
    throw new Error('changes must be an array')
  }

  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`changes[${index}] must be an object`)
    }

    const path = requireString(item.path, `changes[${index}].path`)
    const type = item.type
    if (type !== 'create' && type !== 'modify' && type !== 'delete') {
      throw new Error(`changes[${index}].type must be create, modify, or delete`)
    }

    const fullText = typeof item.fullText === 'string' ? item.fullText : undefined
    if (type !== 'delete' && fullText === undefined) {
      throw new Error(`changes[${index}].fullText is required for ${type}`)
    }

    return {
      path,
      type,
      fullText,
      rationale: typeof item.rationale === 'string' ? item.rationale : undefined,
    }
  })
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
