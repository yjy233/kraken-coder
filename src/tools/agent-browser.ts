import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { Tool, ToolContext } from './types.js'
import { ensureSandboxLayout } from './sandbox.js'
import { clampInteger, truncate } from '../utils/helpers.js'
import { throwIfAborted } from '../utils/abort.js'

type AgentBrowserAction =
  | 'doctor'
  | 'open'
  | 'snapshot'
  | 'click'
  | 'fill'
  | 'type'
  | 'press'
  | 'hover'
  | 'scroll'
  | 'wait'
  | 'get_text'
  | 'get_title'
  | 'get_url'
  | 'screenshot'
  | 'back'
  | 'forward'
  | 'reload'
  | 'tab_list'
  | 'tab_new'
  | 'tab_switch'
  | 'tab_close'
  | 'close'

export const agentBrowserTool: Tool = {
  name: 'agent_browser',
  description: 'Control a real browser through vercel-labs/agent-browser. Supports opening pages, snapshots, clicks, form input, waits, screenshots, tabs, and navigation.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'doctor',
          'open',
          'snapshot',
          'click',
          'fill',
          'type',
          'press',
          'hover',
          'scroll',
          'wait',
          'get_text',
          'get_title',
          'get_url',
          'screenshot',
          'back',
          'forward',
          'reload',
          'tab_list',
          'tab_new',
          'tab_switch',
          'tab_close',
          'close',
        ],
        description: 'Browser action to run.',
      },
      url: {
        type: 'string',
        description: 'URL for action=open or tab_new. Must start with http:// or https://.',
      },
      ref: {
        type: 'string',
        description: 'agent-browser snapshot ref such as @e1. Preferred for click/fill/type/get_text.',
      },
      selector: {
        type: 'string',
        description: 'Fallback selector or text target when no ref is available.',
      },
      text: {
        type: 'string',
        description: 'Text for fill/type/wait.',
      },
      key: {
        type: 'string',
        description: 'Keyboard key for press, e.g. Enter, Escape, Tab.',
      },
      direction: {
        type: 'string',
        enum: ['up', 'down', 'left', 'right'],
        description: 'Scroll direction for action=scroll.',
      },
      pixels: {
        type: 'integer',
        minimum: 1,
        maximum: 10000,
        description: 'Scroll amount in pixels for action=scroll.',
      },
      tab: {
        type: 'string',
        description: 'Tab id or label for tab_switch/tab_close.',
      },
      timeout_ms: {
        type: 'integer',
        minimum: 1000,
        maximum: 120000,
        description: 'Execution timeout in milliseconds.',
      },
      max_output: {
        type: 'integer',
        minimum: 1000,
        maximum: 200000,
        description: 'Maximum command output characters to return.',
      },
      interactive_only: {
        type: 'boolean',
        description: 'For snapshot, request only interactive elements when supported by agent-browser.',
      },
      compact: {
        type: 'boolean',
        description: 'For snapshot, request compact output when supported by agent-browser.',
      },
      full_page: {
        type: 'boolean',
        description: 'For screenshot, capture the full page when supported by agent-browser.',
      },
      path: {
        type: 'string',
        description: 'Optional screenshot filename relative to the session screenshot directory.',
      },
      wait_for: {
        type: 'string',
        description: 'Wait target. Selector by default; also accepts load states load, domcontentloaded, or networkidle.',
      },
    },
    required: ['action'],
  },
  execute: async (input, ctx) => {
    throwIfAborted(ctx.signal)
    const action = normalizeAction(input.action)
    const timeoutMs = clampInteger(input.timeout_ms, ctx.agentBrowserDefaultTimeout, 1000, 120000)
    const maxOutput = clampInteger(input.max_output, ctx.agentBrowserMaxOutput, 1000, 200000)
    const bin = resolveAgentBrowserBin(ctx)
    const command = await buildCommand(action, input, ctx)
    throwIfAborted(ctx.signal)
    const result = await runAgentBrowser(bin, command.args, ctx, timeoutMs, maxOutput)

    const outputParams: Parameters<typeof formatToolOutput>[0] = {
      bin,
      args: command.displayArgs,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      maxOutput,
    }
    if (command.artifactPath) {
      outputParams.artifactPath = command.artifactPath
    }

    return {
      output: formatToolOutput(outputParams),
    }
  },
}

