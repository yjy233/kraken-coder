import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentRuntime } from '../agent/runtime';
import { createId } from '../shared/id';
import {
  AgentResult,
  ChatSessionUsage,
  ChatAttachment,
  ChangeSet,
  ChatMessageStatus,
  ChatMessage,
  ChatSessionSummary,
  ChatSession,
  ContextItem,
  ModelApiMode,
  ModelStatusInfo,
  ModelUsageRecord,
  UsageTotals,
  SlashCompletionItem,
  WebviewToExtensionMessage
} from '../shared/types';
import { createVSCodeToolRegistry } from '../vscode/agentTools';
import { ensureModelConfigured } from '../vscode/config';
import { applyChangeSet, buildChangeSet, openChangeDiff } from '../vscode/edits';
import {
  getActiveSelectionContext,
  getDiagnosticsContext,
  getWorkspaceRoot,
  getWorkspaceTreeContext
} from '../vscode/workspace';
import { getWebviewHtml } from '../webview/html';
import { getKrakenConfig } from '../vscode/krakenConfig';
import { parseSlashCommand } from '../slash/parser';
import { buildSlashHelp, findSlashCommand, getSlashCommands } from '../slash/registry';
import { buildMemoryPaths } from '../memory/paths';
import { loadMemory } from '../memory/reader';
import { getGitBranch } from '../episodes/git';
import { recallEpisodes } from '../episodes/recall';
import { recordEpisode } from '../episodes/recorder';
import { configureSkillPaths } from '../skills/paths';
import { refreshSkills } from '../skills/manager';
import type { Skill } from '../skills/types';
import {
  createEmptyChatSession,
  deleteSession,
  listStoredSessions,
  loadLatestSession,
  loadSession,
  saveSession
} from '../sessions/store';

interface PendingInput {
  id: string;
  messageId: string;
  text: string;
  attachments?: ChatAttachment[];
}

interface CurrentRun {
  id: string;
  abortController: AbortController;
}

interface SlashCommandExecutionOptions {
  messageId?: string;
  markMessageComplete?: boolean;
}

class AgentInterruptedError extends Error {
  constructor(readonly runId: string, readonly reason: 'user' | 'system' = 'user') {
    super('Agent run interrupted.')
  }
}

