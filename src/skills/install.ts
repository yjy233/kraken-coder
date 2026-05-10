import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { parseSkillFile } from './registry.js'
import type { Skill } from './types.js'
import { getDefaultSkillInstallRoot, resolveSkillInstallRoot } from './paths.js'

const GITHUB_ARCHIVE_REF = 'main'
const CLAWHUB_DOWNLOAD_BASE_URL = 'https://wry-manatee-359.convex.site/api/v1/download?slug='

export interface InstallSkillParams {
  repo?: string
  skillPath?: string
  clawhubSlug?: string
  ref?: string
  installRoot?: string
  force?: boolean
}

export interface InstalledSkillResult {
  skill: Skill
  installDir: string
}

export async function installSkillFromGitHub(params: InstallSkillParams): Promise<InstalledSkillResult> {
  const repo = normalizeRepo(requireString(params.repo, 'repo is required for github installs'))
  const skillPath = normalizeRemoteSkillPath(requireString(params.skillPath, 'path is required for github installs'))
  const ref = params.ref?.trim() || GITHUB_ARCHIVE_REF
  const installRoot = resolveSkillInstallRoot(params.installRoot)

  await fs.mkdir(installRoot, { recursive: true })

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kraken-skill-'))
  try {
    const archiveUrl = `https://codeload.github.com/${repo}/tar.gz/refs/heads/${encodeURIComponent(ref)}`
    const archivePath = path.join(tmpRoot, 'archive.tar.gz')
    await downloadFile(archiveUrl, archivePath, 'skill archive')

    const extractDir = path.join(tmpRoot, 'extract')
    await fs.mkdir(extractDir, { recursive: true })
    await extractTarGz(archivePath, extractDir)

    const repoRoot = path.join(extractDir, `${repo.split('/')[1]}-${ref}`)
    const sourceDir = path.join(repoRoot, skillPath)
    return installExtractedSkill({
      sourceDir,
      installRoot,
      force: Boolean(params.force),
    })
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true })
  }
}

export async function installSkillFromClawHub(params: InstallSkillParams): Promise<InstalledSkillResult> {
  const installRoot = resolveSkillInstallRoot(params.installRoot)
  const slugCandidates = buildClawHubSlugCandidates(params.clawhubSlug)

  await fs.mkdir(installRoot, { recursive: true })

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kraken-skill-'))
  try {
    const archivePath = path.join(tmpRoot, 'archive.zip')
    let lastError: Error | null = null

    for (const slug of slugCandidates) {
      try {
        await downloadFile(`${CLAWHUB_DOWNLOAD_BASE_URL}${encodeURIComponent(slug)}`, archivePath, 'ClawHub skill archive')
        const extractDir = path.join(tmpRoot, 'extract')
        await fs.rm(extractDir, { recursive: true, force: true })
        await fs.mkdir(extractDir, { recursive: true })
        await extractZip(archivePath, extractDir)
        const sourceDir = await findSkillSourceDir(extractDir)
        return await installExtractedSkill({
          sourceDir,
          installRoot,
          force: Boolean(params.force),
        })
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (!isMissingArchiveError(lastError)) {
          throw lastError
        }
      }
    }

    throw lastError || new Error('Failed to download ClawHub skill archive')
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true })
  }
}

