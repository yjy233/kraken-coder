import { promises as fs } from 'node:fs'
import path from 'node:path'
import { clampInteger, truncate } from '../utils/helpers'
import { detectLspLanguage } from './languages'
import { normalizeAgentPosition } from './positions'
import type {
  LspDefinitionRequest,
  LspDocumentSymbol,
  LspHostAdapter,
  LspLanguage,
  LspLocation,
  LspReference,
  LspToolConfig,
  LspWorkspaceSymbol,
} from './types'

export interface LspServiceOptions {
  workspaceRoot: string
  adapter: LspHostAdapter
  config: LspToolConfig
}

export class LspService {
  constructor(private readonly options: LspServiceOptions) {}

  async hover(input: Record<string, unknown>): Promise<string> {
    const target = await this.resolveTarget(input)
    const position = await this.resolvePosition(target.absolutePath, input.line, input.character)
    await this.initialize(target.language)
    const result = await withTimeout(
      this.options.adapter.hover({
        workspaceRoot: this.options.workspaceRoot,
        path: target.displayPath,
        language: target.language,
        position,
      }),
      this.options.config.timeoutMs
    )
    const hoverMaxChars = Math.max(0, this.options.config.hoverMaxChars)
    const contents = result.contents
      .map(sanitizeMarkdown)
      .filter(Boolean)
      .slice(0, 5)
      .map((item) => hoverMaxChars > 0 ? truncate(item, Math.min(1200, hoverMaxChars)) : item)

    return stringify({
      language: target.language,
      path: target.displayPath,
      position,
      contents,
      ...(contents.length ? {} : { message: 'No hover returned by the language server. Try read_file fallback.' }),
    })
  }

  async definition(input: Record<string, unknown>): Promise<string> {
    const target = await this.resolveTarget(input)
    const position = await this.resolvePosition(target.absolutePath, input.line, input.character)
    const kind = normalizeDefinitionKind(input.kind)
    const maxResults = clampInteger(input.max_results, this.options.config.maxResults, 1, 200)
    await this.initialize(target.language)
    const locations = await withTimeout(
      this.options.adapter.definition({
        workspaceRoot: this.options.workspaceRoot,
        path: target.displayPath,
        language: target.language,
        position,
        kind,
      }),
      this.options.config.timeoutMs
    )
    const normalized = await this.withPreviews(locations.slice(0, maxResults))

    return stringify({
      language: target.language,
      query: {
        path: target.displayPath,
        line: position.line,
        character: position.character,
        kind,
      },
      locations: normalized,
      truncated: locations.length > maxResults,
      ...(locations.length ? {} : { message: `No ${kind} returned by the language server. Try grep/read_file fallback.` }),
    })
  }

  async references(input: Record<string, unknown>): Promise<string> {
    const target = await this.resolveTarget(input)
    const position = await this.resolvePosition(target.absolutePath, input.line, input.character)
    const includeDeclaration = input.include_declaration === true
    const maxResults = clampInteger(input.max_results, this.options.config.maxResults, 1, 200)
    await this.initialize(target.language)
    const references = await withTimeout(
      this.options.adapter.references({
        workspaceRoot: this.options.workspaceRoot,
        path: target.displayPath,
        language: target.language,
        position,
        includeDeclaration,
      }),
      this.options.config.timeoutMs
    )
    const normalized = await this.withReferencePreviews(references.slice(0, maxResults))

    return stringify({
      language: target.language,
      query: {
        path: target.displayPath,
        line: position.line,
        character: position.character,
        includeDeclaration,
      },
      references: normalized,
      truncated: references.length > maxResults,
      ...(references.length ? {} : { message: 'No references returned by the language server. Try grep/read_file fallback.' }),
    })
  }

  async documentSymbols(input: Record<string, unknown>): Promise<string> {
    const target = await this.resolveTarget(input)
    const maxDepth = clampInteger(input.max_depth, 4, 1, 20)
    await this.initialize(target.language)
    const symbols = await withTimeout(
      this.options.adapter.documentSymbols({
        workspaceRoot: this.options.workspaceRoot,
        path: target.displayPath,
        language: target.language,
      }),
      this.options.config.timeoutMs
    )

    return stringify({
      language: target.language,
      path: target.displayPath,
      symbols: trimDocumentSymbols(symbols, maxDepth),
      ...(symbols.length ? {} : { message: 'No document symbols returned by the language server. Try read_file fallback.' }),
    })
  }

  async workspaceSymbols(input: Record<string, unknown>): Promise<string> {
    const query = String(input.query || '').trim()
    if (!query) {
      throw new Error('query is required')
    }
    const language = normalizeOptionalLanguage(input.language)
    if (language && !this.options.config.languages.includes(language)) {
      throw new Error(`LSP language is disabled: ${language}`)
    }
    const maxResults = clampInteger(input.max_results, this.options.config.maxResults, 1, 200)
    const languages = language ? [language] : this.options.config.languages
    const collected: LspWorkspaceSymbol[] = []

    for (const currentLanguage of languages) {
      await this.initialize(currentLanguage)
      const symbols = await withTimeout(
        this.options.adapter.workspaceSymbols({
          workspaceRoot: this.options.workspaceRoot,
          query,
          language: currentLanguage,
        }),
        this.options.config.timeoutMs
      )
      collected.push(...symbols.map((symbol) => ({ ...symbol, language: symbol.language ?? currentLanguage })))
    }

    const filtered = language
      ? collected.filter((symbol) => symbol.language === language || languageMatchesDisplayPath(language, symbol.path))
      : collected
    const symbols = filtered.slice(0, maxResults)

    return stringify({
      query,
      ...(language ? { language } : {}),
      symbols,
      truncated: filtered.length > maxResults,
      ...(filtered.length ? {} : { message: 'No workspace symbols returned by the language server. Try grep/glob fallback.' }),
    })
  }

