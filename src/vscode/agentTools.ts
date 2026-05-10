import * as path from 'path'
import * as vscode from 'vscode'
import { createToolRegistry } from '../tools/registry'
import type { ToolDefinition } from '../agent/types'
import { getAvailableSkills } from '../skills/manager'
import { getWorkspaceRoot } from './workspace'

export function createVSCodeToolRegistry(): ToolDefinition[] {
  const root = getWorkspaceRoot()
  if (!root) {
    throw new Error('Open a workspace folder before using tools.')
  }

  const config = vscode.workspace.getConfiguration('kraken')
  return createToolRegistry({
    rootDir: extensionRootFallback(root.fsPath),
    allowShellTool: config.get<boolean>('agent.allowTerminal') ?? parseBoolean(process.env.ALLOW_SHELL_TOOL, false),
    allowFileWriteTool: config.get<boolean>('agent.allowFileWriteTool') ?? parseBoolean(process.env.ALLOW_FILE_WRITE_TOOL, false),
    allowAgentBrowserTool: config.get<boolean>('agent.allowBrowserTool') ?? parseBoolean(process.env.ALLOW_AGENT_BROWSER, false),
    agentBrowserBin: config.get<string>('agent.browserBin') || process.env.AGENT_BROWSER_BIN || 'agent-browser',
    agentBrowserMaxOutput: config.get<number>('agent.browserMaxOutput') ?? parseInteger(process.env.AGENT_BROWSER_MAX_OUTPUT, 50000),
    agentBrowserDefaultTimeout: config.get<number>('agent.browserDefaultTimeout') ?? parseInteger(process.env.AGENT_BROWSER_DEFAULT_TIMEOUT, 25000),
    agentBrowserAllowedDomains: config.get<string>('agent.browserAllowedDomains') || process.env.AGENT_BROWSER_ALLOWED_DOMAINS,
    enablePathSandbox: false,
    enableSeatbelt: false,
    defaultWorkspaceRoot: root.fsPath,
    sensitivePaths: [],
  }, {
    sessionId: 'vscode-session',
    availableSkills: getAvailableSkills(),
    skillState: { loadedSkillNames: new Set<string>() },
  })
}

function extensionRootFallback(workspaceRoot: string): string {
  return path.resolve(workspaceRoot)
}

function parseInteger(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value || ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}
