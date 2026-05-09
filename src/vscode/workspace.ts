import * as path from 'path';
import * as vscode from 'vscode';
import { ContextItem } from '../shared/types';
import { createId } from '../shared/id';

const ignoredDirectoryNames = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'out',
  '.next',
  '.turbo'
]);

const sensitiveFilePatterns = [
  /^\.env(?:\..*)?$/,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i
];

export function getWorkspaceRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

export function workspaceRelativePath(uri: vscode.Uri): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    return uri.fsPath;
  }

  return path.relative(workspaceFolder.uri.fsPath, uri.fsPath).replaceAll(path.sep, '/');
}

export async function getActiveSelectionContext(): Promise<ContextItem | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }

  const document = editor.document;
  const selection = editor.selection;
  if (selection.isEmpty) {
    return {
      id: createId('ctx'),
      label: `Current file: ${workspaceRelativePath(document.uri)}`,
      kind: 'file',
      path: workspaceRelativePath(document.uri),
      content: formatFileContext(document, document.getText()),
      createdAt: Date.now()
    };
  }

  return {
    id: createId('ctx'),
    label: `Selection: ${workspaceRelativePath(document.uri)}:${selection.start.line + 1}`,
    kind: 'selection',
    path: workspaceRelativePath(document.uri),
    content: formatSelectionContext(document, selection),
    createdAt: Date.now()
  };
}

export async function getDiagnosticsContext(): Promise<ContextItem | undefined> {
  const diagnostics = vscode.languages.getDiagnostics();
  const lines: string[] = [];

  for (const [uri, entries] of diagnostics) {
    if (!entries.length || shouldIgnorePath(uri.fsPath)) {
      continue;
    }

    const relevant = entries.slice(0, 8);
    for (const diagnostic of relevant) {
      lines.push(
        `${workspaceRelativePath(uri)}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} ${diagnostic.message}`
      );
    }

    if (lines.length >= 30) {
      break;
    }
  }

  if (!lines.length) {
    return undefined;
  }

  return {
    id: createId('ctx'),
    label: 'Workspace diagnostics',
    kind: 'diagnostics',
    content: lines.join('\n'),
    createdAt: Date.now()
  };
}

export async function getWorkspaceTreeContext(maxEntries = 160): Promise<ContextItem | undefined> {
  const root = getWorkspaceRoot();
  if (!root) {
    return undefined;
  }

  const files = await vscode.workspace.findFiles('**/*', ignoredGlob(), maxEntries);
  const relative = files
    .map(workspaceRelativePath)
    .filter((item) => !shouldIgnorePath(item))
    .sort();

  if (!relative.length) {
    return undefined;
  }

  return {
    id: createId('ctx'),
    label: 'Workspace files',
    kind: 'workspace',
    content: relative.join('\n'),
    createdAt: Date.now()
  };
}

export function shouldIgnorePath(filePath: string): boolean {
  const parts = filePath.split(/[\\/]/);
  if (parts.some((part) => ignoredDirectoryNames.has(part))) {
    return true;
  }

  const basename = parts[parts.length - 1] ?? '';
  return sensitiveFilePatterns.some((pattern) => pattern.test(basename));
}

function formatFileContext(document: vscode.TextDocument, text: string): string {
  return [
    `File: ${workspaceRelativePath(document.uri)}`,
    `Language: ${document.languageId}`,
    '',
    '```',
    text,
    '```'
  ].join('\n');
}

function formatSelectionContext(document: vscode.TextDocument, selection: vscode.Selection): string {
  const startLine = Math.max(0, selection.start.line - 20);
  const endLine = Math.min(document.lineCount - 1, selection.end.line + 20);
  const contextRange = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
  const selectedText = document.getText(selection);
  const contextText = document.getText(contextRange);

  return [
    `File: ${workspaceRelativePath(document.uri)}`,
    `Language: ${document.languageId}`,
    `Selection: ${selection.start.line + 1}:${selection.start.character + 1}-${selection.end.line + 1}:${selection.end.character + 1}`,
    '',
    'Selected text:',
    '```',
    selectedText,
    '```',
    '',
    'Nearby context:',
    '```',
    contextText,
    '```'
  ].join('\n');
}

function ignoredGlob(): string {
  return `{${Array.from(ignoredDirectoryNames).map((name) => `**/${name}/**`).join(',')}}`;
}
