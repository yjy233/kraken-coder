import * as path from 'path';
import * as vscode from 'vscode';
import { AgentTool } from '../agent/tools';
import { FileChange } from '../shared/types';
import { getWorkspaceRoot, shouldIgnorePath, workspaceRelativePath } from './workspace';

const maxReadChars = 120000;
const maxToolOutputChars = 200000;

export function createWorkspaceTools(onProposeChanges: (summary: string, changes: FileChange[]) => Promise<string>): AgentTool[] {
  return [
    createListFilesTool(),
    createReadFileTool(),
    createSearchTextTool(),
    createFindFilesTool(),
    createProposeChangesTool(onProposeChanges)
  ];
}

function createListFilesTool(): AgentTool {
  return {
    name: 'list_files',
    description: 'List workspace files and directories under a workspace-relative path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Workspace-relative directory path. Defaults to the workspace root.'
        },
        recursive: {
          type: 'boolean',
          description: 'Whether to list recursively. Defaults to false.'
        },
        max_results: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          description: 'Maximum number of entries to return. Defaults to 200.'
        }
      }
    },
    execute: async (input) => {
      const baseUri = resolveWorkspaceUri(optionalString(input.path) || '.', { directory: true });
      const recursive = Boolean(input.recursive);
      const maxResults = clampInteger(input.max_results, 200, 1, 500);
      const entries = await listEntries(baseUri, recursive, maxResults);

      return {
        output: truncateOutput(entries.join('\n') || '(empty directory)', maxToolOutputChars)
      };
    }
  };
}

function createReadFileTool(): AgentTool {
  return {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the workspace, optionally limited to a line range.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Workspace-relative file path.'
        },
        start_line: {
          type: 'integer',
          minimum: 1,
          description: 'Optional starting line number, 1-based.'
        },
        end_line: {
          type: 'integer',
          minimum: 1,
          description: 'Optional ending line number, 1-based.'
        }
      },
      required: ['path']
    },
    execute: async (input) => {
      const uri = resolveWorkspaceUri(requiredString(input.path, 'path'));
      const document = await vscode.workspace.openTextDocument(uri);
      const raw = document.getText();
      const lines = raw.split(/\r?\n/);
      const start = clampInteger(input.start_line, 1, 1, Math.max(lines.length, 1));
      const end = clampInteger(input.end_line, lines.length, start, Math.max(lines.length, start));
      const output = lines
        .slice(start - 1, end)
        .map((line, index) => `${String(start + index).padStart(4, ' ')} | ${line}`)
        .join('\n');

      return {
        output: truncateOutput(output || '(empty file)', maxReadChars)
      };
    }
  };
}

function createSearchTextTool(): AgentTool {
  return {
    name: 'search_text',
    description: 'Search workspace text with a JavaScript regular expression and return matching file lines.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Text or JavaScript regular expression pattern.'
        },
        path: {
          type: 'string',
          description: 'Workspace-relative file or directory path to search. Defaults to workspace root.'
        },
        max_results: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'Maximum number of matching lines to return. Defaults to 50.'
        }
      },
      required: ['pattern']
    },
    execute: async (input) => {
      const pattern = requiredString(input.pattern, 'pattern');
      const regex = new RegExp(pattern, 'i');
      const maxResults = clampInteger(input.max_results, 50, 1, 200);
      const targetPath = optionalString(input.path) || '.';
      const targetUri = resolveWorkspaceUri(targetPath);
      const fileUris = await collectSearchFiles(targetUri, targetPath);
      const matches: string[] = [];

      for (const uri of fileUris) {
        if (matches.length >= maxResults) {
          break;
        }

        let raw: string;
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          raw = Buffer.from(bytes).toString('utf8');
        } catch {
          continue;
        }

        const lines = raw.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? '';
          if (regex.test(line)) {
            matches.push(`${workspaceRelativePath(uri)}:${index + 1}: ${line}`);
            if (matches.length >= maxResults) {
              break;
            }
          }
        }
      }

      return {
        output: truncateOutput(matches.join('\n') || '(no matches)', maxToolOutputChars)
      };
    }
  };
}

function createFindFilesTool(): AgentTool {
  return {
    name: 'find_files',
    description: 'Find workspace files using a glob pattern such as "**/*.ts" or "src/**/*.json".',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern to match workspace files.'
        },
        max_results: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          description: 'Maximum number of paths to return. Defaults to 200.'
        }
      },
      required: ['pattern']
    },
    execute: async (input) => {
      const pattern = requiredString(input.pattern, 'pattern');
      const maxResults = clampInteger(input.max_results, 200, 1, 500);
      const files = await vscode.workspace.findFiles(pattern, ignoredGlob(), maxResults);
      const relative = files
        .filter((uri) => !shouldIgnorePath(workspaceRelativePath(uri)))
        .map(workspaceRelativePath)
        .sort();

      return {
        output: truncateOutput(relative.join('\n') || '(no matches)', maxToolOutputChars)
      };
    }
  };
}

