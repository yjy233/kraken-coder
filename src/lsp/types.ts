export type LspLanguage = 'typescript' | 'go' | 'python'

export interface LspPosition {
  line: number
  character: number
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

export interface LspTextDocumentPositionRequest {
  workspaceRoot: string
  path: string
  language: LspLanguage
  position: LspPosition
}

export interface LspDefinitionRequest extends LspTextDocumentPositionRequest {
  kind: 'definition' | 'declaration' | 'type_definition' | 'implementation'
}

export interface LspReferencesRequest extends LspTextDocumentPositionRequest {
  includeDeclaration: boolean
}

export interface LspDocumentSymbolsRequest {
  workspaceRoot: string
  path: string
  language: LspLanguage
}

export interface LspWorkspaceSymbolsRequest {
  workspaceRoot: string
  query: string
  language?: LspLanguage | undefined
}

export interface LspLocation {
  path: string
  range: LspRange
}

export interface LspReference {
  path: string
  range: LspRange
}

export interface LspHoverResult {
  contents: string[]
}

export interface LspDocumentSymbol {
  name: string
  kind: string
  range: LspRange
  selectionRange: LspRange
  children?: LspDocumentSymbol[]
}

export interface LspWorkspaceSymbol {
  name: string
  kind: string
  containerName?: string | undefined
  path: string
  range: LspRange
  language?: LspLanguage | undefined
}

export interface LspHostAdapter {
  kind: 'vscode' | 'process'
  initializeWorkspace(workspaceRoot: string, language: LspLanguage): Promise<void>
  hover(request: LspTextDocumentPositionRequest): Promise<LspHoverResult>
  definition(request: LspDefinitionRequest): Promise<LspLocation[]>
  references(request: LspReferencesRequest): Promise<LspReference[]>
  documentSymbols(request: LspDocumentSymbolsRequest): Promise<LspDocumentSymbol[]>
  workspaceSymbols(request: LspWorkspaceSymbolsRequest): Promise<LspWorkspaceSymbol[]>
  dispose?(): Promise<void>
}

export interface LspToolConfig {
  enabled: boolean
  languages: LspLanguage[]
  maxResults: number
  hoverMaxChars: number
  timeoutMs: number
}
