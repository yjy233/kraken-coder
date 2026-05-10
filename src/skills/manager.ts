import { discoverSkills } from './registry.js'
import type { Skill } from './types.js'
import { resolveSkillInstallRoot } from './paths.js'

let availableSkills: Skill[] = discoverSkills()

export function getAvailableSkills(): Skill[] {
  return availableSkills
}

export function refreshSkills(): Skill[] {
  availableSkills = discoverSkills()
  return availableSkills
}

export function getSkillInstallRoot(): string {
  return resolveSkillInstallRoot()
}
