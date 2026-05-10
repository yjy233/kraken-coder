import * as path from 'path'
import { createToolRegistry } from '../tools/registry'
import type { ToolDefinition } from '../agent/types'
import { refreshSkills } from '../skills/manager'
import { createProposeChangesTool, type ProposeChangesHandler } from '../tools/propose-changes'
import { getWorkspaceRoot } from './workspace'
import { getKrakenConfig } from './krakenConfig'
import { configureSkillPaths } from '../skills/paths'

export function createVSCodeToolRegistry(proposeChanges: ProposeChangesHandler): ToolDefinition[] {
  const root = getWorkspaceRoot()
  if (!root) {
    throw new Error('Open a workspace folder before using tools.')
  }

  const config = getKrakenConfig()
  configureSkillPaths({
    globalSkillDir: config.paths.globalSkillDir,
    workspaceSkillDir: config.paths.workspaceSkillDir,
    installRoot: config.skills.dir,
  })
  const availableSkills = refreshSkills()
  const tools = createToolRegistry({
    rootDir: extensionRootFallback(root.fsPath),
    allowShellTool: config.agent.allowTerminal,
    allowFileWriteTool: config.agent.allowFileWriteTool,
    allowAgentBrowserTool: config.agent.allowBrowserTool,
    agentBrowserBin: config.agent.browserBin,
    agentBrowserMaxOutput: config.agent.browserMaxOutput,
    agentBrowserDefaultTimeout: config.agent.browserDefaultTimeout,
    agentBrowserAllowedDomains: config.agent.browserAllowedDomains,
    enablePathSandbox: false,
    enableSeatbelt: false,
    defaultWorkspaceRoot: root.fsPath,
    sensitivePaths: [],
  }, {
    sessionId: 'vscode-session',
    availableSkills,
    skillState: { loadedSkillNames: new Set<string>() },
  })

  const proposeChangesTool = createProposeChangesTool(proposeChanges)
  tools.push({
    name: proposeChangesTool.name,
    description: proposeChangesTool.description,
    input_schema: proposeChangesTool.inputSchema,
    execute: (input: Record<string, unknown>) => proposeChangesTool.execute(input, {} as never),
  })

  return tools
}

function extensionRootFallback(workspaceRoot: string): string {
  return path.resolve(workspaceRoot)
}
