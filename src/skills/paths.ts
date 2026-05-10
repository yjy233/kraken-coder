import os from 'node:os'
import path from 'node:path'
import { expandHomePath } from '../utils/helpers.js'

const DEFAULT_SKILL_INSTALL_ROOT = path.join(os.homedir(), 'kraken', 'skills')

export function getDefaultSkillInstallRoot(): string {
  return path.resolve(DEFAULT_SKILL_INSTALL_ROOT)
}

export function resolveSkillInstallRoot(inputPath?: string | undefined): string {
  const raw = typeof inputPath === 'string' && inputPath.trim()
    ? inputPath.trim()
    : process.env.KRAKEN_SKILLS_DIR || DEFAULT_SKILL_INSTALL_ROOT
  return path.resolve(expandHomePath(raw))
}

export function getSkillDiscoveryDirs(): string[] {
  return Array.from(new Set([
    resolveSkillInstallRoot(process.env.KRAKEN_SKILLS_DIR),
    path.resolve(process.cwd(), 'skills'),
    path.resolve(expandHomePath('~/.config/kraken/skills')),
    path.resolve(expandHomePath('~/.kraken/skills')),
  ]))
}
