import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { Tool, ToolContext } from './types.js'
import { buildShellEnv, ensureSandboxLayout, generateSeatbeltProfile } from './sandbox.js'
import { clampInteger } from '../utils/helpers.js'

export const shellCommandTool: Tool = {
  name: 'shell_command',
  description: 'Run a shell command inside the project. Disabled unless ALLOW_SHELL_TOOL=true.',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Shell command to run.',
      },
      timeout_ms: {
        type: 'integer',
        minimum: 1000,
        maximum: 120000,
        description: 'Execution timeout in milliseconds.',
      },
    },
    required: ['command'],
  },
  execute: async (input, ctx) => {
    if (!ctx.allowShellTool) {
      throw new Error('shell_command is disabled. Set ALLOW_SHELL_TOOL=true to enable it.')
    }
    const timeoutMs = clampInteger(input.timeout_ms, 15000, 1000, 120000)
    const result = await runShellCommand(ctx, String(input.command || ''), timeoutMs)
    return {
      output: [
        `$ ${input.command}`,
        '',
        result.stdout ? `stdout:\n${result.stdout}` : 'stdout:\n(empty)',
        '',
        result.stderr ? `stderr:\n${result.stderr}` : 'stderr:\n(empty)',
        '',
        `exitCode: ${result.exitCode}`,
      ].join('\n'),
    }
  },
}

async function runShellCommand(
  ctx: ToolContext,
  command: string,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (!command.trim()) {
    throw new Error('command is required')
  }
  await ensureSandboxLayout(ctx.sandboxPolicy)
  const env = buildShellEnv(ctx.sandboxPolicy)
  const useSeatbelt = ctx.enableSeatbelt && process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')
  const child = await spawnSandboxedCommand(ctx, command, env, useSeatbelt)

  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      reject(new Error(`Command timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    const abort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ctx.signal?.removeEventListener('abort', abort)
      child.kill('SIGINT')
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill('SIGTERM')
        }
      }, 1000).unref()
      reject(new Error('Command interrupted.'))
    }
    if (ctx.signal?.aborted) {
      abort()
      return
    }
    ctx.signal?.addEventListener('abort', abort, { once: true })
    child.stdout?.on('data', (chunk) => {
      const text = String(chunk)
      stdout += text
      ctx.emit?.('tool:running', {
        toolName: 'shell_command',
        outputPreview: truncateOutput(text),
      })
    })
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk)
      stderr += text
      ctx.emit?.('tool:running', {
        toolName: 'shell_command',
        outputPreview: truncateOutput(text),
      })
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ctx.signal?.removeEventListener('abort', abort)
      reject(error)
    })
    child.on('close', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ctx.signal?.removeEventListener('abort', abort)
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: exitCode ?? -1,
      })
    })
  })
}

function truncateOutput(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > 240 ? `${normalized.slice(0, 239)}…` : normalized
}

async function spawnSandboxedCommand(
  ctx: ToolContext,
  command: string,
  env: Record<string, string>,
  useSeatbelt: boolean
) {
  if (!useSeatbelt) {
    return spawn('/bin/zsh', ['-lc', command], {
      cwd: ctx.sandboxPolicy.workspaceRoot,
      env,
    })
  }

  const profilePath = await generateSeatbeltProfile(ctx.sandboxPolicy)
  return spawn('/usr/bin/sandbox-exec', ['-f', profilePath, '/bin/zsh', '-lc', command], {
    cwd: ctx.sandboxPolicy.workspaceRoot,
    env,
  })
}