async function downloadFile(url: string, filePath: string, label: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download ${label}: ${response.status} ${response.statusText}`)
  }

  const archiveBuffer = Buffer.from(await response.arrayBuffer())
  await fs.writeFile(filePath, archiveBuffer)
}

async function extractTarGz(archivePath: string, extractDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xzf', archivePath, '-C', extractDir], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })

    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(stderr.trim() || `Failed to extract archive: exit ${code ?? -1}`))
    })
  })
}

async function extractZip(archivePath: string, extractDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('unzip', ['-q', archivePath, '-d', extractDir], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })

    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(stderr.trim() || `Failed to extract archive: exit ${code ?? -1}`))
    })
  })
}

async function copyDirectory(sourceDir: string, targetDir: string): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true })
  const entries = await fs.readdir(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name)
    const targetPath = path.join(targetDir, entry.name)
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, targetPath)
      continue
    }
    if (entry.isFile()) {
      await fs.copyFile(sourcePath, targetPath)
    }
  }
}

export async function installSkillFromLocalDir(params: {
  sourceDir: string
  installRoot?: string
  force?: boolean
}): Promise<InstalledSkillResult> {
  const sourceDir = path.resolve(params.sourceDir)
  const installRoot = resolveSkillInstallRoot(params.installRoot)

  return installExtractedSkill({
    sourceDir,
    installRoot,
    force: Boolean(params.force),
  })
}

export async function linkSkillFromLocalDir(params: {
  sourceDir: string
  installRoot?: string
  force?: boolean
}): Promise<InstalledSkillResult> {
  const sourceDir = path.resolve(params.sourceDir)
  const installRoot = resolveSkillInstallRoot(params.installRoot)
  const skill = await parseSkillFile(path.join(sourceDir, 'SKILL.md'))
  const installDir = path.join(installRoot, skill.name)

  await fs.mkdir(installRoot, { recursive: true })

  if (await pathExists(installDir)) {
    if (!params.force) {
      throw new Error(`Skill already exists: ${installDir}`)
    }
    await fs.rm(installDir, { recursive: true, force: true })
  }

  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await fs.symlink(sourceDir, installDir, linkType)

  const installedSkill = await parseSkillFile(path.join(installDir, 'SKILL.md'))
  return {
    skill: installedSkill,
    installDir,
  }
}

async function installExtractedSkill(params: {
  sourceDir: string
  installRoot: string
  force: boolean
}): Promise<InstalledSkillResult> {
  const skillMdPath = path.join(params.sourceDir, 'SKILL.md')
  const skill = await parseSkillFile(skillMdPath)

  const installDir = path.join(params.installRoot, skill.name)
  if (await pathExists(installDir)) {
    if (!params.force) {
      throw new Error(`Skill already exists: ${installDir}`)
    }
    await fs.rm(installDir, { recursive: true, force: true })
  }

  await copyDirectory(params.sourceDir, installDir)
  const installedSkill = await parseSkillFile(path.join(installDir, 'SKILL.md'))
  return {
    skill: installedSkill,
    installDir,
  }
}

async function findSkillSourceDir(rootDir: string): Promise<string> {
  const directSkillMdPath = path.join(rootDir, 'SKILL.md')
  if (await pathExists(directSkillMdPath)) {
    return rootDir
  }

  const matches = await collectSkillRoots(rootDir, 0, 4)
  if (matches.length === 0) {
    throw new Error('Downloaded archive does not contain a SKILL.md file')
  }
  if (matches.length > 1) {
    throw new Error('Downloaded archive contains multiple skill roots; refusing to guess')
  }
  const match = matches[0]
  if (!match) {
    throw new Error('Downloaded archive does not contain a skill root')
  }
  return match
}

async function collectSkillRoots(currentDir: string, depth: number, maxDepth: number): Promise<string[]> {
  if (depth > maxDepth) {
    return []
  }

  const skillMdPath = path.join(currentDir, 'SKILL.md')
  if (await pathExists(skillMdPath)) {
    return [currentDir]
  }

  const matches: string[] = []
  const entries = await fs.readdir(currentDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    const nestedMatches = await collectSkillRoots(path.join(currentDir, entry.name), depth + 1, maxDepth)
    matches.push(...nestedMatches)
  }

  return matches
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

function normalizeRepo(repo: string): string {
  const value = repo.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, '')
  if (!/^[^/]+\/[^/]+$/.test(value)) {
    throw new Error('repo must be in the form owner/name')
  }
  return value
}

function normalizeRemoteSkillPath(skillPath: string): string {
  const value = skillPath.trim().replace(/^\/+/, '').replace(/\/+$/, '')
  if (!value || value.includes('..')) {
    throw new Error('skill path is invalid')
  }
  return value
}

function buildClawHubSlugCandidates(rawInput: string | undefined): string[] {
  const value = String(rawInput || '').trim()
  if (!value) {
    throw new Error('clawhub slug is required')
  }

  const candidates = new Set<string>()
  const add = (candidate: string) => {
    const normalized = candidate.trim().replace(/^\/+/, '').replace(/\/+$/, '')
    if (normalized) {
      candidates.add(normalized)
    }
  }

  if (/^https?:\/\//i.test(value)) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new Error('invalid ClawHub URL')
    }
    const segments = url.pathname.split('/').map((segment) => segment.trim()).filter(Boolean)
    if (segments.length === 0) {
      throw new Error('invalid ClawHub URL path')
    }
    if (segments.length >= 2) {
      add(`${segments[segments.length - 2]}/${segments[segments.length - 1]}`)
    }
    add(segments[segments.length - 1] || '')
    return Array.from(candidates)
  }

  add(value)
  if (value.includes('/')) {
    const segments = value.split('/').map((segment) => segment.trim()).filter(Boolean)
    add(segments[segments.length - 1] || '')
  }
  return Array.from(candidates)
}

function isMissingArchiveError(error: Error): boolean {
  return error.message.includes('404')
}

function requireString(value: string | undefined, errorMessage: string): string {
  if (!value) {
    throw new Error(errorMessage)
  }
  return value
}
