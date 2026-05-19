import * as path from 'path'
import { createToolRegistry } from '../tools/registry'
import type { ToolDefinition } from '../agent/types'
import { refreshSkills } from '../skills/manager'
import { getWorkspaceRoot } from './workspace'
import { getKrakenConfig } from './krakenConfig'
import { configureSkillPaths } from '../skills/paths'
import type { Skill } from '../skills/types'
import { createLspTools } from '../lsp/tools'
import { VSCodeLspAdapter } from './lsp/adapter'
import { ProcessLspAdapter } from '../lsp/adapters/process'

export interface VSCodeToolRegistry {
  tools: ToolDefinition[]
  availableSkills: Skill[]
}

export function createVSCodeToolRegistry(
  options: { extensionRoot?: string } = {}
): VSCodeToolRegistry {
  const root = getWorkspaceRoot()
  if (!root) {
    throw new Error('Open a workspace folder before using tools.')
  }

  const config = getKrakenConfig({ extensionRoot: options.extensionRoot })
  configureSkillPaths({
    globalSkillDir: config.paths.globalSkillDir,
    legacyGlobalSkillDir: config.paths.legacyGlobalSkillDir,
    workspaceSkillDir: config.paths.workspaceSkillDir,
    legacyWorkspaceSkillDir: config.paths.legacyWorkspaceSkillDir,
    installRoot: config.skills.dir,
    builtinSkillDir: config.paths.builtinSkillDir,
  })
  const availableSkills = refreshSkills()
  const tools = createToolRegistry({
    rootDir: extensionRootFallback(root.fsPath),
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

  tools.push(...createLspTools({
    workspaceRoot: root.fsPath,
    adapter: config.lsp.adapter === 'process'
      ? new ProcessLspAdapter({ idleTimeoutMs: config.lsp.timeoutMs * 4 })
      : new VSCodeLspAdapter(),
    config: config.lsp,
  }))

  return { tools, availableSkills }
}

function extensionRootFallback(workspaceRoot: string): string {
  return path.resolve(workspaceRoot)
}
