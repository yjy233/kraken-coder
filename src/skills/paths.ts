import os from 'node:os'
import path from 'node:path'
import { expandHomePath } from '../utils/helpers.js'

const DEFAULT_SKILL_INSTALL_ROOT = path.join(os.homedir(), 'kraken-coder', 'skill')

let configuredGlobalSkillDir: string | undefined
let configuredWorkspaceSkillDir: string | undefined
let configuredInstallRoot: string | undefined

export function configureSkillPaths(options: {
  globalSkillDir?: string | undefined
  workspaceSkillDir?: string | undefined
  installRoot?: string | undefined
}): void {
  configuredGlobalSkillDir = normalizeSkillPath(options.globalSkillDir)
  configuredWorkspaceSkillDir = normalizeSkillPath(options.workspaceSkillDir)
  configuredInstallRoot = normalizeSkillPath(options.installRoot)
}

export function getDefaultSkillInstallRoot(): string {
  return path.resolve(DEFAULT_SKILL_INSTALL_ROOT)
}

export function resolveSkillInstallRoot(inputPath?: string | undefined): string {
  return normalizeSkillPath(inputPath)
    ?? configuredInstallRoot
    ?? normalizeSkillPath(process.env.KRAKEN_SKILLS_DIR)
    ?? normalizeSkillPath(configuredGlobalSkillDir)
    ?? getDefaultSkillInstallRoot()
}

export function getSkillDiscoveryDirs(): string[] {
  return Array.from(new Set([
    configuredWorkspaceSkillDir,
    configuredInstallRoot,
    configuredGlobalSkillDir ?? DEFAULT_SKILL_INSTALL_ROOT,
  ].filter((dir): dir is string => Boolean(dir))))
}

function normalizeSkillPath(inputPath?: string | undefined): string | undefined {
  if (typeof inputPath !== 'string' || !inputPath.trim()) {
    return undefined
  }
  return path.resolve(expandHomePath(inputPath.trim()))
}