function createProposeChangesTool(onProposeChanges: (summary: string, changes: FileChange[]) => Promise<string>): AgentTool {
  return {
    name: 'propose_changes',
    description: 'Create a reviewable VS Code change proposal. Use this for file edits instead of directly writing files.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Short user-facing summary for the proposed changes.'
        },
        changes: {
          type: 'array',
          description: 'File changes with complete desired file content for created or modified files.',
          items: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Workspace-relative file path.'
              },
              type: {
                type: 'string',
                enum: ['create', 'modify', 'delete']
              },
              fullText: {
                type: 'string',
                description: 'Complete desired file content for create or modify changes.'
              },
              rationale: {
                type: 'string',
                description: 'Brief rationale for this file change.'
              }
            },
            required: ['path', 'type']
          }
        }
      },
      required: ['summary', 'changes']
    },
    execute: async (input) => {
      const summary = requiredString(input.summary, 'summary');
      const changes = parseFileChanges(input.changes);
      const output = await onProposeChanges(summary, changes);

      return { output };
    }
  };
}

async function listEntries(baseUri: vscode.Uri, recursive: boolean, maxResults: number): Promise<string[]> {
  const results: string[] = [];

  async function visit(uri: vscode.Uri): Promise<void> {
    if (results.length >= maxResults) {
      return;
    }

    const entries = await vscode.workspace.fs.readDirectory(uri);
    for (const [name, type] of entries.sort(([left], [right]) => left.localeCompare(right))) {
      if (results.length >= maxResults) {
        break;
      }
      if (shouldIgnorePath(name)) {
        continue;
      }

      const child = vscode.Uri.joinPath(uri, name);
      const relativePath = workspaceRelativePath(child);
      if (shouldIgnorePath(relativePath)) {
        continue;
      }

      if (type === vscode.FileType.Directory) {
        results.push(`d  <dir>     ${relativePath}/`);
        if (recursive) {
          await visit(child);
        }
      } else if (type === vscode.FileType.File) {
        const stat = await vscode.workspace.fs.stat(child);
        results.push(`f  ${formatBytes(stat.size).padStart(8)}  ${relativePath}`);
      }
    }
  }

  await visit(baseUri);
  return results;
}

async function collectSearchFiles(targetUri: vscode.Uri, targetPath: string): Promise<vscode.Uri[]> {
  const stat = await vscode.workspace.fs.stat(targetUri);
  if (stat.type === vscode.FileType.File) {
    return shouldIgnorePath(workspaceRelativePath(targetUri)) ? [] : [targetUri];
  }

  const normalized = targetPath.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  const prefix = normalized && normalized !== '.' ? `${normalized}/` : '';
  const include = `${prefix}**/*`;
  const files = await vscode.workspace.findFiles(include, ignoredGlob(), 1000);
  return files.filter((uri) => !shouldIgnorePath(workspaceRelativePath(uri)));
}

function resolveWorkspaceUri(filePath: string, options?: { directory?: boolean }): vscode.Uri {
  const root = getWorkspaceRoot();
  if (!root) {
    throw new Error('Open a workspace folder before using workspace tools.');
  }

  const normalized = filePath.replaceAll('\\', '/');
  if (path.isAbsolute(normalized)) {
    throw new Error(`Use workspace-relative paths only: ${filePath}`);
  }

  if (shouldIgnorePath(normalized)) {
    throw new Error(`Refusing to access ignored or sensitive path: ${filePath}`);
  }

  const parts = normalized.split('/').filter(Boolean);
  const target = parts.length ? vscode.Uri.joinPath(root, ...parts) : root;
  const relative = path.relative(root.fsPath, target.fsPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to access path outside workspace: ${filePath}`);
  }

  if (options?.directory && normalized && normalized !== '.') {
    return target;
  }

  return target;
}

function parseFileChanges(value: unknown): FileChange[] {
  if (!Array.isArray(value)) {
    throw new Error('changes must be an array');
  }

  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`changes[${index}] must be an object`);
    }

    const pathValue = requiredString(item.path, `changes[${index}].path`);
    const type = item.type;
    if (type !== 'create' && type !== 'modify' && type !== 'delete') {
      throw new Error(`changes[${index}].type must be create, modify, or delete`);
    }

    const fullText = typeof item.fullText === 'string' ? item.fullText : undefined;
    if (type !== 'delete' && fullText === undefined) {
      throw new Error(`changes[${index}].fullText is required for ${type}`);
    }

    return {
      path: pathValue,
      type,
      fullText,
      rationale: typeof item.rationale === 'string' ? item.rationale : undefined
    };
  });
}

function ignoredGlob(): string {
  return '{**/.git/**,**/node_modules/**,**/dist/**,**/build/**,**/coverage/**,**/out/**,**/.next/**,**/.turbo/**,**/.env,**/.env.*,**/*.pem,**/*.key,**/*.p12}';
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function truncateOutput(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