  private async initialize(language: LspLanguage): Promise<void> {
    await withTimeout(
      this.options.adapter.initializeWorkspace(this.options.workspaceRoot, language),
      this.options.config.timeoutMs
    )
  }

  private async resolveTarget(input: Record<string, unknown>): Promise<ResolvedLspTarget> {
    const rawPath = String(input.path || '').trim()
    if (!rawPath) {
      throw new Error('path is required')
    }

    const absolutePath = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(this.options.workspaceRoot, rawPath)
    const realWorkspaceRoot = await fs.realpath(this.options.workspaceRoot)
    const realPath = await fs.realpath(absolutePath)
    if (!isWithinRoot(realWorkspaceRoot, realPath)) {
      throw new Error(`path is outside the workspace: ${rawPath}`)
    }

    const language = detectLspLanguage(realPath)
    if (!language) {
      throw new Error(`Unsupported LSP language for file: ${toDisplayPath(realWorkspaceRoot, realPath)}`)
    }
    if (!this.options.config.languages.includes(language)) {
      throw new Error(`LSP language is disabled: ${language}`)
    }

    return {
      absolutePath: realPath,
      displayPath: toDisplayPath(realWorkspaceRoot, realPath),
      language,
    }
  }

  private async resolvePosition(filePath: string, line: unknown, character: unknown) {
    const position = normalizeAgentPosition(line, character)
    const content = await fs.readFile(filePath, 'utf8')
    const lines = content.split(/\r?\n/)
    if (position.line > Math.max(1, lines.length)) {
      throw new Error(`line is out of range: ${position.line}`)
    }
    const lineText = lines[position.line - 1] ?? ''
    if (position.character > lineText.length + 1) {
      throw new Error(`character is out of range: ${position.character}`)
    }
    return position
  }

  private async withPreviews(locations: LspLocation[]): Promise<Array<LspLocation & { preview?: string }>> {
    return Promise.all(locations.map(async (location) => {
      const preview = await this.buildPreview(location.path, location.range.start.line)
      return {
        ...location,
        path: this.normalizeOutputPath(location.path),
        ...(preview ? { preview } : {}),
      }
    }))
  }

  private async withReferencePreviews(references: LspReference[]): Promise<Array<{
    path: string
    line: number
    character: number
    preview?: string
  }>> {
    return Promise.all(references.map(async (reference) => {
      const preview = await this.buildPreview(reference.path, reference.range.start.line)
      return {
        path: this.normalizeOutputPath(reference.path),
        line: reference.range.start.line,
        character: reference.range.start.character,
        ...(preview ? { preview } : {}),
      }
    }))
  }

  private async buildPreview(displayOrAbsolutePath: string, line: number): Promise<string | undefined> {
    const absolutePath = path.isAbsolute(displayOrAbsolutePath)
      ? displayOrAbsolutePath
      : path.resolve(this.options.workspaceRoot, displayOrAbsolutePath)
    if (!isWithinRoot(this.options.workspaceRoot, absolutePath)) {
      return undefined
    }
    try {
      const raw = await fs.readFile(absolutePath, 'utf8')
      const lines = raw.split(/\r?\n/)
      const start = Math.max(1, line - 1)
      const end = Math.min(lines.length, line + 1)
      return lines
        .slice(start - 1, end)
        .map((text, index) => `${start + index} | ${text}`)
        .join('\n')
    } catch {
      return undefined
    }
  }

  private normalizeOutputPath(displayOrAbsolutePath: string): string {
    const absolutePath = path.isAbsolute(displayOrAbsolutePath)
      ? displayOrAbsolutePath
      : path.resolve(this.options.workspaceRoot, displayOrAbsolutePath)
    return toDisplayPath(this.options.workspaceRoot, absolutePath)
  }
}

interface ResolvedLspTarget {
  absolutePath: string
  displayPath: string
  language: LspLanguage
}

function normalizeDefinitionKind(value: unknown): LspDefinitionRequest['kind'] {
  if (value === 'declaration' || value === 'type_definition' || value === 'implementation') {
    return value
  }
  return 'definition'
}

function normalizeOptionalLanguage(value: unknown): LspLanguage | undefined {
  if (value === 'typescript' || value === 'go' || value === 'python') {
    return value
  }
  if (typeof value === 'string' && value.trim()) {
    throw new Error(`Unsupported LSP language: ${value}`)
  }
  return undefined
}

function trimDocumentSymbols(symbols: LspDocumentSymbol[], maxDepth: number, depth = 1): LspDocumentSymbol[] {
  if (depth > maxDepth) {
    return []
  }
  return symbols.map((symbol) => {
    const children = symbol.children ? trimDocumentSymbols(symbol.children, maxDepth, depth + 1) : []
    return {
      name: symbol.name,
      kind: symbol.kind,
      range: symbol.range,
      selectionRange: symbol.selectionRange,
      ...(children.length ? { children } : {}),
    }
  })
}

function languageMatchesDisplayPath(language: LspLanguage, filePath: string): boolean {
  return detectLspLanguage(filePath) === language
}

function sanitizeMarkdown(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\(command:[^)]+\)/g, '$1')
    .replace(/command:[^\s)]+/g, '')
    .trim()
}

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function isWithinRoot(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root)
  const normalizedCandidate = path.resolve(candidate)
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(normalizedRoot + path.sep)
}

function toDisplayPath(workspaceRoot: string, targetPath: string): string {
  const relative = path.relative(workspaceRoot, targetPath)
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : targetPath
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const timeout = Math.max(1000, Math.floor(timeoutMs || 8000))
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`LSP request timed out after ${timeout}ms`)), timeout)
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}