function normalizeAction(value: unknown): AgentBrowserAction {
  const action = String(value || '').trim() as AgentBrowserAction
  const allowed: AgentBrowserAction[] = [
    'doctor',
    'open',
    'snapshot',
    'click',
    'fill',
    'type',
    'press',
    'hover',
    'scroll',
    'wait',
    'get_text',
    'get_title',
    'get_url',
    'screenshot',
    'back',
    'forward',
    'reload',
    'tab_list',
    'tab_new',
    'tab_switch',
    'tab_close',
    'close',
  ]
  if (!allowed.includes(action)) {
    throw new Error(`Unsupported agent_browser action: ${String(value || '')}`)
  }
  return action
}

async function buildCommand(
  action: AgentBrowserAction,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<{ args: string[]; displayArgs: string[]; artifactPath?: string }> {
  if (action === 'doctor') {
    return { args: ['doctor', '--json'], displayArgs: ['doctor', '--json'] }
  }

  const args = ['--session', buildBrowserSessionName(ctx.sessionId)]
  const allowedDomains = normalizeAllowedDomains(ctx.agentBrowserAllowedDomains)
  if (allowedDomains) {
    args.push('--allowed-domains', allowedDomains)
  }

  switch (action) {
    case 'open':
      args.push('open', normalizeUrl(input.url), '--json')
      break
    case 'snapshot':
      args.push('snapshot')
      if (input.interactive_only !== false) {
        args.push('-i')
      }
      if (input.compact !== false) {
        args.push('-c')
      }
      args.push('--json')
      break
    case 'click':
      args.push('click', requireTarget(input), '--json')
      break
    case 'fill':
      args.push('fill', requireTarget(input), requireText(input, 'text is required for fill'), '--json')
      break
    case 'type':
      args.push('type', requireTarget(input), requireText(input, 'text is required for type'), '--json')
      break
    case 'press':
      args.push('press', requireTextField(input.key, 'key is required for press'), '--json')
      break
    case 'hover':
      args.push('hover', requireTarget(input), '--json')
      break
    case 'scroll':
      args.push('scroll', normalizeScrollDirection(input.direction))
      if (input.pixels !== undefined) {
        args.push(String(clampInteger(input.pixels, 500, 1, 10000)))
      }
      if (hasTarget(input)) {
        args.push('--selector', requireTarget(input))
      }
      args.push('--json')
      break
    case 'wait':
      args.push(...buildWaitArgs(input), '--json')
      break
    case 'get_text':
      args.push('get', 'text', requireTarget(input), '--json')
      break
    case 'get_title':
      args.push('get', 'title', '--json')
      break
    case 'get_url':
      args.push('get', 'url', '--json')
      break
    case 'screenshot': {
      const artifactPath = await resolveScreenshotPath(ctx, input.path)
      args.push('screenshot', artifactPath)
      if (input.full_page !== false) {
        args.push('--full')
      }
      args.push('--json')
      return { args, displayArgs: args, artifactPath }
    }
    case 'back':
      args.push('back', '--json')
      break
    case 'forward':
      args.push('forward', '--json')
      break
    case 'reload':
      args.push('reload', '--json')
      break
    case 'tab_list':
      args.push('tab', '--json')
      break
    case 'tab_new':
      args.push('tab', 'new')
      if (input.url) {
        args.push(normalizeUrl(input.url))
      }
      args.push('--json')
      break
    case 'tab_switch':
      args.push('tab', requireTextField(input.tab, 'tab is required for tab_switch'), '--json')
      break
    case 'tab_close':
      args.push('tab', 'close')
      if (input.tab) {
        args.push(requireTextField(input.tab, 'tab must be a string'))
      }
      args.push('--json')
      break
    case 'close':
      args.push('close', '--json')
      break
  }

  return { args, displayArgs: args }
}

function resolveAgentBrowserBin(ctx: ToolContext): string {
  const configured = ctx.agentBrowserBin.trim()
  if (configured && configured !== 'agent-browser') {
    return configured
  }

  const localBin = path.join(ctx.rootDir, 'node_modules', '.bin', 'agent-browser')
  if (existsSync(localBin)) {
    return localBin
  }

  return configured || 'agent-browser'
}

function buildBrowserSessionName(sessionId: string): string {
  const safe = String(sessionId || 'ephemeral-session')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .slice(0, 80)
  return `kraken-${safe || 'ephemeral-session'}`
}

function normalizeUrl(value: unknown): string {
  const url = String(value || '').trim()
  if (!url) {
    throw new Error('url is required')
  }
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new Error('url must start with http:// or https://')
  }
  return url
}

function hasTarget(input: Record<string, unknown>): boolean {
  return Boolean(String(input.ref || input.selector || '').trim())
}

function requireTarget(input: Record<string, unknown>): string {
  const target = String(input.ref || input.selector || '').trim()
  if (!target) {
    throw new Error('ref or selector is required')
  }
  return target
}

function requireText(input: Record<string, unknown>, message: string): string {
  return requireTextField(input.text, message)
}

