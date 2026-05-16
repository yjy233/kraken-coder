import * as path from 'node:path'
import * as vscode from 'vscode'
import { detectLspLanguage } from '../../lsp/languages'
import { fromZeroBasedRange, toZeroBasedPosition } from '../../lsp/positions'
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
} from '../../lsp/types'

export class VSCodeLspAdapter implements LspHostAdapter {
  readonly kind = 'vscode' as const
  private initialized = new Set<string>()

  async initializeWorkspace(workspaceRoot: string, language: LspLanguage): Promise<void> {
    this.initialized.add(`${path.resolve(workspaceRoot)}:${language}`)
  }

  async hover(request: LspTextDocumentPositionRequest): Promise<LspHoverResult> {
    const document = await openDocument(request.workspaceRoot, request.path)
    const result = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      toVscodePosition(request.position)
    )
    return {
      contents: (result || []).flatMap((hover) => hover.contents.flatMap(markedStringToText)),
    }
  }

  async definition(request: LspDefinitionRequest): Promise<LspLocation[]> {
    const document = await openDocument(request.workspaceRoot, request.path)
    const command = definitionCommand(request.kind)
    const result = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
      command,
      document.uri,
      toVscodePosition(request.position)
    )
    return normalizeLocations(result || [])
  }

  async references(request: LspReferencesRequest): Promise<LspReference[]> {
    const document = await openDocument(request.workspaceRoot, request.path)
    const result = await vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeReferenceProvider',
      document.uri,
      toVscodePosition(request.position)
    )
    const references = normalizeLocations(result || [])
    if (request.includeDeclaration) {
      return references
    }
    const definitionLocations = await this.definition({ ...request, kind: 'definition' })
    return references.filter((reference) => !definitionLocations.some((definition) => sameLocation(definition, reference)))
  }

  async documentSymbols(request: LspDocumentSymbolsRequest): Promise<LspDocumentSymbol[]> {
    const document = await openDocument(request.workspaceRoot, request.path)
    const result = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
      'vscode.executeDocumentSymbolProvider',
      document.uri
    )
    return normalizeDocumentSymbols(result || [])
  }

  async workspaceSymbols(request: LspWorkspaceSymbolsRequest): Promise<LspWorkspaceSymbol[]> {
    const result = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      'vscode.executeWorkspaceSymbolProvider',
      request.query
    )
    const symbols = (result || []).flatMap((symbol) => {
      const filePath = symbol.location.uri.fsPath
      const language = detectLspLanguage(filePath)
      if (!language || (request.language && request.language !== language)) {
        return []
      }
      return [{
        name: symbol.name,
        kind: symbolKindName(symbol.kind),
        containerName: symbol.containerName || undefined,
        path: filePath,
        range: fromVscodeRange(symbol.location.range),
        language,
      }]
    })
    return symbols
  }
}

async function openDocument(workspaceRoot: string, displayPath: string): Promise<vscode.TextDocument> {
  const absolutePath = path.isAbsolute(displayPath)
    ? displayPath
    : path.resolve(workspaceRoot, displayPath)
  return vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath))
}

function toVscodePosition(position: { line: number; character: number }): vscode.Position {
  const zeroBased = toZeroBasedPosition(position)
  return new vscode.Position(zeroBased.line, zeroBased.character)
}

function fromVscodeRange(range: vscode.Range) {
  return fromZeroBasedRange({
    start: {
      line: range.start.line,
      character: range.start.character,
    },
    end: {
      line: range.end.line,
      character: range.end.character,
    },
  })
}

function normalizeLocations(items: Array<vscode.Location | vscode.LocationLink>): LspLocation[] {
  return items.flatMap((item) => {
    if (isLocationLink(item)) {
      return [{
        path: item.targetUri.fsPath,
        range: fromVscodeRange(item.targetSelectionRange || item.targetRange),
      }]
    }
    return [{
      path: item.uri.fsPath,
      range: fromVscodeRange(item.range),
    }]
  })
}

function normalizeDocumentSymbols(items: Array<vscode.DocumentSymbol | vscode.SymbolInformation>): LspDocumentSymbol[] {
  return items.flatMap((item) => {
    if (isDocumentSymbol(item)) {
      return [normalizeDocumentSymbol(item)]
    }
    return [{
      name: item.name,
      kind: symbolKindName(item.kind),
      range: fromVscodeRange(item.location.range),
      selectionRange: fromVscodeRange(item.location.range),
    }]
  })
}

function normalizeDocumentSymbol(symbol: vscode.DocumentSymbol): LspDocumentSymbol {
  const children = symbol.children.map(normalizeDocumentSymbol)
  return {
    name: symbol.name,
    kind: symbolKindName(symbol.kind),
    range: fromVscodeRange(symbol.range),
    selectionRange: fromVscodeRange(symbol.selectionRange),
    ...(children.length ? { children } : {}),
  }
}

function markedStringToText(value: vscode.MarkedString | vscode.MarkdownString): string[] {
  if (typeof value === 'string') {
    return [value]
  }
  if ('value' in value && typeof value.value === 'string') {
    return [value.value]
  }
  if ('language' in value && 'value' in value) {
    return [value.value]
  }
  return []
}

function definitionCommand(kind: LspDefinitionRequest['kind']): string {
  if (kind === 'declaration') return 'vscode.executeDeclarationProvider'
  if (kind === 'type_definition') return 'vscode.executeTypeDefinitionProvider'
  if (kind === 'implementation') return 'vscode.executeImplementationProvider'
  return 'vscode.executeDefinitionProvider'
}

function isLocationLink(value: vscode.Location | vscode.LocationLink): value is vscode.LocationLink {
  return 'targetUri' in value
}

function isDocumentSymbol(value: vscode.DocumentSymbol | vscode.SymbolInformation): value is vscode.DocumentSymbol {
  return 'selectionRange' in value
}

function sameLocation(a: LspLocation, b: LspLocation): boolean {
  return a.path === b.path
    && a.range.start.line === b.range.start.line
    && a.range.start.character === b.range.start.character
}

function symbolKindName(kind: vscode.SymbolKind): string {
  return vscode.SymbolKind[kind] || 'unknown'
}
