import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Tool, ToolContext } from './types.js'

interface TodoItem {
  id: string
  content: string
  done: boolean
  createdAt: string
}

export const todoTool: Tool = {
  name: 'todo',
  description: 'Manage a simple todo list: list, add, mark done, or delete tasks. Tasks are persisted per project.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'add', 'done', 'delete'],
        description: 'Action to perform: list all, add a new task, mark done, or delete a task.',
      },
      content: {
        type: 'string',
        description: 'Task content (required for add).',
      },
      id: {
        type: 'string',
        description: 'Task ID (required for done or delete).',
      },
    },
    required: ['action'],
  },
  execute: async (input, ctx) => {
    const action = String(input.action || '').trim()
    const storePath = getTodoStorePath(ctx)
    await migrateLegacyTodos(ctx, storePath)

    const todos = await loadTodos(storePath)

    if (action === 'list') {
      if (todos.length === 0) {
        return { output: 'No todos yet.' }
      }
      const lines = todos.map((t) => {
        const mark = t.done ? '✅' : '⬜'
        return `${mark} [${t.id}] ${t.content}`
      })
      return { output: lines.join('\n') }
    }

    if (action === 'add') {
      const content = String(input.content || '').trim()
      if (!content) {
        throw new Error('content is required for add action')
      }
      const id = Math.random().toString(36).slice(2, 8)
      todos.push({
        id,
        content,
        done: false,
        createdAt: new Date().toISOString(),
      })
      await saveTodos(storePath, todos)
      return { output: `Added [${id}]: ${content}` }
    }

    if (action === 'done') {
      const id = String(input.id || '').trim()
      const item = todos.find((t) => t.id === id)
      if (!item) {
        throw new Error(`Todo ${id} not found`)
      }
      item.done = true
      await saveTodos(storePath, todos)
      return { output: `Marked [${id}] as done: ${item.content}` }
    }

    if (action === 'delete') {
      const id = String(input.id || '').trim()
      const idx = todos.findIndex((t) => t.id === id)
      if (idx === -1) {
        throw new Error(`Todo ${id} not found`)
      }
      const [removed] = todos.splice(idx, 1)
      if (!removed) {
        throw new Error(`Todo ${id} not found`)
      }
      await saveTodos(storePath, todos)
      return { output: `Deleted [${id}]: ${removed.content}` }
    }

    throw new Error(`Unknown action: ${action}`)
  },
}

function getTodoStorePath(ctx: ToolContext): string {
  return path.join(ctx.sandboxPolicy.workspaceRoot, '.kraken-coder', '.todo.json')
}

async function migrateLegacyTodos(ctx: ToolContext, storePath: string): Promise<void> {
  const legacyPath = path.join(ctx.sandboxPolicy.workspaceRoot, '.todos.json')
  try {
    await fs.access(storePath)
    return
  } catch {
    // Continue only when the new store does not exist yet.
  }

  try {
    await fs.access(legacyPath)
  } catch {
    return
  }

  await fs.mkdir(path.dirname(storePath), { recursive: true })
  await fs.rename(legacyPath, storePath)
}

async function loadTodos(storePath: string): Promise<TodoItem[]> {
  try {
    const raw = await fs.readFile(storePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed
  } catch {
    // ignore
  }
  return []
}

async function saveTodos(storePath: string, todos: TodoItem[]) {
  await fs.mkdir(path.dirname(storePath), { recursive: true })
  await fs.writeFile(storePath, JSON.stringify(todos, null, 2), 'utf8')
}
