import { promises as fs } from 'node:fs'
import path from 'node:path'
import { extractYamlField, parseSkillFile } from './registry.js'
import type { Skill } from './types.js'
import { expandHomePath } from '../utils/helpers.js'

const SKILL_NAME_PATTERN = /^[a-z0-9-]+$/
const TODO_PATTERN = /\bTODO:/i

export interface SkillValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  skill?: Pick<Skill, 'name' | 'description' | 'dirPath'>
}

export interface InitSkillParams {
  skillName: string
  baseDir: string
  description?: string
  force?: boolean
}

export interface InitSkillResult {
  skillDir: string
  skill: Skill
}

export async function initSkill(params: InitSkillParams): Promise<InitSkillResult> {
  const skillName = normalizeSkillName(params.skillName)
  const baseDir = resolveAuthoringPath(params.baseDir)
  const skillDir = path.join(baseDir, skillName)

  await fs.mkdir(baseDir, { recursive: true })

  if (await pathExists(skillDir)) {
    if (!params.force) {
      throw new Error(`Skill directory already exists: ${skillDir}`)
    }
    await fs.rm(skillDir, { recursive: true, force: true })
  }

  await fs.mkdir(skillDir, { recursive: true })
  await fs.mkdir(path.join(skillDir, 'scripts'), { recursive: true })
  await fs.mkdir(path.join(skillDir, 'references'), { recursive: true })
  await fs.mkdir(path.join(skillDir, 'assets'), { recursive: true })

  const description = String(params.description || '').trim() || `Describe what ${skillName} does and when to use it.`
  const skillMd = buildSkillTemplate(skillName, description)
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillMd, 'utf8')
  await fs.writeFile(path.join(skillDir, 'references', 'README.md'), buildReferenceTemplate(skillName), 'utf8')

  const skill = parseSkillFile(path.join(skillDir, 'SKILL.md'))
  return { skillDir, skill }
}

export async function validateSkillDir(inputDir: string): Promise<SkillValidationResult> {
  const dirPath = resolveAuthoringPath(inputDir)
  const errors: string[] = []
  const warnings: string[] = []

  const stats = await safeStat(dirPath)
  if (!stats || !stats.isDirectory()) {
    return {
      valid: false,
      errors: [`Skill directory does not exist: ${dirPath}`],
      warnings,
    }
  }

  const skillMdPath = path.join(dirPath, 'SKILL.md')
  const skillMdStats = await safeStat(skillMdPath)
  if (!skillMdStats || !skillMdStats.isFile()) {
    return {
      valid: false,
      errors: [`Missing SKILL.md: ${skillMdPath}`],
      warnings,
    }
  }

  const content = await fs.readFile(skillMdPath, 'utf8')
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) {
    return {
      valid: false,
      errors: [`Invalid SKILL.md frontmatter format: ${skillMdPath}`],
      warnings,
    }
  }

  const frontmatter = match[1] || ''
  const name = String(extractYamlField(frontmatter, 'name') || '').trim()
  const description = String(extractYamlField(frontmatter, 'description') || '').trim()

  if (!name) {
    errors.push('Missing required frontmatter field: name')
  } else if (!SKILL_NAME_PATTERN.test(name)) {
    errors.push('Skill name must match ^[a-z0-9-]+$')
  }

  if (!description) {
    errors.push('Missing required frontmatter field: description')
  } else {
    if (description.length > 1024) {
      errors.push('Skill description must be 1024 characters or fewer')
    }
    if (description.includes('\n')) {
      errors.push('Skill description must be a single logical string')
    }
  }

  const body = (match[2] || '').trim()
  if (!body) {
    warnings.push('SKILL.md body is empty')
  }

  const todoMatches = await scanTodoMarkers(dirPath)
  warnings.push(...todoMatches)

  const skill = errors.length === 0
    ? parseSkillFile(skillMdPath)
    : undefined

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    ...(skill
      ? {
          skill: {
            name: skill.name,
            description: skill.description,
            dirPath: skill.dirPath,
          },
        }
      : {}),
  }
}

export function normalizeSkillName(value: string): string {
  const skillName = value.trim().toLowerCase()
  if (!skillName) {
    throw new Error('skill name is required')
  }
  if (!SKILL_NAME_PATTERN.test(skillName)) {
    throw new Error('skill name must use lowercase letters, digits, and hyphens only')
  }
  return skillName
}

export function resolveAuthoringPath(inputPath: string): string {
  const value = String(inputPath || '').trim()
  if (!value) {
    throw new Error('path is required')
  }
  return path.resolve(expandHomePath(value))
}

function buildSkillTemplate(skillName: string, description: string): string {
  const title = skillName
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')

  return [
    '---',
    `name: ${skillName}`,
    `description: ${description}`,
    '---',
    '',
    `# ${title}`,
    '',
    '## Overview',
    '',
    '- Explain what this skill does.',
    '- Explain when to activate it.',
    '- Keep this file concise and move detailed material into `references/`.',
    '',
    '## Workflow',
    '',
    '1. Assess the user request and confirm this skill is relevant.',
    '2. Read only the specific reference files you need.',
    '3. Use bundled scripts or assets when they improve reliability.',
    '',
    '## References',
    '',
    '- Add links to files under `references/` when you create them.',
    '',
  ].join('\n')
}

function buildReferenceTemplate(skillName: string): string {
  return [
    `# ${skillName} references`,
    '',
    'Add detailed examples, API notes, schemas, or workflow details here.',
  ].join('\n')
}

async function scanTodoMarkers(rootDir: string): Promise<string[]> {
  const warnings: string[] = []

  async function visit(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      if (shouldSkip(entry.name)) {
        continue
      }

      const fullPath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        await visit(fullPath)
        continue
      }

      if (!entry.isFile()) {
        continue
      }

      const content = await fs.readFile(fullPath, 'utf8').catch(() => '')
      if (TODO_PATTERN.test(content)) {
        warnings.push(`TODO marker found in ${fullPath}`)
      }
    }
  }

  await visit(rootDir)
  return warnings
}

function shouldSkip(name: string): boolean {
  return name === '.git' || name === 'node_modules' || name === '__pycache__'
}

async function pathExists(targetPath: string): Promise<boolean> {
  return Boolean(await safeStat(targetPath))
}

async function safeStat(targetPath: string) {
  try {
    return await fs.stat(targetPath)
  } catch {
    return null
  }
}
