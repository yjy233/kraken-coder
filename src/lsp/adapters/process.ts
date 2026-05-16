import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { detectLspLanguage } from '../languages'
import { fromZeroBasedRange, toZeroBasedPosition } from '../positions'
import type {
  LspDefinitionRequest,
  LspDocumentSymbol,
  LspDocumentSymbolsRequest,
  LspHostAdapter,
  LspHoverResult,
  LspLanguage,
  LspLocation,
  LspReferencesRequest,
  LspReference,
  LspTextDocumentPositionRequest,
  LspWorkspaceSymbol,
  LspWorkspaceSymbolsRequest,
} from '../types'

export interface ProcessLspLanguageConfig {
  command: string
  args: string[]
}

export interface ProcessLspAdapterOptions {
  commands?: Partial<Record<LspLanguage, ProcessLspLanguageConfig>>
  initializationOptions?: Partial<Record<LspLanguage, Record<string, unknown>>>
  idleTimeoutMs?: number | undefined
}

export class ProcessLspAdapter implements LspHostAdapter {
  readonly kind = 'process' as const
  private readonly sessions = new Map<string, ProcessLspSession>()

  constructor(private readonly options: ProcessLspAdapterOptions = {}) {}

  async initializeWorkspace(workspaceRoot: string, language: LspLanguage): Promise<void> {
    await this.getSession(workspaceRoot, language).initialize()
  }

  async hover(request: LspTextDocumentPositionRequest): Promise<LspHoverResult> {
    const session = await this.getInitializedSession(request.workspaceRoot, request.language)
    await session.syncDocument(request.path)
    const result = await session.request<Record<string, unknown> | null>('textDocument/hover', {
      textDocument: textDocumentIdentifier(request.workspaceRoot, request.path),
      position: toZeroBasedPosition(request.position),
    })
    return { contents: normalizeHoverContents(result?.contents) }
  }

  async definition(request: LspDefinitionRequest): Promise<LspLocation[]> {
    const session = await this.getInitializedSession(request.workspaceRoot, request.language)
    await session.syncDocument(request.path)
    const method = definitionMethod(request.kind)
    const result = await session.request<unknown>(method, {
      textDocument: textDocumentIdentifier(request.workspaceRoot, request.path),
      position: toZeroBasedPosition(request.position),
    })
    return normalizeLocations(result)
  }

  async references(request: LspReferencesRequest): Promise<LspReference[]> {
    const session = await this.getInitializedSession(request.workspaceRoot, request.language)
    await session.syncDocument(request.path)
    const result = await session.request<unknown>('textDocument/references', {
      textDocument: textDocumentIdentifier(request.workspaceRoot, request.path),
      position: toZeroBasedPosition(request.position),
      context: { includeDeclaration: request.includeDeclaration },
    })
    return normalizeLocations(result)
  }

  async documentSymbols(request: LspDocumentSymbolsRequest): Promise<LspDocumentSymbol[]> {
    const session = await this.getInitializedSession(request.workspaceRoot, request.language)
    await session.syncDocument(request.path)
    const result = await session.request<unknown>('textDocument/documentSymbol', {
      textDocument: textDocumentIdentifier(request.workspaceRoot, request.path),
    })
    return normalizeDocumentSymbols(result)
  }

  async workspaceSymbols(request: LspWorkspaceSymbolsRequest): Promise<LspWorkspaceSymbol[]> {
    const languages = request.language ? [request.language] : (['typescript', 'go', 'python'] as LspLanguage[])
    const results: LspWorkspaceSymbol[] = []
    for (const language of languages) {
      const session = await this.getInitializedSession(request.workspaceRoot, language)
      const result = await session.request<unknown>('workspace/symbol', { query: request.query })
      results.push(...normalizeWorkspaceSymbols(result, language))
    }
    return results
  }

  async dispose(): Promise<void> {
    await Promise.all(Array.from(this.sessions.values()).map((session) => session.dispose()))
    this.sessions.clear()
  }

  private async getInitializedSession(workspaceRoot: string, language: LspLanguage): Promise<ProcessLspSession> {
    const session = this.getSession(workspaceRoot, language)
    await session.initialize()
    return session
  }

  private getSession(workspaceRoot: string, language: LspLanguage): ProcessLspSession {
    const normalizedRoot = path.resolve(workspaceRoot)
    const key = `${normalizedRoot}:${language}`
    const existing = this.sessions.get(key)
    if (existing) {
      return existing
    }
    const command = this.options.commands?.[language] ?? defaultLanguageServerCommand(language)
    const session = new ProcessLspSession({
      workspaceRoot: normalizedRoot,
      language,
      command,
      initializationOptions: this.options.initializationOptions?.[language],
      idleTimeoutMs: this.options.idleTimeoutMs,
    })
    this.sessions.set(key, session)
    return session
  }
}