function requireTextField(value: unknown, message: string): string {
  const text = String(value || '').trim()
  if (!text) {
    throw new Error(message)
  }
  return text
}

function normalizeScrollDirection(value: unknown): string {
  const direction = String(value || 'down').trim()
  if (['up', 'down', 'left', 'right'].includes(direction)) {
    return direction
  }
  throw new Error(`Unsupported scroll direction: ${direction}`)
}

function buildWaitArgs(input: Record<string, unknown>): string[] {
  const waitFor = String(input.wait_for || '').trim()
  const text = String(input.text || '').trim()
  const url = String(input.url || '').trim()
  const selector = String(input.selector || input.ref || '').trim()

  if (text) {
    return ['wait', '--text', text]
  }
  if (url) {
    return ['wait', '--url', url]
  }
  if (['load', 'domcontentloaded', 'networkidle'].includes(waitFor)) {
    return ['wait', '--load', waitFor]
  }
  if (waitFor) {
    return ['wait', waitFor]
  }
  if (selector) {
    return ['wait', selector]
  }
  throw new Error('wait_for, text, selector, ref, or url is required for wait')
}

async function resolveScreenshotPath(ctx: ToolContext, requestedPath: unknown): Promise<string> {
  await ensureSandboxLayout(ctx.sandboxPolicy)
  const screenshotDir = path.join(ctx.sandboxPolicy.sandboxDir, 'agent-browser', 'screenshots')
  await mkdir(screenshotDir, { recursive: true })
  const requested = String(requestedPath || '').trim()
  const fileName = requested
    ? path.basename(requested)
    : `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
  if (!fileName.endsWith('.png')) {
    return path.join(screenshotDir, `${fileName}.png`)
  }
  return path.join(screenshotDir, fileName)
}

async function runAgentBrowser(
  bin: string,
  args: string[],
  ctx: ToolContext,
  timeoutMs: number,
  maxOutput: number
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  await ensureSandboxLayout(ctx.sandboxPolicy)
  const child = spawn(bin, args, {
    cwd: ctx.sandboxPolicy.workspaceRoot,
    env: buildAgentBrowserEnv(ctx),
    shell: false,
    detached: process.platform !== 'win32',
  })

  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killProcessTree(child, 'SIGTERM')
      reject(new Error(`agent-browser timed out after ${timeoutMs}ms`))
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
      reject(new Error('agent-browser interrupted.'))
    }
    if (ctx.signal?.aborted) {
      abort()
      return
    }
    ctx.signal?.addEventListener('abort', abort, { once: true })

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
      if (stdout.length > maxOutput * 2) {
        stdout = stdout.slice(0, maxOutput * 2)
      }
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
      if (stderr.length > maxOutput) {
        stderr = stderr.slice(0, maxOutput)
      }
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ctx.signal?.removeEventListener('abort', abort)
      if (error.code === 'ENOENT') {
        reject(new Error([
          `agent-browser executable not found: ${bin}`,
          'Install it first or configure the browser tool executable.',
        ].join('\n')))
        return
      }
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

function buildAgentBrowserEnv(ctx: ToolContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: process.env.HOME || ctx.sandboxPolicy.workspaceRoot,
    TMPDIR: ctx.sandboxPolicy.tmpDir,
    AGENT_BROWSER_SESSION: buildBrowserSessionName(ctx.sessionId),
  }
  delete env.AGENT_BROWSER_ALLOWED_DOMAINS

  const allowedDomains = normalizeAllowedDomains(ctx.agentBrowserAllowedDomains)
  if (allowedDomains) {
    env.AGENT_BROWSER_ALLOWED_DOMAINS = allowedDomains
  }
  return env
}

function normalizeAllowedDomains(value: string | undefined): string | null {
  const normalized = String(value || '').trim()
  if (!normalized || normalized === '*') {
    return null
  }
  return normalized
}

function formatToolOutput(params: {
  bin: string
  args: string[]
  stdout: string
  stderr: string
  exitCode: number
  maxOutput: number
  artifactPath?: string
}): string {
  const lines = [
    `Command: ${params.bin} ${params.args.join(' ')}`,
    `exitCode: ${params.exitCode}`,
  ]
  if (params.artifactPath) {
    lines.push(`artifact: ${params.artifactPath}`)
  }
  lines.push('')
  lines.push('stdout:')
  lines.push(truncate(params.stdout || '(empty)', params.maxOutput))
  if (params.stderr) {
    lines.push('')
    lines.push('stderr:')
    lines.push(truncate(params.stderr, Math.min(params.maxOutput, 12000)))
  }
  return lines.join('\n')
}
