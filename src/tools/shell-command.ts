import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { Tool, ToolContext } from './types.js'
import { buildShellEnv, ensureSandboxLayout, generateSeatbeltProfile } from './sandbox.js'
import { clampInteger } from '../utils/helpers.js'

export const shellCommandTool: Tool = {
  name: 'shell_command',
  description: 'Run a shell command inside the project.',
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
      killProcessTree(child, 'SIGTERM')
      reject(new Error(`Command timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    const abort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ctx.signal?.removeEventListener('abort', abort)
      killProcessTree(child, 'SIGINT')
      setTimeout(() => {
        if (child.exitCode === null) {
          killProcessTree(child, 'SIGTERM')
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
        outputPreview: formatRunningOutput(command, stdout, stderr),
      })
    })
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk)
      stderr += text
      ctx.emit?.('tool:running', {
        toolName: 'shell_command',
        outputPreview: formatRunningOutput(command, stdout, stderr),
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

function formatRunningOutput(command: string, stdout: string, stderr: string): string {
  return [
    `$ ${command}`,
    '',
    stdout ? `stdout:\n${truncateOutput(stdout)}` : 'stdout:\n(empty)',
    '',
    stderr ? `stderr:\n${truncateOutput(stderr)}` : 'stderr:\n(empty)',
  ].join('\n')
}

function truncateOutput(value: string): string {
  const maxLength = 4000
  const normalized = value.trim()
  if (normalized.length <= maxLength) {
    return normalized
  }
  return `[output truncated]\n${normalized.slice(-maxLength)}`
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
      detached: process.platform !== 'win32',
    })
  }

  const profilePath = await generateSeatbeltProfile(ctx.sandboxPolicy)
  return spawn('/usr/bin/sandbox-exec', ['-f', profilePath, '/bin/zsh', '-lc', command], {
    cwd: ctx.sandboxPolicy.workspaceRoot,
    env,
    detached: process.platform !== 'win32',
  })
}

function killProcessTree(child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean }, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Fall through to killing the direct child.
    }
  }
  child.kill(signal)
}