class ProcessLspSession {
  private process?: ChildProcessWithoutNullStreams
  private nextId = 1
  private buffer = Buffer.alloc(0)
  private initialized = false
  private idleTimer?: NodeJS.Timeout
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  }>()
  private readonly syncedDocuments = new Map<string, { version: number; mtimeMs: number }>()

  constructor(private readonly options: {
    workspaceRoot: string
    language: LspLanguage
    command: ProcessLspLanguageConfig
    initializationOptions?: Record<string, unknown> | undefined
    idleTimeoutMs?: number | undefined
  }) {}

  async initialize(): Promise<void> {
    if (this.initialized) {
      this.bumpIdleTimer()
      return
    }
    this.start()
    await this.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(this.options.workspaceRoot).toString(),
      workspaceFolders: [{
        uri: pathToFileURL(this.options.workspaceRoot).toString(),
        name: path.basename(this.options.workspaceRoot),
      }],
      capabilities: {
        textDocument: {
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { linkSupport: true },
          declaration: { linkSupport: true },
          typeDefinition: { linkSupport: true },
          implementation: { linkSupport: true },
          references: {},
          documentSymbol: {
            hierarchicalDocumentSymbolSupport: true,
            symbolKind: { valueSet: Array.from({ length: 26 }, (_value, index) => index + 1) },
          },
        },
        workspace: {
          symbol: {
            symbolKind: { valueSet: Array.from({ length: 26 }, (_value, index) => index + 1) },
          },
          workspaceFolders: true,
        },
      },
      initializationOptions: this.options.initializationOptions ?? {},
    })
    this.notify('initialized', {})
    this.initialized = true
    this.bumpIdleTimer()
  }

  async syncDocument(displayPath: string): Promise<void> {
    this.bumpIdleTimer()
    const absolutePath = path.isAbsolute(displayPath)
      ? displayPath
      : path.resolve(this.options.workspaceRoot, displayPath)
    const stat = await fs.stat(absolutePath)
    const uri = pathToFileURL(absolutePath).toString()
    const existing = this.syncedDocuments.get(uri)
    if (!existing) {
      const text = await fs.readFile(absolutePath, 'utf8')
      this.notify('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: languageId(this.options.language),
          version: 1,
          text,
        },
      })
      this.syncedDocuments.set(uri, { version: 1, mtimeMs: stat.mtimeMs })
      return
    }

    if (existing.mtimeMs !== stat.mtimeMs) {
      const version = existing.version + 1
      const text = await fs.readFile(absolutePath, 'utf8')
      this.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      })
      this.syncedDocuments.set(uri, { version, mtimeMs: stat.mtimeMs })
    }
  }

  request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.start()
    this.bumpIdleTimer()
    const id = this.nextId++
    const payload = { jsonrpc: '2.0', id, method, params }
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      })
    })
    this.write(payload)
    return promise
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.start()
    this.bumpIdleTimer()
    this.write({ jsonrpc: '2.0', method, params })
  }

  async dispose(): Promise<void> {
    this.clearIdleTimer()
    if (!this.process) {
      return
    }
    try {
      await this.request('shutdown', {})
      this.notify('exit', {})
    } catch {
      // Process may already be gone.
    }
    this.process.kill()
    this.process = undefined
    this.initialized = false
    this.clearIdleTimer()
  }

  private start(): void {
    if (this.process) {
      return
    }
    const child = spawn(this.options.command.command, this.options.command.args, {
      cwd: this.options.workspaceRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk: Buffer) => this.handleData(chunk))
    child.stderr.on('data', () => {
      // Stderr can be noisy for language servers; keep it out of tool output.
    })
    child.on('error', (error) => {
      for (const pending of this.pending.values()) {
        pending.reject(error)
      }
      this.pending.clear()
      this.initialized = false
      this.process = undefined
      this.clearIdleTimer()
    })
    child.on('exit', () => {
      const error = new Error(`${this.options.language} language server exited`)
      for (const pending of this.pending.values()) {
        pending.reject(error)
      }
      this.pending.clear()
      this.initialized = false
      this.process = undefined
      this.clearIdleTimer()
    })
    this.process = child
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])

    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) {
        return
      }
      const header = this.buffer.slice(0, headerEnd).toString('utf8')
      const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/i)
      if (!contentLengthMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4)
        continue
      }
      const contentLength = Number(contentLengthMatch[1])
      const messageStart = headerEnd + 4
      const messageEnd = messageStart + contentLength
      if (this.buffer.length < messageEnd) {
        return
      }
      const body = this.buffer.slice(messageStart, messageEnd).toString('utf8')
      this.buffer = this.buffer.slice(messageEnd)
      this.handleMessage(body)
    }
  }

  private handleMessage(body: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(body) as Record<string, unknown>
    } catch {
      return
    }
    if (typeof message.id !== 'number') {
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) {
      return
    }
    this.pending.delete(message.id)
    if (message.error && typeof message.error === 'object') {
      const errorRecord = message.error as { message?: unknown }
      pending.reject(new Error(String(errorRecord.message || 'LSP request failed')))
      return
    }
    pending.resolve(message.result)
  }

  private write(payload: Record<string, unknown>): void {
    if (!this.process) {
      throw new Error('language server is not running')
    }
    const body = JSON.stringify(payload)
    const ok = this.process.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`)
    if (!ok && this.process.exitCode !== null) {
      throw new Error(`${this.options.language} language server is not writable`)
    }
  }

  private bumpIdleTimer(): void {
    this.clearIdleTimer()
    const idleTimeout = Math.max(5000, Math.floor(this.options.idleTimeoutMs ?? 30000))
    this.idleTimer = setTimeout(() => {
      this.dispose().catch(() => {
        if (this.process) {
          this.process.kill()
          this.process = undefined
          this.initialized = false
        }
      })
    }, idleTimeout)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
  }
}

function defaultLanguageServerCommand(language: LspLanguage): ProcessLspLanguageConfig {
  if (language === 'typescript') {
    return { command: 'typescript-language-server', args: ['--stdio'] }
  }
  if (language === 'go') {
    return { command: 'gopls', args: [] }
  }
  return { command: 'pyright-langserver', args: ['--stdio'] }
}

function languageId(language: LspLanguage): string {
  return language === 'typescript' ? 'typescript' : language
}

function definitionMethod(kind: LspDefinitionRequest['kind']): string {
  if (kind === 'declaration') return 'textDocument/declaration'
  if (kind === 'type_definition') return 'textDocument/typeDefinition'
  if (kind === 'implementation') return 'textDocument/implementation'
  return 'textDocument/definition'
}

function textDocumentIdentifier(workspaceRoot: string, displayPath: string): { uri: string } {
  const absolutePath = path.isAbsolute(displayPath) ? displayPath : path.resolve(workspaceRoot, displayPath)
  return { uri: pathToFileURL(absolutePath).toString() }
}

function normalizeHoverContents(contents: unknown): string[] {
  if (!contents) return []
  if (typeof contents === 'string') return [contents]
  if (Array.isArray(contents)) return contents.flatMap(normalizeHoverContents)
  if (typeof contents === 'object') {
    const record = contents as Record<string, unknown>
    if (typeof record.value === 'string') return [record.value]
    if (typeof record.language === 'string' && typeof record.value === 'string') return [record.value]
  }
  return []
}

function normalizeLocations(value: unknown): LspLocation[] {
  const items = Array.isArray(value) ? value : value ? [value] : []
  return items.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const targetUri = typeof record.targetUri === 'string' ? record.targetUri : undefined
    const uri = typeof record.uri === 'string' ? record.uri : targetUri
    const range = normalizeRange(record.range ?? record.targetSelectionRange ?? record.targetRange)
    if (!uri || !range) return []
    return [{ path: uriToPath(uri), range }]
  })
}

function normalizeDocumentSymbols(value: unknown): LspDocumentSymbol[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => normalizeDocumentSymbol(item))
}

function normalizeDocumentSymbol(item: unknown): LspDocumentSymbol[] {
  if (!item || typeof item !== 'object') return []
  const record = item as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name : ''
  const kind = symbolKindName(Number(record.kind || 0))
  const range = normalizeRange(record.range ?? record.locationRange)
  const selectionRange = normalizeRange(record.selectionRange ?? record.range)
  if (!name || !range || !selectionRange) {
    return []
  }
  const children = normalizeDocumentSymbols(record.children)
  return [{
    name,
    kind,
    range,
    selectionRange,
    ...(children.length ? { children } : {}),
  }]
}

function normalizeWorkspaceSymbols(value: unknown, language: LspLanguage): LspWorkspaceSymbol[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const location = record.location
    if (!location || typeof location !== 'object') return []
    const locationRecord = location as Record<string, unknown>
    const uri = typeof locationRecord.uri === 'string' ? locationRecord.uri : ''
    const range = normalizeRange(locationRecord.range)
    if (!uri || !range) return []
    const filePath = uriToPath(uri)
    if (detectLspLanguage(filePath) !== language) return []
    return [{
      name: String(record.name || ''),
      kind: symbolKindName(Number(record.kind || 0)),
      containerName: typeof record.containerName === 'string' ? record.containerName : undefined,
      path: filePath,
      range,
      language,
    }]
  }).filter((symbol) => symbol.name)
}

function normalizeRange(value: unknown) {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const start = normalizeProtocolPosition(record.start)
  const end = normalizeProtocolPosition(record.end)
  if (!start || !end) return undefined
  return fromZeroBasedRange({ start, end })
}

function normalizeProtocolPosition(value: unknown) {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const line = Number(record.line)
  const character = Number(record.character)
  if (!Number.isFinite(line) || !Number.isFinite(character)) return undefined
  return { line, character }
}

function uriToPath(uri: string): string {
  try {
    return fileURLToPath(uri)
  } catch {
    return uri
  }
}

function symbolKindName(kind: number): string {
  return [
    'unknown',
    'file',
    'module',
    'namespace',
    'package',
    'class',
    'method',
    'property',
    'field',
    'constructor',
    'enum',
    'interface',
    'function',
    'variable',
    'constant',
    'string',
    'number',
    'boolean',
    'array',
    'object',
    'key',
    'null',
    'enumMember',
    'struct',
    'event',
    'operator',
    'typeParameter',
  ][kind] || 'unknown'
}
