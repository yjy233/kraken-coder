import * as path from 'path';
import * as vscode from 'vscode';
import { ChangeSet, ChangeSetFile, FileChange } from '../shared/types';
import { createId } from '../shared/id';
import { getWorkspaceRoot, shouldIgnorePath, workspaceRelativePath } from './workspace';

export async function buildChangeSet(title: string, description: string, changes: FileChange[]): Promise<ChangeSet> {
  const files: ChangeSetFile[] = [];

  for (const change of changes) {
    if (shouldIgnorePath(change.path)) {
      throw new Error(`Refusing to change ignored or sensitive path: ${change.path}`);
    }

    const uri = resolveWorkspaceUri(change.path);
    const beforeText = await readTextIfExists(uri);
    let afterText: string | null;

    if (change.type === 'delete') {
      afterText = null;
    } else if (typeof change.fullText === 'string') {
      afterText = change.fullText;
    } else {
      throw new Error(`Change for ${change.path} must include fullText. Patch-only changes are not implemented yet.`);
    }

    const status = change.type === 'create' ? 'created' : change.type === 'delete' ? 'deleted' : 'modified';
    files.push({
      path: workspaceRelativePath(uri),
      beforeText,
      afterText,
      status
    });
  }

  return {
    id: createId('changes'),
    title,
    description,
    files,
    createdAt: Date.now()
  };
}

export async function applyChangeSet(changeSet: ChangeSet): Promise<void> {
  const edit = new vscode.WorkspaceEdit();

  for (const file of changeSet.files) {
    const uri = resolveWorkspaceUri(file.path);

    if (file.status === 'deleted') {
      edit.deleteFile(uri, { ignoreIfNotExists: true });
      continue;
    }

    if (file.status === 'created') {
      await ensureParentDirectory(uri);
      edit.createFile(uri, { ignoreIfExists: true });
      edit.insert(uri, new vscode.Position(0, 0), file.afterText ?? '');
      continue;
    }

    const document = await vscode.workspace.openTextDocument(uri);
    const currentText = document.getText();
    if (file.beforeText !== null && currentText !== file.beforeText) {
      throw new Error(`File changed since proposal was created: ${file.path}`);
    }

    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(currentText.length)
    );
    edit.replace(uri, fullRange, file.afterText ?? '');
  }

  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    throw new Error('VS Code refused to apply the workspace edit.');
  }

  await Promise.all(
    changeSet.files
      .filter((file) => file.status !== 'deleted')
      .map(async (file) => {
        const document = await vscode.workspace.openTextDocument(resolveWorkspaceUri(file.path));
        await document.save();
      })
  );
}

export async function openChangeDiff(changeSet: ChangeSet, filePath: string): Promise<void> {
  const file = changeSet.files.find((candidate) => candidate.path === filePath);
  if (!file) {
    throw new Error(`Change file not found: ${filePath}`);
  }

  const left = vscode.Uri.parse(`kraken-change:${encodeURIComponent(changeSet.id)}/${encodeURIComponent(file.path)}.before`);
  const right = vscode.Uri.parse(`kraken-change:${encodeURIComponent(changeSet.id)}/${encodeURIComponent(file.path)}.after`);

  ChangeDocumentProvider.setVirtualDocument(left.toString(), file.beforeText ?? '');
  ChangeDocumentProvider.setVirtualDocument(right.toString(), file.afterText ?? '');

  await vscode.commands.executeCommand('vscode.diff', left, right, `Kraken: ${file.path}`);
}

export class ChangeDocumentProvider implements vscode.TextDocumentContentProvider {
  private static readonly documents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  static setVirtualDocument(uri: string, content: string): void {
    this.documents.set(uri, content);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return ChangeDocumentProvider.documents.get(uri.toString()) ?? '';
  }
}

function resolveWorkspaceUri(filePath: string): vscode.Uri {
  const root = getWorkspaceRoot();
  if (!root) {
    throw new Error('Open a workspace folder before applying code changes.');
  }

  const normalized = filePath.replaceAll('\\', '/');
  if (path.isAbsolute(normalized)) {
    return vscode.Uri.file(normalized);
  }

  const target = vscode.Uri.joinPath(root, ...normalized.split('/').filter(Boolean));
  const relative = path.relative(root.fsPath, target.fsPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to access path outside workspace: ${filePath}`);
  }

  return target;
}

async function ensureParentDirectory(uri: vscode.Uri): Promise<void> {
  const parentPath = path.dirname(uri.fsPath);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(parentPath));
}

async function readTextIfExists(uri: vscode.Uri): Promise<string | null> {
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    return document.getText();
  } catch {
    return null;
  }
}
