import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SessionSandboxConfig, SessionSandboxPolicy } from './types.js'
import { expandHomePath, isRecord } from '../utils/helpers.js'

export function normalizeHostPath(inputPath: string): string {
  return path.resolve(expandHomePath(inputPath))
}

export function parseSensitivePaths(value: string | undefined): string[] {
  return value && value.trim()
    ? value.split(',').map((item) => normalizeHostPath(item.trim())).filter(Boolean)
    : []
}

export function normalizeSessionSandboxConfig(value: unknown): SessionSandboxConfig | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const workspaceRoot = typeof value.workspaceRoot === 'string'
    ? value.workspaceRoot.trim()
    : ''
  const readRoots = Array.isArray(value.readRoots)
    ? value.readRoots.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean)
    : []

  if (!workspaceRoot && readRoots.length === 0) {
    return undefined
  }

  const sandbox: SessionSandboxConfig = {}
  if (workspaceRoot) {
    sandbox.workspaceRoot = workspaceRoot
  }
  if (readRoots.length > 0) {
    sandbox.readRoots = readRoots
  }
  return sandbox
}

export function buildSessionSandboxPolicy(params: {
  sessionId: string
  sessionSandbox?: SessionSandboxConfig | undefined
  defaultWorkspaceRoot: string
  sensitivePaths: string[]
  enablePathSandbox: boolean
}): SessionSandboxPolicy {
  const workspaceRoot = normalizeHostPath(params.sessionSandbox?.workspaceRoot || params.defaultWorkspaceRoot)
  const sandboxDir = path.join(workspaceRoot, '.kraken')

  return {
    sessionId: params.sessionId,
    workspaceRoot,
    readMode: 'host-read',
    readRoots: (params.sessionSandbox?.readRoots || []).map(normalizeHostPath),
    writeRoots: [workspaceRoot],
    sensitiveRoots: params.sensitivePaths.map(normalizeHostPath),
    sandboxDir,
    tmpDir: path.join(sandboxDir, 'tmp'),
    profileDir: path.join(sandboxDir, 'profiles'),
    enablePathSandbox: false,
  }
}

export async function ensureSandboxLayout(policy: SessionSandboxPolicy): Promise<void> {
  await fs.mkdir(policy.workspaceRoot, { recursive: true })
  await fs.mkdir(policy.tmpDir, { recursive: true })
  await fs.mkdir(policy.profileDir, { recursive: true })
}

export async function resolveSandboxPath(
  policy: SessionSandboxPolicy,
  inputPath: unknown,
  options: { mode: 'read' | 'write'; allowMissing?: boolean }
): Promise<string> {
  const raw = String(inputPath || '').trim()
  if (!raw) {
    throw new Error('path is required')
  }

  const expanded = expandHomePath(raw)
  const candidate = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(policy.workspaceRoot, expanded)

  if (options.allowMissing) {
    return candidate
  }

  return fs.realpath(candidate)
}

export function toDisplayPath(policy: SessionSandboxPolicy, targetPath: string): string {
  const relative = path.relative(policy.workspaceRoot, targetPath)
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return relative || '.'
  }
  return targetPath
}

export function buildShellEnv(policy: SessionSandboxPolicy): Record<string, string> {
  return {
    ...stringEnv(process.env),
    PWD: policy.workspaceRoot,
    TMPDIR: process.env.TMPDIR || policy.tmpDir,
  }
}

export function buildSandboxPromptContext(policy: SessionSandboxPolicy): string {
  return [
    '## Workspace Context',
    `- Current workspace directory: ${policy.workspaceRoot}`,
    '- Treat the current workspace directory as the project root for relative paths.',
    `- Shell commands run with cwd: ${policy.workspaceRoot}`,
    '- Path sandboxing is disabled in the VS Code extension adapter.',
  ].join('\n')
}

export async function generateSeatbeltProfile(policy: SessionSandboxPolicy): Promise<string> {
  await ensureSandboxLayout(policy)
  const profilePath = path.join(policy.profileDir, `${sanitizeProfileName(policy.sessionId)}.sb`)
  await fs.writeFile(profilePath, '(version 1)\n(allow default)\n', 'utf8')
  return profilePath
}

export function isWithinRoot(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root)
  const normalizedCandidate = path.resolve(candidate)
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(normalizedRoot + path.sep)
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      result[key] = value
    }
  }
  return result
}

function sanitizeProfileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_') || 'session'
}
