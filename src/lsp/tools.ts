import type { ToolDefinition } from '../agent/types'
import { LspService } from './service'
import type { LspHostAdapter, LspToolConfig } from './types'

export function createLspTools(params: {
  workspaceRoot: string
  adapter: LspHostAdapter
  config: LspToolConfig
}): ToolDefinition[] {
  if (!params.config.enabled) {
    return []
  }

  const service = new LspService(params)
  return [
    {
      name: 'lsp_hover',
      description: 'Get hover/type/signature documentation at a TypeScript, Go, or Python position.',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Workspace-relative file path.',
          },
          line: {
            type: 'integer',
            minimum: 1,
            description: '1-based line number.',
          },
          character: {
            type: 'integer',
            minimum: 1,
            description: '1-based character number.',
          },
        },
        required: ['path', 'line', 'character'],
      },
      execute: async (input) => ({ output: await service.hover(input) }),
    },
    {
      name: 'lsp_definition',
      description: 'Find definition, declaration, type definition, or implementation for a TypeScript, Go, or Python symbol.',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Workspace-relative file path.',
          },
          line: {
            type: 'integer',
            minimum: 1,
            description: '1-based line number.',
          },
          character: {
            type: 'integer',
            minimum: 1,
            description: '1-based character number.',
          },
          kind: {
            type: 'string',
            enum: ['definition', 'declaration', 'type_definition', 'implementation'],
            description: 'Definition query kind. Defaults to definition.',
          },
          max_results: {
            type: 'integer',
            minimum: 1,
            maximum: 200,
            description: 'Maximum number of locations to return.',
          },
        },
        required: ['path', 'line', 'character'],
      },
      execute: async (input) => ({ output: await service.definition(input) }),
    },
    {
      name: 'lsp_references',
      description: 'Find references for a TypeScript, Go, or Python symbol.',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Workspace-relative file path.',
          },
          line: {
            type: 'integer',
            minimum: 1,
            description: '1-based line number.',
          },
          character: {
            type: 'integer',
            minimum: 1,
            description: '1-based character number.',
          },
          include_declaration: {
            type: 'boolean',
            description: 'Whether to include the symbol declaration in results.',
          },
          max_results: {
            type: 'integer',
            minimum: 1,
            maximum: 200,
            description: 'Maximum number of references to return.',
          },
        },
        required: ['path', 'line', 'character'],
      },
      execute: async (input) => ({ output: await service.references(input) }),
    },
    {
      name: 'lsp_document_symbols',
      description: 'List the symbol tree for a TypeScript, Go, or Python file.',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Workspace-relative file path.',
          },
          max_depth: {
            type: 'integer',
            minimum: 1,
            maximum: 20,
            description: 'Maximum symbol tree depth to return.',
          },
        },
        required: ['path'],
      },
      execute: async (input) => ({ output: await service.documentSymbols(input) }),
    },
    {
      name: 'lsp_workspace_symbols',
      description: 'Search TypeScript, Go, or Python workspace symbols by name.',
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Symbol search query.',
          },
          language: {
            type: 'string',
            enum: ['typescript', 'go', 'python'],
            description: 'Optional language filter.',
          },
          max_results: {
            type: 'integer',
            minimum: 1,
            maximum: 200,
            description: 'Maximum number of symbols to return.',
          },
        },
        required: ['query'],
      },
      execute: async (input) => ({ output: await service.workspaceSymbols(input) }),
    },
  ]
}
