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
import { createVSCodeToolRegistry } from '../vscode/agentTools';
import { ensureModelConfigured } from '../vscode/config';
import { applyChangeSet, buildChangeSet, openChangeDiff } from '../vscode/edits';
import { SecretStore } from '../vscode/secrets';
import {
  getActiveSelectionContext,
  getDiagnosticsContext,
  getWorkspaceRoot,
  getWorkspaceTreeContext
} from '../vscode/workspace';
import { getWebviewHtml } from '../webview/html';
import { getKrakenConfig } from '../vscode/krakenConfig';
import { parseSlashCommand } from '../slash/parser';
import { buildSlashHelp, findSlashCommand } from '../slash/registry';
import { buildMemoryPaths } from '../memory/paths';
import { loadMemory } from '../memory/reader';
import { getGitBranch } from '../episodes/git';
import { recallEpisodes } from '../episodes/recall';
import { recordEpisode } from '../episodes/recorder';

export class KrakenViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'krakenCoder.chatView';

  private webviewView?: vscode.WebviewView;
  private streamingAssistantMessageId?: string;
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
    this.streamingAssistantMessageId = undefined;
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

    const slashInvocation = parseSlashCommand(userText);
    if (slashInvocation) {
      await this.runSlashCommand(userText, slashInvocation);
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
      const extensionRoot = this.extensionUri.fsPath;
      const config = getKrakenConfig({ extensionRoot });
      const workspaceRoot = getWorkspaceRoot()?.fsPath;
      const branch = await getGitBranch(workspaceRoot);
      const memory = await loadMemory(buildMemoryPaths({
        globalRoot: config.paths.globalRoot,
        workspaceRoot,
      }), config.memory);
      const recalledEpisodes = await recallEpisodes({
        workspaceRoot,
        branch,
        query: userText,
        config: config.episodes,
      });
      const { tools, availableSkills } = createVSCodeToolRegistry(
        (summary, changes) => this.addChangeProposal(summary, changes),
        { extensionRoot }
      );
      this.streamingAssistantMessageId = undefined;
      const result = await this.runtime.run({
        userText,
        history: this.session.messages.slice(0, -1),
        context: this.session.context,
        settings,
        apiKey,
        maxContextChars: config.context.maxChars,
        tools,
        availableSkills,
        memoryPromptBlock: memory?.promptBlock,
        episodesPromptBlock: recalledEpisodes?.promptBlock,
        onProgress: (message) => this.handleAgentProgress(message)
      });

      await this.handleAgentResult(result);
      await recordEpisode({
        workspaceRoot,
        userText,
        result,
        messages: this.session.messages,
        toolMessages: this.session.messages.filter((message) => message.kind === 'tool'),
        branch,
        config: config.episodes,
      });
    } finally {
      this.streamingAssistantMessageId = undefined;
      this.session.busy = false;
      this.postSession();
    }
  }

  private async runSlashCommand(userText: string, invocation: NonNullable<ReturnType<typeof parseSlashCommand>>): Promise<void> {
    const command = findSlashCommand(invocation.name);
    const userMessage: ChatMessage = {
      id: createId('msg'),
      role: 'user',
      content: userText,
      createdAt: Date.now()
    };
    this.session.messages.push(userMessage);

    if (!command) {
      this.postAssistantMessage([
        `Unknown slash command: /${invocation.name}`,
        '',
        buildSlashHelp(),
      ].join('\n'));
      this.postSession();
      return;
    }

    this.session.busy = true;
    this.postSession();

    try {
      await command.execute(invocation, {
        workspaceRoot: getWorkspaceRoot()?.fsPath,
        globalRoot: getKrakenConfig({ extensionRoot: this.extensionUri.fsPath }).paths.globalRoot,
        postAssistantMessage: (content) => this.postAssistantMessage(content),
        postProgress: (message) => this.postProgress(message),
        clearSession: () => this.clearSession(),
        addReviewableChangeProposal: (summary, changes) => this.addReviewableChangeProposal(summary, changes),
        openFile: async (filePath) => {
          const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
          await vscode.window.showTextDocument(document, { preview: false });
        },
      });
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

    const content = parts.join('\n');
    const assistantMessage = this.streamingAssistantMessageId
      ? this.session.messages.find((message) => message.id === this.streamingAssistantMessageId)
      : undefined;
    if (assistantMessage) {
      assistantMessage.content = content;
      assistantMessage.status = 'complete';
    } else {
      this.session.messages.push({
        id: createId('msg'),
        role: 'assistant',
        content,
        createdAt: Date.now(),
        status: 'complete'
      });
    }

    if (result.changes?.length) {
      const changeSet = await buildChangeSet(result.summary || 'Kraken proposed changes', result.summary, result.changes);
      this.session.changeSets.unshift(changeSet);

      const autoApply = getKrakenConfig().agent.autoApply;
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

    const autoApply = getKrakenConfig().agent.autoApply;
    if (autoApply) {
      await applyChangeSet(changeSet);
      vscode.window.showInformationMessage(`Applied Kraken changes: ${changeSet.title}`);
      return `Created and applied change proposal ${changeSet.id} (${changeSet.files.length} file(s)).`;
    }

    return `Created reviewable change proposal ${changeSet.id} (${changeSet.files.length} file(s)). The user can inspect the diff and apply it from the Kraken panel.`;
  }

  private async addReviewableChangeProposal(summary: string, changes: AgentResult['changes']): Promise<string> {
    if (!changes?.length) {
      throw new Error('A change proposal requires at least one file change.');
    }

    const changeSet = await buildChangeSet(summary || 'Kraken proposed changes', summary, changes);
    this.session.changeSets.unshift(changeSet);
    this.postSession();
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

  private postAssistantMessage(content: string): void {
    this.session.messages.push({
      id: createId('msg'),
      role: 'assistant',
      content,
      createdAt: Date.now()
    });
    this.postSession();
  }

  private postProgress(message: string): void {
    this.webviewView?.webview.postMessage({
      type: 'agent.progress',
      message
    });
  }

  private handleAgentProgress(message: string): void {
    this.postProgress(message);

    const payload = parseProgressPayload(message);
    if (payload?.type === 'run:step') {
      this.finishStreamingAssistantMessage();
      return;
    }
    if (payload?.type === 'assistant:delta') {
      this.appendAssistantDelta(payload.text ?? '');
      return;
    }
    if (payload?.type === 'tool:requested') {
      this.upsertToolMessage(
        payload.toolName ?? 'tool',
        'Requested',
        'running',
        payload.toolUseId,
        payload.toolInput ? { input: payload.toolInput } : undefined
      );
      return;
    }
    if (payload?.type === 'tool:running') {
      this.upsertToolMessage(payload.toolName ?? 'tool', 'Running', 'running', payload.toolUseId);
      return;
    }
    if (payload?.type === 'tool:result') {
      this.upsertToolMessage(payload.toolName ?? 'tool', payload.outputPreview || 'Finished', payload.isError ? 'error' : 'complete', payload.toolUseId);
    }
  }

  private appendAssistantDelta(delta: string): void {
    if (!delta) {
      return;
    }

    let message = this.streamingAssistantMessageId
      ? this.session.messages.find((entry) => entry.id === this.streamingAssistantMessageId)
      : undefined;

    if (!message) {
      message = {
        id: createId('msg'),
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
        status: 'running'
      };
      this.session.messages.push(message);
      this.streamingAssistantMessageId = message.id;
    }

    message.content += delta;
    message.status = 'running';
    this.postSession();
  }

  private finishStreamingAssistantMessage(): void {
    if (!this.streamingAssistantMessageId) {
      return;
    }

    const message = this.session.messages.find((entry) => entry.id === this.streamingAssistantMessageId);
    if (message?.status === 'running') {
      message.status = 'complete';
      this.postSession();
    }
    this.streamingAssistantMessageId = undefined;
  }

  private upsertToolMessage(
    toolName: string,
    content: string,
    status: ChatMessage['status'],
    toolUseId?: string,
    metadata?: Record<string, unknown>
  ): void {
    const normalizedToolName = toolName || 'tool';
    const existing = toolUseId
      ? this.session.messages.find((message) => message.kind === 'tool' && message.toolUseId === toolUseId)
      : undefined;

    if (existing) {
      existing.content = content;
      existing.status = status;
      existing.toolName = normalizedToolName;
      existing.metadata = {
        ...(existing.metadata ?? {}),
        ...(metadata ?? {})
      };
      this.postSession();
      return;
    }

    this.session.messages.push({
      id: createId('msg'),
      role: 'assistant',
      kind: 'tool',
      status,
      toolName: normalizedToolName,
      toolUseId,
      ...(metadata ? { metadata } : {}),
      content,
      createdAt: Date.now()
    });
    this.postSession();
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

function parseProgressPayload(value: string): {
  type: 'run:step' | 'assistant:delta' | 'tool:requested' | 'tool:running' | 'tool:result';
  text?: string;
  toolUseId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  isError?: boolean;
  outputPreview?: string;
} | undefined {
  if (!value.startsWith('{')) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      parsed.type !== 'run:step'
      && parsed.type !== 'assistant:delta'
      && parsed.type !== 'tool:requested'
      && parsed.type !== 'tool:running'
      && parsed.type !== 'tool:result'
    ) {
      return undefined;
    }
    return {
      type: parsed.type,
      text: typeof parsed.text === 'string' ? parsed.text : undefined,
      toolUseId: typeof parsed.toolUseId === 'string' ? parsed.toolUseId : '',
      toolName: typeof parsed.toolName === 'string' && parsed.toolName ? parsed.toolName : 'tool',
      toolInput: isPlainRecord(parsed.toolInput) ? parsed.toolInput : undefined,
      isError: parsed.isError === true,
      outputPreview: typeof parsed.outputPreview === 'string' ? parsed.outputPreview : undefined,
    };
  } catch {
    return undefined;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
