import * as vscode from 'vscode';
import { AgentRuntime } from '../agent/runtime';
import { createId } from '../shared/id';
import {
  AgentResult,
  ChangeSet,
  ChatMessage,
  ChatSession,
  ContextItem,
  WebviewToExtensionMessage
} from '../shared/types';
import { createWorkspaceTools } from '../vscode/agentTools';
import { ensureModelConfigured } from '../vscode/config';
import { applyChangeSet, buildChangeSet, openChangeDiff } from '../vscode/edits';
import { SecretStore } from '../vscode/secrets';
import {
  getActiveSelectionContext,
  getDiagnosticsContext,
  getWorkspaceTreeContext
} from '../vscode/workspace';
import { getWebviewHtml } from '../webview/html';

export class KrakenViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'krakenCoder.chatView';

  private webviewView?: vscode.WebviewView;
  private readonly runtime = new AgentRuntime();
  private readonly session: ChatSession = {
    id: createId('session'),
    messages: [],
    context: [],
    changeSets: [],
    busy: false
  };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly secretStore: SecretStore
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    webviewView.webview.html = getWebviewHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
      this.handleMessage(message).catch((error: unknown) => {
        this.showError(error);
      });
    });

    this.postSession();
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`${KrakenViewProvider.viewType}.focus`);
    this.postSession();
  }

  async clearSession(): Promise<void> {
    this.session.messages = [];
    this.session.context = [];
    this.session.changeSets = [];
    this.session.busy = false;
    this.postSession();
  }

  async addSelectionToContext(): Promise<void> {
    const context = await getActiveSelectionContext();
    if (!context) {
      vscode.window.showInformationMessage('Open a file or select code before adding context.');
      return;
    }

    this.upsertContext(context);
    this.postSession();
    await this.reveal();
  }

  async runSelectionTask(kind: 'explain' | 'fix' | 'tests', uri?: vscode.Uri, range?: vscode.Range): Promise<void> {
    if (uri && range) {
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, { preserveFocus: false });
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    const selectionContext = await getActiveSelectionContext();
    if (selectionContext) {
      this.upsertContext(selectionContext);
    }

    const prompt = {
      explain: 'Explain the selected code. Focus on behavior, dependencies, and edge cases.',
      fix: 'Fix the selected code. Return a JSON change proposal if file edits are needed.',
      tests: 'Generate useful tests for the current file or selection. Return a JSON change proposal with new or modified test files.'
    }[kind];

    await this.reveal();
    await this.sendChat(prompt);
  }

  private async handleMessage(message: WebviewToExtensionMessage): Promise<void> {
    switch (message.type) {
      case 'chat.send':
        await this.sendChat(message.text);
        break;
      case 'change.apply':
        await this.applyChange(message.changeSetId);
        break;
      case 'change.openDiff':
        await this.openDiff(message.changeSetId, message.filePath);
        break;
      case 'change.reject':
        this.session.changeSets = this.session.changeSets.filter((changeSet) => changeSet.id !== message.changeSetId);
        this.postSession();
        break;
      case 'context.remove':
        this.session.context = this.session.context.filter((item) => item.id !== message.contextId);
        this.postSession();
        break;
      case 'config.open':
        await vscode.commands.executeCommand('kraken.configureModel');
        break;
      case 'secret.setApiKey':
        await vscode.commands.executeCommand('kraken.setApiKey');
        break;
      case 'session.clear':
        await this.clearSession();
        break;
    }
  }

  private async sendChat(text: string): Promise<void> {
    const userText = text.trim();
    if (!userText || this.session.busy) {
      return;
    }

    const settings = await ensureModelConfigured();
    if (!settings) {
      return;
    }

    const apiKey = await this.secretStore.ensureApiKey();
    if (!apiKey) {
      return;
    }

    await this.addAutomaticContext();

    const userMessage: ChatMessage = {
      id: createId('msg'),
      role: 'user',
      content: userText,
      createdAt: Date.now()
    };

    this.session.messages.push(userMessage);
    this.session.busy = true;
    this.postSession();
    this.postProgress('Thinking...');

    try {
      const maxContextChars = vscode.workspace.getConfiguration('kraken').get<number>('context.maxChars') ?? 60000;
      const tools = createWorkspaceTools((summary, changes) => this.addChangeProposal(summary, changes));
      const result = await this.runtime.run({
        userText,
        history: this.session.messages.slice(0, -1),
        context: this.session.context,
        settings,
        apiKey,
        maxContextChars,
        tools,
        onProgress: (message) => this.postProgress(message)
      });

      await this.handleAgentResult(result);
    } finally {
      this.session.busy = false;
      this.postSession();
    }
  }

  private async handleAgentResult(result: AgentResult): Promise<void> {
    const parts = [result.summary];

    if (result.commands?.length) {
      parts.push(
        '',
        'Suggested commands:',
        ...result.commands.map((command) => `- ${command.command}${command.rationale ? ` — ${command.rationale}` : ''}`)
      );
    }

    if (result.followUps?.length) {
      parts.push('', 'Follow ups:', ...result.followUps.map((item) => `- ${item}`));
    }

    const assistantMessage: ChatMessage = {
      id: createId('msg'),
      role: 'assistant',
      content: parts.join('\n'),
      createdAt: Date.now()
    };
    this.session.messages.push(assistantMessage);

    if (result.changes?.length) {
      const changeSet = await buildChangeSet(result.summary || 'Kraken proposed changes', result.summary, result.changes);
      this.session.changeSets.unshift(changeSet);

      const autoApply = vscode.workspace.getConfiguration('kraken').get<boolean>('agent.autoApply') ?? false;
      if (autoApply) {
        await applyChangeSet(changeSet);
        vscode.window.showInformationMessage(`Applied Kraken changes: ${changeSet.title}`);
      }
    }
  }

  private async addChangeProposal(summary: string, changes: AgentResult['changes']): Promise<string> {
    if (!changes?.length) {
      throw new Error('propose_changes requires at least one file change.');
    }

    const changeSet = await buildChangeSet(summary || 'Kraken proposed changes', summary, changes);
    this.session.changeSets.unshift(changeSet);
    this.postSession();

    const autoApply = vscode.workspace.getConfiguration('kraken').get<boolean>('agent.autoApply') ?? false;
    if (autoApply) {
      await applyChangeSet(changeSet);
      vscode.window.showInformationMessage(`Applied Kraken changes: ${changeSet.title}`);
      return `Created and applied change proposal ${changeSet.id} (${changeSet.files.length} file(s)).`;
    }

    return `Created reviewable change proposal ${changeSet.id} (${changeSet.files.length} file(s)). The user can inspect the diff and apply it from the Kraken panel.`;
  }

  private async addAutomaticContext(): Promise<void> {
    const contexts = await Promise.all([
      getActiveSelectionContext(),
      getDiagnosticsContext(),
      getWorkspaceTreeContext()
    ]);

    for (const context of contexts) {
      if (context) {
        this.upsertContext(context);
      }
    }
  }

  private upsertContext(context: ContextItem): void {
    const equivalent = this.session.context.find((item) => item.label === context.label && item.path === context.path);
    if (equivalent) {
      equivalent.content = context.content;
      equivalent.createdAt = Date.now();
      return;
    }

    this.session.context.unshift(context);
    this.session.context = this.session.context.slice(0, 20);
  }

  private async applyChange(changeSetId: string): Promise<void> {
    const changeSet = this.findChangeSet(changeSetId);
    await applyChangeSet(changeSet);
    this.session.changeSets = this.session.changeSets.filter((item) => item.id !== changeSetId);
    this.postSession();
    vscode.window.showInformationMessage(`Applied Kraken changes: ${changeSet.title}`);
  }

  private async openDiff(changeSetId: string, filePath: string): Promise<void> {
    await openChangeDiff(this.findChangeSet(changeSetId), filePath);
  }

  private findChangeSet(changeSetId: string): ChangeSet {
    const changeSet = this.session.changeSets.find((item) => item.id === changeSetId);
    if (!changeSet) {
      throw new Error(`Change set not found: ${changeSetId}`);
    }

    return changeSet;
  }

  private postSession(): void {
    this.webviewView?.webview.postMessage({
      type: 'session.updated',
      session: this.session
    });
  }

  private postProgress(message: string): void {
    this.webviewView?.webview.postMessage({
      type: 'agent.progress',
      message
    });
  }

  private showError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.session.busy = false;
    this.webviewView?.webview.postMessage({
      type: 'error',
      message,
      recoverable: true
    });
    vscode.window.showErrorMessage(message);
    this.postSession();
  }
}
