import * as vscode from 'vscode';

export class KrakenCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    if (!context.diagnostics.length) {
      return [];
    }

    const action = new vscode.CodeAction('Ask Kraken to Fix', vscode.CodeActionKind.QuickFix);
    action.command = {
      command: 'kraken.fixSelection',
      title: 'Ask Kraken to Fix',
      arguments: [document.uri, range]
    };
    action.diagnostics = [...context.diagnostics];
    action.isPreferred = false;
    return [action];
  }
}
