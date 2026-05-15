import os from 'node:os'
import path from 'node:path'
import { expandHomePath } from '../utils/helpers.js'

const DEFAULT_SKILL_INSTALL_ROOT = path.join(os.homedir(), 'kraken-coder', 'skills')
const LEGACY_DEFAULT_SKILL_INSTALL_ROOT = path.join(os.homedir(), 'kraken-coder', 'skill')

let configuredGlobalSkillDir: string | undefined
let configuredLegacyGlobalSkillDir: string | undefined
let configuredWorkspaceSkillDir: string | undefined
let configuredLegacyWorkspaceSkillDir: string | undefined
let configuredInstallRoot: string | undefined
let configuredBuiltinSkillDir: string | undefined

export function configureSkillPaths(options: {
  globalSkillDir?: string | undefined
  legacyGlobalSkillDir?: string | undefined
  workspaceSkillDir?: string | undefined
  legacyWorkspaceSkillDir?: string | undefined
  installRoot?: string | undefined
  builtinSkillDir?: string | undefined
}): void {
  configuredGlobalSkillDir = normalizeSkillPath(options.globalSkillDir)
  configuredLegacyGlobalSkillDir = normalizeSkillPath(options.legacyGlobalSkillDir)
  configuredWorkspaceSkillDir = normalizeSkillPath(options.workspaceSkillDir)
  configuredLegacyWorkspaceSkillDir = normalizeSkillPath(options.legacyWorkspaceSkillDir)
  configuredInstallRoot = normalizeSkillPath(options.installRoot)
  configuredBuiltinSkillDir = normalizeSkillPath(options.builtinSkillDir)
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
    configuredLegacyWorkspaceSkillDir,
    configuredInstallRoot ?? normalizeSkillPath(process.env.KRAKEN_SKILLS_DIR),
    configuredGlobalSkillDir ?? DEFAULT_SKILL_INSTALL_ROOT,
    configuredLegacyGlobalSkillDir ?? LEGACY_DEFAULT_SKILL_INSTALL_ROOT,
    configuredBuiltinSkillDir,
  ].filter((dir): dir is string => Boolean(dir))))
}

function normalizeSkillPath(inputPath?: string | undefined): string | undefined {
  if (typeof inputPath !== 'string' || !inputPath.trim()) {
    return undefined
  }
  return path.resolve(expandHomePath(inputPath.trim()))
}
