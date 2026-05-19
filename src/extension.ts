import * as vscode from 'vscode';
import { KrakenCodeActionProvider } from './providers/codeActionProvider';
import { KrakenViewProvider } from './providers/krakenViewProvider';
import { configureModel } from './vscode/config';

export function activate(context: vscode.ExtensionContext): void {
  const krakenViewProvider = new KrakenViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(KrakenViewProvider.viewType, krakenViewProvider),
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      new KrakenCodeActionProvider(),
      { providedCodeActionKinds: KrakenCodeActionProvider.providedCodeActionKinds }
    ),
    vscode.commands.registerCommand('kraken.openChat', () => krakenViewProvider.reveal()),
    vscode.commands.registerCommand('kraken.configureModel', () => configureModel()),
    vscode.commands.registerCommand('kraken.clearSession', () => krakenViewProvider.clearSession()),
    vscode.commands.registerCommand('kraken.explainSelection', (uri?: vscode.Uri, range?: vscode.Range) => {
      return krakenViewProvider.runSelectionTask('explain', uri, range);
    }),
    vscode.commands.registerCommand('kraken.fixSelection', (uri?: vscode.Uri, range?: vscode.Range) => {
      return krakenViewProvider.runSelectionTask('fix', uri, range);
    }),
    vscode.commands.registerCommand('kraken.generateTests', (uri?: vscode.Uri, range?: vscode.Range) => {
      return krakenViewProvider.runSelectionTask('tests', uri, range);
    }),
    vscode.commands.registerCommand('kraken.addSelectionToContext', () => krakenViewProvider.addSelectionToContext())
  );
}

export function deactivate(): void {
  // No background resources to dispose.
}
