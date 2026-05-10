/**
 * Skill 注册表
 *
 * 负责按层级扫描 Skill 目录、解析 SKILL.md、管理 Skill 生命周期。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Skill } from './types.js'
import { getSkillDiscoveryDirs } from './paths.js'

/**
 * 按优先级扫描所有 Skill 目录，返回去重后的 Skill 列表。
 * 高优先级目录中的同名 Skill 覆盖低优先级目录中的 Skill。
 */
export function discoverSkills(): Skill[] {
  const skillMap = new Map<string, Skill>()
  const dirs = getSkillDiscoveryDirs()

  for (const dir of [...dirs].reverse()) {
    if (!fs.existsSync(dir)) continue
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const skillPath = path.join(dir, entry.name)
      const skillMdPath = path.join(skillPath, 'SKILL.md')
      if (fs.existsSync(skillMdPath)) {
        try {
          const skill = parseSkillFile(skillMdPath)
          skillMap.set(skill.name, skill)
        } catch {
          // 忽略格式错误的 Skill
        }
      }
    }
  }

  return Array.from(skillMap.values())
}

/** 解析单个 SKILL.md 文件 */
export function parseSkillFile(skillMdPath: string): Skill {
  const content = fs.readFileSync(skillMdPath, 'utf8')
  const dirPath = path.dirname(skillMdPath)

  // 解析 YAML frontmatter: ---\n...\n---\n
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) {
    throw new Error(`Invalid SKILL.md format (missing frontmatter): ${skillMdPath}`)
  }

  const frontmatter = match[1]!
  const body = match[2]!.trim()

  const nameRaw = extractYamlField(frontmatter, 'name')
  const descriptionRaw = extractYamlField(frontmatter, 'description')

  if (!nameRaw || !descriptionRaw) {
    throw new Error(`Missing required fields (name/description) in SKILL.md: ${skillMdPath}`)
  }

  return {
    name: nameRaw.trim(),
    description: descriptionRaw.trim(),
    body,
    dirPath,
  }
}

/** 从 YAML 文本中提取简单字段值，支持 `field: |` 多行块 */
export function extractYamlField(yaml: string, field: string): string | undefined {
  const lines = yaml.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined) continue
    const match = line.match(new RegExp(`^${field}:\\s*(.*)$`))
    if (!match) continue

    const value = match[1]?.trim() || ''
    if (value === '|' || value === '>') {
      const blockLines: string[] = []
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const blockLine = lines[cursor]
        if (blockLine === undefined) continue
        if (!blockLine.startsWith('  ')) {
          break
        }
        blockLines.push(blockLine.slice(2))
      }
      return blockLines.join('\n').trim()
    }

    return value
  }

  return undefined
}

export function describeSkillResources(skill: Skill): string[] {
  const sections = ['scripts', 'references', 'assets']
  const lines = [`Skill root: ${skill.dirPath}`, 'Resources:']
  let hasResources = false

  for (const section of sections) {
    const sectionPath = path.join(skill.dirPath, section)
    if (!fs.existsSync(sectionPath) || !fs.statSync(sectionPath).isDirectory()) {
      continue
    }

    const entries = listResourceEntries(sectionPath, section, 2)
    hasResources = true
    if (entries.length === 0) {
      lines.push(`- ${section}/ (empty)`)
      continue
    }

    lines.push(`- ${section}/`)
    for (const entry of entries) {
      lines.push(`  - ${entry}`)
    }
  }

  if (!hasResources) {
    lines.push('- No bundled resources found.')
  }

  return lines
}

/**
 * 读取指定 Skill 的 reference 文件，仅允许访问其 `references/` 子目录。
 */
export function readSkillReference(skill: Skill, refPath: string): string {
  const normalizedRefPath = refPath.trim().replace(/^\.?\//, '')
  if (!normalizedRefPath || !normalizedRefPath.startsWith('references/')) {
    throw new Error('Skill references must be under references/')
  }

  const referencesRoot = path.join(skill.dirPath, 'references')
  const fullPath = path.resolve(skill.dirPath, normalizedRefPath)
  if (fullPath !== referencesRoot && !fullPath.startsWith(referencesRoot + path.sep)) {
    throw new Error('Skill reference path escapes references/')
  }
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    throw new Error(`Skill reference not found: ${normalizedRefPath}`)
  }

  return fs.readFileSync(fullPath, 'utf8')
}

function listResourceEntries(rootDir: string, prefix: string, maxDepth: number): string[] {
  const entries: string[] = []

  function visit(currentDir: string, depth: number): void {
    if (depth > maxDepth) {
      return
    }

    const dirEntries = fs.readdirSync(currentDir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of dirEntries) {
      const fullPath = path.join(currentDir, entry.name)
      const relative = path.relative(path.dirname(rootDir), fullPath)
      entries.push(entry.isDirectory() ? `${relative}/` : relative)
      if (entry.isDirectory()) {
        visit(fullPath, depth + 1)
      }
    }
  }

  visit(rootDir, 1)
  return entries
}
