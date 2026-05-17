/**
 * 工具接口定义
 */

import type { Skill, SkillRuntimeState } from '../skills/types.js'
import type { EmitFn } from '../agent/types.js'

export interface SessionSandboxConfig {
  workspaceRoot?: string
  readRoots?: string[]
}

export type SessionSandboxReadMode = 'allowlist' | 'host-read'

export interface SessionSandboxPolicy {
  sessionId: string
  workspaceRoot: string
  readMode: SessionSandboxReadMode
  readRoots: string[]
  writeRoots: string[]
  sensitiveRoots: string[]
  sandboxDir: string
  tmpDir: string
  profileDir: string
  enablePathSandbox: boolean
}

export interface ToolContext {
  rootDir: string
  agentBrowserBin: string
  agentBrowserMaxOutput: number
  agentBrowserDefaultTimeout: number
  agentBrowserAllowedDomains?: string | undefined
  enablePathSandbox: boolean
  enableSeatbelt: boolean
  sessionId: string
  sessionSandbox?: SessionSandboxConfig | undefined
  sandboxPolicy: SessionSandboxPolicy
  availableSkills: Skill[]
  skillState: SkillRuntimeState
  refreshSkills: () => Skill[]
  setAvailableSkills: (skills: Skill[]) => void
  signal?: AbortSignal | undefined
  emit?: EmitFn | undefined
}

export interface ToolResult {
  output: string
}

export interface Tool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
}