export class KrakenViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'krakenCoder.chatView';

  private webviewView?: vscode.WebviewView;
  private streamingAssistantMessageId?: string;
  private streamingThinkingMessageId?: string;
  private readonly runtime = new AgentRuntime();
  private session: ChatSession = createEmptyChatSession();
  private sessionSummaries: ChatSessionSummary[] = [];
  private availableSkills: Skill[] = [];
  private currentRun?: CurrentRun;
  private currentCommandId?: string;
  private readonly pendingInputs: PendingInput[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

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

    this.loadInitialSession().catch((error: unknown) => this.showError(error));
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`${KrakenViewProvider.viewType}.focus`);
    await this.postSession();
  }

  async clearSession(): Promise<void> {
    this.currentRun?.abortController.abort();
    this.currentRun = undefined;
    this.currentCommandId = undefined;
    this.pendingInputs.length = 0;
    this.session.messages = [];
    this.session.context = [];
    this.session.changeSets = [];
    this.streamingAssistantMessageId = undefined;
    this.streamingThinkingMessageId = undefined;
    this.syncRuntimeState();
    await this.persistSession();
    await this.postSession();
  }

  async addSelectionToContext(): Promise<void> {
    const context = await getActiveSelectionContext();
    if (!context) {
      vscode.window.showInformationMessage('Open a file or select code before adding context.');
      return;
    }

    this.upsertContext(context);
    await this.postSession();
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
        await this.sendChat(message.text, message.attachments ?? []);
        break;
      case 'agent.stop':
        await this.stopCurrentRun('user');
        break;
      case 'slash.completions':
        await this.postSlashCompletions(message.requestId, message.text, message.cursor);
        break;
      case 'change.apply':
        await this.applyChange(message.changeSetId);
        break;
      case 'change.openDiff':
        await this.openDiff(message.changeSetId, message.filePath);
        break;
      case 'change.reject':
        this.session.changeSets = this.session.changeSets.filter((changeSet) => changeSet.id !== message.changeSetId);
        await this.persistSession();
        await this.postSession();
        break;
      case 'context.remove':
        this.session.context = this.session.context.filter((item) => item.id !== message.contextId);
        await this.persistSession();
        await this.postSession();
        break;
      case 'config.open':
        await vscode.commands.executeCommand('kraken.configureModel');
        break;
      case 'session.clear':
        await this.clearSession();
        break;
      case 'session.new':
        await this.newSession();
        break;
      case 'session.switch':
        await this.switchSession(message.sessionId);
        break;
      case 'session.delete':
        await this.deleteStoredSession(message.sessionId);
        break;
    }
  }

  private async sendChat(text: string, attachments: ChatAttachment[] = []): Promise<void> {
    const userText = text.trim();
    if (!userText && attachments.length === 0) {
      return;
    }

    if (this.currentRun || this.currentCommandId || this.pendingInputs.length > 0) {
      const userMessage: ChatMessage = {
        id: createId('msg'),
        role: 'user',
        content: userText,
        createdAt: Date.now(),
        ...(attachments.length ? { attachments } : {}),
        status: 'queued'
      };
      this.session.messages.push(userMessage);
      this.pendingInputs.push({ id: createId('run'), messageId: userMessage.id, text: userText, attachments });
      this.syncRuntimeState();
      await this.persistSession();
      await this.postSession();
      return;
    }

    const slashInvocation = attachments.length === 0 ? parseSlashCommand(userText) : null;
    if (slashInvocation) {
      await this.runSlashCommand(userText, slashInvocation);
      return;
    }

    await this.runAgentForUserText(userText, { addUserMessage: true, displayText: userText, attachments });
  }

  private async runAgentForUserText(
    userText: string,
    options: { addUserMessage: boolean; displayText?: string; userMessageId?: string; attachments?: ChatAttachment[] }
  ): Promise<void> {
    const settings = await ensureModelConfigured();
    if (!settings) {
      if (options.userMessageId) {
        this.markMessageStatus(options.userMessageId, 'interrupted');
        await this.persistSession();
        await this.postSession();
        await this.drainPendingInputs();
      }
      return;
    }

    const apiKey = settings.apiKey.trim();
    if (!apiKey) {
      if (options.userMessageId) {
        this.markMessageStatus(options.userMessageId, 'interrupted');
        await this.persistSession();
        await this.postSession();
        await this.drainPendingInputs();
      }
      return;
    }

    await this.addAutomaticContext();

    let activeUserMessageId = options.userMessageId;
    if (options.userMessageId) {
      this.markMessageStatus(options.userMessageId, 'running');
    } else if (options.addUserMessage) {
      const userMessage: ChatMessage = {
        id: createId('msg'),
        role: 'user',
        content: options.displayText ?? userText,
        createdAt: Date.now(),
        ...(options.attachments?.length ? { attachments: options.attachments } : {}),
        status: 'running'
      };
      this.session.messages.push(userMessage);
      activeUserMessageId = userMessage.id;
    }

    const runId = createId('run');
    const abortController = new AbortController();
    this.currentRun = { id: runId, abortController };
    this.syncRuntimeState();
    await this.postSession();
    this.webviewView?.webview.postMessage({ type: 'agent.runStarted', runId });
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
      this.availableSkills = availableSkills;
      this.streamingAssistantMessageId = undefined;
      this.streamingThinkingMessageId = undefined;
      const runtimeResult = await this.runtime.run({
        userText,
        sessionId: this.session.id,
        runId,
        history: this.buildRunHistory(options),
        attachments: options.attachments,
        context: this.session.context,
        settings,
        apiKey,
        debugLogDir: path.join(config.paths.globalRoot, 'debug', 'model-api'),
        maxContextChars: config.context.maxChars,
        maxSteps: config.agent.maxSteps,
        tools,
        availableSkills,
        memoryPromptBlock: memory?.promptBlock,
        episodesPromptBlock: recalledEpisodes?.promptBlock,
        onProgress: (message) => this.handleAgentProgress(message),
        signal: abortController.signal,
      });
      const { result, run } = runtimeResult;

      if (abortController.signal.aborted) {
        throw new AgentInterruptedError(runId);
      }

      await this.handleAgentResult(result);
      this.appendRunUsage(run.usage);
      if (activeUserMessageId) {
        this.markMessageStatus(activeUserMessageId, 'complete');
      }
      await recordEpisode({
        workspaceRoot,
        userText,
        result,
        messages: this.session.messages,
        toolMessages: this.session.messages.filter((message) => message.kind === 'tool'),
        branch,
        config: config.episodes,
      });
      await this.persistSession();
    } catch (error) {
      if (abortController.signal.aborted || error instanceof AgentInterruptedError) {
        this.markCurrentRunInterrupted(runId);
        if (activeUserMessageId) {
          this.markMessageStatus(activeUserMessageId, 'complete');
        }
        await this.persistSession();
        this.webviewView?.webview.postMessage({ type: 'agent.runStopped', runId, reason: 'user' });
        return;
      }
      throw error;
    } finally {
      this.streamingAssistantMessageId = undefined;
      this.streamingThinkingMessageId = undefined;
      if (this.currentRun?.id === runId) {
        this.currentRun = undefined;
      }
      this.syncRuntimeState();
      await this.postSession();
      await this.drainPendingInputs();
    }
  }

  private async runSlashCommand(userText: string, invocation: NonNullable<ReturnType<typeof parseSlashCommand>>): Promise<void> {
    const userMessage: ChatMessage = {
      id: createId('msg'),
      role: 'user',
      content: userText,
      createdAt: Date.now(),
      status: 'running'
    };
    this.session.messages.push(userMessage);
    await this.executeSlashCommand(userText, invocation, {
      messageId: userMessage.id,
      markMessageComplete: true,
    });
    await this.drainPendingInputs();
  }

  private async executeSlashCommand(
    userText: string,
    invocation: NonNullable<ReturnType<typeof parseSlashCommand>>,
    options: SlashCommandExecutionOptions = {}
  ): Promise<void> {
    const command = findSlashCommand(invocation.name);
    if (!command) {
      this.postAssistantMessage([
        `Unknown slash command: /${invocation.name}`,
        '',
        buildSlashHelp(),
      ].join('\n'));
      if (options.messageId) {
        this.markMessageStatus(options.messageId, 'complete');
      }
      await this.persistSession();
      await this.postSession();
      return;
    }

    if (options.messageId) {
      this.markMessageStatus(options.messageId, 'running');
    }
    this.currentCommandId = createId('command');
    this.syncRuntimeState();
    await this.postSession();

    try {
      await command.execute(invocation, {
        ...this.buildSlashCommandContext({ userMessageId: options.messageId }),
      });
      if (options.markMessageComplete !== false && options.messageId) {
        this.markMessageStatus(options.messageId, 'complete');
      }
    } finally {
      this.currentCommandId = undefined;
      this.syncRuntimeState();
      await this.persistSession();
      await this.postSession();
    }
  }

  private async stopCurrentRun(reason: 'user' | 'system'): Promise<void> {
    const run = this.currentRun;
    if (!run) {
      return;
    }
    run.abortController.abort();
    this.markCurrentRunInterrupted(run.id);
    this.webviewView?.webview.postMessage({ type: 'agent.runStopped', runId: run.id, reason });
    this.syncRuntimeState();
    await this.persistSession();
    await this.postSession();
  }

  private async drainPendingInputs(): Promise<void> {
    if (this.currentRun || this.currentCommandId || this.pendingInputs.length === 0) {
      this.syncRuntimeState();
      await this.postSession();
      return;
    }

    const next = this.pendingInputs.shift();
    if (!next) {
      this.syncRuntimeState();
      return;
    }
    this.syncRuntimeState();
    await this.postSession();
    await this.runQueuedInput(next);
  }

  private async runQueuedInput(input: PendingInput): Promise<void> {
    const slashInvocation = parseSlashCommand(input.text);
    if (slashInvocation && (!input.attachments || input.attachments.length === 0)) {
      await this.executeSlashCommand(input.text, slashInvocation, {
        messageId: input.messageId,
        markMessageComplete: true,
      });
      await this.drainPendingInputs();
      return;
    }
    await this.runAgentForUserText(input.text, { addUserMessage: false, userMessageId: input.messageId, attachments: input.attachments });
  }

  private markMessageStatus(messageId: string, status: ChatMessageStatus): void {
    const message = this.session.messages.find((entry) => entry.id === messageId);
    if (message) {
      message.status = status;
    }
  }

  private syncRuntimeState(): void {
    this.session.activeRunId = this.currentRun && !this.currentRun.abortController.signal.aborted
      ? this.currentRun.id
      : undefined;
    this.session.queueLength = this.pendingInputs.length;
    this.session.busy = Boolean(this.currentRun) || Boolean(this.currentCommandId) || this.pendingInputs.length > 0;
  }

  private markCurrentRunInterrupted(runId: string): void {
    this.finishStreamingAssistantMessage('interrupted', {
      interrupted: true,
      runId,
      interruptedAt: Date.now()
    });
    this.finishStreamingThinkingMessage('interrupted', {
      interrupted: true,
      runId,
      interruptedAt: Date.now()
    });
    if (!this.session.messages.some((message) => message.metadata?.runId === runId && message.status === 'interrupted')) {
      this.session.messages.push({
        id: createId('msg'),
        role: 'assistant',
        content: 'Interrupted.',
        createdAt: Date.now(),
        status: 'interrupted',
        metadata: {
          interrupted: true,
          runId,
          interruptedAt: Date.now()
        }
      });
    }
    for (const message of this.session.messages) {
      if ((message.kind === 'tool' || message.kind === 'thinking') && message.status === 'running') {
        message.status = 'interrupted';
        message.metadata = {
          ...(message.metadata ?? {}),
          interrupted: true,
          runId,
        };
      }
    }
  }

  private buildRunHistory(options: { addUserMessage: boolean; userMessageId?: string }): ChatMessage[] {
    let history = this.session.messages.filter(
      (message) => message.status !== 'queued' && message.kind !== 'tool' && message.kind !== 'thinking'
    );
    if (options.userMessageId) {
      history = history.filter((message) => message.id !== options.userMessageId);
    } else if (options.addUserMessage) {
      history = history.slice(0, -1);
    }
    return history;
  }

  private buildSlashCommandContext(options: { userMessageId?: string } = {}): Parameters<NonNullable<ReturnType<typeof findSlashCommand>>['execute']>[1] {
    return {
      workspaceRoot: getWorkspaceRoot()?.fsPath,
      globalRoot: getKrakenConfig({ extensionRoot: this.extensionUri.fsPath }).paths.globalRoot,
      getSlashHelp: () => buildSlashHelp(),
      postAssistantMessage: (content) => this.postAssistantMessage(content),
      postProgress: (message) => this.postProgress(message),
      clearSession: () => this.clearSession(),
      addReviewableChangeProposal: (summary, changes) => this.addReviewableChangeProposal(summary, changes),
      openFile: async (filePath) => {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.window.showTextDocument(document, { preview: false });
      },
      getAvailableSkills: () => this.getAvailableSkills(),
      runAgent: (agentText) => this.runAgentForUserText(agentText, {
        addUserMessage: false,
        userMessageId: options.userMessageId,
      }),
    };
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
    await this.persistSession();
  }

  private appendRunUsage(records: Array<ModelUsageRecord | null>): void {
    const normalized = records
      .map((record) => normalizeUsageRecord(record))
      .filter((record): record is ModelUsageRecord => Boolean(record))
      .map((record) => ({
        ...record,
        sessionId: this.session.id,
      }));

    if (!normalized.length) {
      return;
    }

    const usage = this.session.usage ?? createEmptySessionUsage();
    usage.records = [...usage.records, ...normalized].slice(-500);
    usage.totals = buildUsageTotals(usage.records);
    this.session.usage = usage;
  }

  private async addChangeProposal(summary: string, changes: AgentResult['changes']): Promise<string> {
    if (!changes?.length) {
      throw new Error('propose_changes requires at least one file change.');
    }

    const changeSet = await buildChangeSet(summary || 'Kraken proposed changes', summary, changes);
    this.session.changeSets.unshift(changeSet);
    await this.persistSession();
    await this.postSession();

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
    await this.persistSession();
    await this.postSession();
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

  private async postSlashCompletions(requestId: string, text: string, cursor: number): Promise<void> {
    this.webviewView?.webview.postMessage({
      type: 'slash.completions',
      requestId,
      items: this.buildSlashCompletionItems(text, cursor)
    });
  }

  private buildSlashCompletionItems(text: string, cursor: number): SlashCompletionItem[] {
    const cursorIndex = Math.max(0, Math.min(cursor, text.length));
    const beforeCursor = text.slice(0, cursorIndex);
    if (!beforeCursor.startsWith('/') || beforeCursor.includes('\n')) {
      return [];
    }

    const skillArgMatch = beforeCursor.match(/^\/(?:skill|use-skill)\s+([^\s]*)$/i);
    if (skillArgMatch) {
      const query = (skillArgMatch[1] ?? '').toLowerCase();
      const replaceStart = beforeCursor.length - (skillArgMatch[1] ?? '').length;
      return this.getAvailableSkills()
        .map((skill): SlashCompletionItem => ({
          id: `skill:${skill.name}`,
          kind: 'skill',
          label: skill.name,
          insertText: `${skill.name} `,
          detail: '/skill',
          description: skill.description,
          replaceStart,
          replaceEnd: cursorIndex,
        }))
        .filter((item) => matchesSlashCompletion(item, query))
        .slice(0, 20);
    }

    if (!/^\/[^\s]*$/.test(beforeCursor)) {
      return [];
    }

    const query = beforeCursor.slice(1).toLowerCase();
    const commandItems = getSlashCommands()
      .map((command): SlashCompletionItem => ({
        id: `command:${command.name}`,
        kind: 'command',
        label: `/${command.name}`,
        insertText: command.name === 'skill' ? '/skill ' : `${command.usage.split(/\s+/)[0]} `,
        detail: command.usage,
        description: command.description,
        replaceStart: 0,
        replaceEnd: cursorIndex,
      }));

    const skillItems = this.getAvailableSkills()
      .map((skill): SlashCompletionItem => ({
        id: `skill:${skill.name}`,
        kind: 'skill',
        label: skill.name,
        insertText: `/skill ${skill.name} `,
        detail: '/skill',
        description: skill.description,
        replaceStart: 0,
        replaceEnd: cursorIndex,
      }));

    return [...commandItems, ...skillItems]
      .filter((item) => matchesSlashCompletion(item, query))
      .slice(0, 20);
  }

  private getAvailableSkills(): Skill[] {
    const config = getKrakenConfig({ extensionRoot: this.extensionUri.fsPath });
    configureSkillPaths({
      globalSkillDir: config.paths.globalSkillDir,
      legacyGlobalSkillDir: config.paths.legacyGlobalSkillDir,
      workspaceSkillDir: config.paths.workspaceSkillDir,
      legacyWorkspaceSkillDir: config.paths.legacyWorkspaceSkillDir,
      installRoot: config.skills.dir,
      builtinSkillDir: config.paths.builtinSkillDir,
    });
    this.availableSkills = refreshSkills();
    return this.availableSkills;
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
    await this.persistSession();
    await this.postSession();
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

  private async loadInitialSession(): Promise<void> {
    this.session = await loadLatestSession(getWorkspaceRoot()?.fsPath);
    this.currentRun = undefined;
    this.currentCommandId = undefined;
    this.pendingInputs.length = 0;
    this.streamingAssistantMessageId = undefined;
    this.streamingThinkingMessageId = undefined;
    this.syncRuntimeState();
    await this.postSession();
  }

  private async newSession(): Promise<void> {
    if (this.session.busy) {
      await this.stopCurrentRun('user');
    }
    if (this.session.busy) {
      return;
    }
    await this.persistSession();
    this.session = createEmptyChatSession();
    this.streamingAssistantMessageId = undefined;
    this.streamingThinkingMessageId = undefined;
    this.currentCommandId = undefined;
    this.syncRuntimeState();
    await this.persistSession();
    await this.postSession();
  }

  private async switchSession(sessionId: string): Promise<void> {
    if (sessionId === this.session.id) {
      return;
    }
    if (this.session.busy) {
      await this.stopCurrentRun('user');
    }
    if (this.session.busy) {
      return;
    }
    await this.persistSession();
    const loaded = await loadSession(getWorkspaceRoot()?.fsPath, sessionId);
    if (!loaded) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    this.session = loaded;
    this.streamingAssistantMessageId = undefined;
    this.streamingThinkingMessageId = undefined;
    this.currentCommandId = undefined;
    this.syncRuntimeState();
    await this.postSession();
  }

  private async deleteStoredSession(sessionId: string): Promise<void> {
    if (this.session.busy) {
      await this.stopCurrentRun('user');
    }
    if (this.session.busy) {
      return;
    }
    await deleteSession(getWorkspaceRoot()?.fsPath, sessionId);
    if (sessionId === this.session.id) {
      this.session = await loadLatestSession(getWorkspaceRoot()?.fsPath);
      this.streamingAssistantMessageId = undefined;
      this.streamingThinkingMessageId = undefined;
      this.currentCommandId = undefined;
      this.syncRuntimeState();
    }
    await this.postSession();
  }

  private async persistSession(): Promise<void> {
    await saveSession(getWorkspaceRoot()?.fsPath, this.session);
  }

  private async postSession(): Promise<void> {
    this.sessionSummaries = await listStoredSessions(getWorkspaceRoot()?.fsPath);
    this.webviewView?.webview.postMessage({
      type: 'session.updated',
      session: this.session,
      sessions: this.sessionSummaries,
      modelInfo: buildModelStatusInfo(
        getKrakenConfig({ extensionRoot: this.extensionUri.fsPath }),
        this.session.context
      )
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
      this.finishStreamingThinkingMessage();
      return;
    }
    if (payload?.type === 'assistant:delta') {
      this.finishStreamingThinkingMessage();
      this.appendAssistantDelta(payload.text ?? '');
      return;
    }
    if (payload?.type === 'assistant:thinking_delta') {
      this.appendThinkingDelta(payload.text ?? '');
      return;
    }
    if (payload?.type === 'tool:requested') {
      this.finishStreamingThinkingMessage();
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
      this.upsertToolMessage(payload.toolName ?? 'tool', payload.outputPreview || 'Running', 'running', payload.toolUseId);
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

  private appendThinkingDelta(delta: string): void {
    if (!delta) {
      return;
    }

    let message = this.streamingThinkingMessageId
      ? this.session.messages.find((entry) => entry.id === this.streamingThinkingMessageId)
      : undefined;

    if (!message) {
      message = {
        id: createId('msg'),
        role: 'assistant',
        kind: 'thinking',
        content: '',
        createdAt: Date.now(),
        status: 'running'
      };
      this.session.messages.push(message);
      this.streamingThinkingMessageId = message.id;
    }

    message.content += delta;
    message.status = 'running';
    this.postSession();
  }

  private finishStreamingAssistantMessage(
    status: Extract<ChatMessageStatus, 'complete' | 'interrupted'> = 'complete',
    metadata?: Record<string, unknown>
  ): void {
    if (!this.streamingAssistantMessageId) {
      return;
    }

    const message = this.session.messages.find((entry) => entry.id === this.streamingAssistantMessageId);
    if (message?.status === 'running') {
      message.status = status;
      if (metadata) {
        message.metadata = {
          ...(message.metadata ?? {}),
          ...metadata,
        };
      }
      this.postSession();
    }
    this.streamingAssistantMessageId = undefined;
  }

  private finishStreamingThinkingMessage(
    status: Extract<ChatMessageStatus, 'complete' | 'interrupted'> = 'complete',
    metadata?: Record<string, unknown>
  ): void {
    if (!this.streamingThinkingMessageId) {
      return;
    }

    const message = this.session.messages.find((entry) => entry.id === this.streamingThinkingMessageId);
    if (message?.status === 'running') {
      message.status = status;
      if (metadata) {
        message.metadata = {
          ...(message.metadata ?? {}),
          ...metadata,
        };
      }
      this.postSession();
    }
    this.streamingThinkingMessageId = undefined;
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
    this.currentRun = undefined;
    this.currentCommandId = undefined;
    this.syncRuntimeState();
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
  type: 'run:step' | 'assistant:delta' | 'assistant:thinking_delta' | 'tool:requested' | 'tool:running' | 'tool:result';
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
      && parsed.type !== 'assistant:thinking_delta'
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

function createEmptySessionUsage(): ChatSessionUsage {
  return {
    records: [],
    totals: createEmptyUsageTotals(),
  };
}

function createEmptyUsageTotals(): UsageTotals {
  return {
    requestCount: 0,
    completedRequestCount: 0,
    interruptedRequestCount: 0,
    errorRequestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    reasoningOutputTokens: 0,
    visibleOutputTokens: 0,
    cachedInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0,
  };
}

function buildUsageTotals(records: ModelUsageRecord[]): UsageTotals {
  const totals = createEmptyUsageTotals();
  for (const record of records) {
    totals.requestCount += 1;
    if (record.status === 'complete') {
      totals.completedRequestCount += 1;
    } else if (record.status === 'interrupted') {
      totals.interruptedRequestCount += 1;
    } else if (record.status === 'error') {
      totals.errorRequestCount += 1;
    }
    totals.inputTokens += safeNumber(record.inputTokens);
    totals.outputTokens += safeNumber(record.outputTokens);
    totals.totalTokens += safeNumber(record.totalTokens);
    totals.reasoningOutputTokens += safeNumber(record.reasoningOutputTokens);
    totals.visibleOutputTokens += safeNumber(record.visibleOutputTokens);
    totals.cachedInputTokens += safeNumber(record.cachedInputTokens);
    totals.cacheReadInputTokens += safeNumber(record.cacheReadInputTokens);
    totals.cacheCreationInputTokens += safeNumber(record.cacheCreationInputTokens);
    totals.costUsd += safeNumber(record.costUsd);
  }
  return totals;
}

function safeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeUsageRecord(value: ModelUsageRecord | null): ModelUsageRecord | undefined {
  if (!value || typeof value.id !== 'string' || typeof value.provider !== 'string' || typeof value.api !== 'string' || typeof value.model !== 'string') {
    return undefined;
  }

  const record: ModelUsageRecord = {
    id: value.id,
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
    runId: typeof value.runId === 'string' ? value.runId : undefined,
    step: asFiniteNumber(value.step),
    provider: value.provider as ModelUsageRecord['provider'],
    api: value.api as ModelApiMode,
    model: value.model,
    stream: value.stream === true,
    status: value.status === 'interrupted' || value.status === 'error' ? value.status : 'complete',
    source: value.source === 'missing' || value.source === 'provider-stream-final' ? value.source : 'provider-final',
    startedAt: asFiniteNumber(value.startedAt) ?? Date.now(),
    completedAt: asFiniteNumber(value.completedAt),
    inputTokens: asFiniteNumber(value.inputTokens),
    outputTokens: asFiniteNumber(value.outputTokens),
    totalTokens: asFiniteNumber(value.totalTokens),
    reasoningOutputTokens: asFiniteNumber(value.reasoningOutputTokens),
    visibleOutputTokens: asFiniteNumber(value.visibleOutputTokens),
    cachedInputTokens: asFiniteNumber(value.cachedInputTokens),
    cacheReadInputTokens: asFiniteNumber(value.cacheReadInputTokens),
    cacheCreationInputTokens: asFiniteNumber(value.cacheCreationInputTokens),
    cacheCreationInputTokens5m: asFiniteNumber(value.cacheCreationInputTokens5m),
    cacheCreationInputTokens1h: asFiniteNumber(value.cacheCreationInputTokens1h),
    textInputTokens: asFiniteNumber(value.textInputTokens),
    imageInputTokens: asFiniteNumber(value.imageInputTokens),
    videoInputTokens: asFiniteNumber(value.videoInputTokens),
    audioInputTokens: asFiniteNumber(value.audioInputTokens),
    textOutputTokens: asFiniteNumber(value.textOutputTokens),
    audioOutputTokens: asFiniteNumber(value.audioOutputTokens),
    serverToolUse: isPlainRecord(value.serverToolUse) ? value.serverToolUse : undefined,
    rawUsage: isPlainRecord(value.rawUsage) ? value.rawUsage : undefined,
  };

  record.costUsd = estimateUsageCostUsd(record);
  return record;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function estimateUsageCostUsd(record: ModelUsageRecord): number | undefined {
  const pricing = getPricingProfile(record.provider, record.model);
  if (!pricing) {
    return undefined;
  }

  const inputCost = (safeNumber(record.inputTokens) / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (safeNumber(record.outputTokens) / 1_000_000) * pricing.outputPerMillion;
  const cacheReadCost = pricing.cacheReadPerMillion !== undefined
    ? (safeNumber(record.cacheReadInputTokens || record.cachedInputTokens) / 1_000_000) * pricing.cacheReadPerMillion
    : 0;
  const cacheWriteCost = pricing.cacheWritePerMillion !== undefined
    ? (safeNumber(record.cacheCreationInputTokens) / 1_000_000) * pricing.cacheWritePerMillion
    : 0;

  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

function getPricingProfile(provider: ModelUsageRecord['provider'], model: string): {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
} | undefined {
  if (provider === 'openai' || provider === 'openrouter') {
    if (model === 'openai/gpt-5.5') {
      return { inputPerMillion: 1.25, outputPerMillion: 10 };
    }
    if (model === 'openai/gpt-5.4') {
      return { inputPerMillion: 1.25, outputPerMillion: 10 };
    }
  }

  if (provider === 'anthropic' || provider === 'openrouter') {
    if (model === 'anthropic/claude-sonnet-4.6') {
      return { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 };
    }
    if (model === 'anthropic/claude-opus-4.7-fast') {
      return { inputPerMillion: 15, outputPerMillion: 75, cacheReadPerMillion: 1.5, cacheWritePerMillion: 18.75 };
    }
  }

  if (provider === 'qwen' || provider === 'openrouter') {
    if (model === 'qwen/qwen3.6-plus') {
      return { inputPerMillion: 0.8, outputPerMillion: 8 };
    }
  }

  return undefined;
}

function buildModelStatusInfo(config: ReturnType<typeof getKrakenConfig>, context: ContextItem[]): ModelStatusInfo {
  const provider = config.model.provider;
  const contextUsedChars = context.reduce((total, item) => {
    const header = `Context: ${item.label}${item.path ? ` (${item.path})` : ''}`;
    return total + header.length + item.content.length;
  }, 0);
  const contextMaxChars = Math.max(1, config.context.maxChars);
  const contextUsagePercent = Math.min(999, Math.round((contextUsedChars / contextMaxChars) * 100));
  const base = {
    provider,
    api: config.model.api,
    model: config.model.name,
    effort: config.model.reasoning.effort,
    reasoningEnabled: config.model.reasoning.enabled,
    cacheEnabled: config.model.cache.enabled,
    cacheStrategy: config.model.cache.strategy,
    contextUsedChars,
    contextMaxChars,
    contextUsagePercent,
  };

  if (provider === 'anthropic') {
    return {
      ...base,
      api: config.providers.anthropic.api,
      effort: config.providers.anthropic.effort,
      thinking: config.providers.anthropic.thinking,
      cacheMode: config.providers.anthropic.cacheTtl,
    };
  }

  if (provider === 'qwen') {
    return {
      ...base,
      api: config.providers.qwen.api,
      thinking: config.providers.qwen.enableThinking ? 'enabled' : 'disabled',
      cacheMode: config.providers.qwen.cacheMode,
    };
  }

  if (provider === 'openai') {
    return {
      ...base,
      api: config.providers.openai.api,
      effort: config.providers.openai.effort,
      cacheMode: config.providers.openai.promptCacheRetention,
    };
  }

  if (provider === 'openrouter') {
    return {
      ...base,
      api: 'chat-completions',
      thinking: config.model.reasoning.enabled ? 'enabled' : 'disabled',
      cacheMode: 'provider',
    };
  }

  return base;
}

function matchesSlashCompletion(item: SlashCompletionItem, query: string): boolean {
  if (!query) {
    return true;
  }

  const normalizedLabel = item.label.toLowerCase().replace(/^\//, '');
  const normalizedInsertText = item.insertText.toLowerCase().replace(/^\//, '');
  const normalizedDescription = item.description?.toLowerCase() ?? '';
  return normalizedLabel.includes(query)
    || normalizedInsertText.includes(query)
    || normalizedDescription.includes(query);
}
