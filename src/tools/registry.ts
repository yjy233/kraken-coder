/**
 * 工具注册表
 *
 * 集中注册所有 Agent 可调用的本地工具。
 */

import type { Tool, ToolContext } from './types.js'
import type { ToolDefinition } from '../agent/types.js'
import { listDirectoryTool } from './list-directory.js'
import { readFileTool } from './read-file.js'
import { grepTool } from './grep.js'
import { globTool } from './glob.js'
import { writeFileTool } from './write-file.js'
import { shellCommandTool } from './shell-command.js'
import { webFetchTool } from './web-fetch.js'
import { agentBrowserTool } from './agent-browser.js'
import { todoTool } from './todo.js'
import { searchTool } from './search.js'
import { replaceTool } from './replace.js'
import { skillTool } from './skill.js'
import { skillInstallTool } from './skill-install.js'
import { buildSessionSandboxPolicy } from './sandbox.js'
import type { SessionSandboxConfig } from './types.js'
import type { Skill, SkillRuntimeState } from '../skills/types.js'
import { refreshSkills } from '../skills/manager.js'

export interface CreateRegistryOptions {
  rootDir: string
  allowShellTool: boolean
  allowFileWriteTool: boolean
  allowAgentBrowserTool: boolean
  agentBrowserBin: string
  agentBrowserMaxOutput: number
  agentBrowserDefaultTimeout: number
  agentBrowserAllowedDomains?: string | undefined
  enablePathSandbox: boolean
  enableSeatbelt: boolean
  defaultWorkspaceRoot: string
  sensitivePaths: string[]
  enabledTools?: string[] | undefined // 若为空则启用全部（write_file/shell_command 仍受独立开关控制）
}

export function createToolRegistry(options: CreateRegistryOptions, request?: {
  sessionId?: string
  sessionSandbox?: SessionSandboxConfig | undefined
  availableSkills?: Skill[] | undefined
  skillState?: SkillRuntimeState | undefined
}): ToolDefinition[] {
  const enabledSet = options.enabledTools && options.enabledTools.length > 0
    ? new Set(options.enabledTools)
    : null

  // 所有工具在这里注册
  const allTools: Tool[] = [
    listDirectoryTool,
    readFileTool,
    grepTool,
    globTool,
    writeFileTool,
    shellCommandTool,
    webFetchTool,
    agentBrowserTool,
    todoTool,
    searchTool,
    replaceTool,
    skillTool,
    skillInstallTool,
  ]

  const tools = allTools.filter((tool) => {
    if (!enabledSet) return true
    return enabledSet.has(tool.name)
  })

  const sessionId = request?.sessionId || 'ephemeral-session'
  let availableSkills = request?.availableSkills || []
  const sandboxPolicy = buildSessionSandboxPolicy({
    sessionId,
    sessionSandbox: request?.sessionSandbox,
    defaultWorkspaceRoot: options.defaultWorkspaceRoot,
    sensitivePaths: options.sensitivePaths,
    enablePathSandbox: options.enablePathSandbox,
  })

  const ctx: ToolContext = {
    rootDir: options.rootDir,
    allowShellTool: options.allowShellTool,
    allowFileWriteTool: options.allowFileWriteTool,
    allowAgentBrowserTool: options.allowAgentBrowserTool,
    agentBrowserBin: options.agentBrowserBin,
    agentBrowserMaxOutput: options.agentBrowserMaxOutput,
    agentBrowserDefaultTimeout: options.agentBrowserDefaultTimeout,
    agentBrowserAllowedDomains: options.agentBrowserAllowedDomains,
    enablePathSandbox: options.enablePathSandbox,
    enableSeatbelt: options.enableSeatbelt,
    sessionId,
    sessionSandbox: request?.sessionSandbox,
    sandboxPolicy,
    availableSkills,
    skillState: request?.skillState || { loadedSkillNames: new Set<string>() },
    refreshSkills,
    setAvailableSkills: (skills: Skill[]) => {
      availableSkills = skills
      ctx.availableSkills = skills
    },
  }

  // 注入上下文：包装 execute 方法，并映射为 ToolDefinition 格式
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    execute: (input: Record<string, unknown>) => tool.execute(input, ctx),
  }))
}
