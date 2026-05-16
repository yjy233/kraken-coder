import * as vscode from 'vscode';
import { ModelSettings } from '../shared/types';
import { KrakenFileConfig, getKrakenConfig, normalizeBaseUrl, updateGlobalKrakenConfig } from './krakenConfig';

export function getModelSettings(): ModelSettings {
  const config = getKrakenConfig();
  return {
    baseUrl: config.model.baseUrl,
    provider: 'openai-compatible',
    model: config.model.name,
    apiKey: config.model.apiKey,
    ...(config.model.proxy ? { proxy: config.model.proxy } : {})
  };
}

export async function ensureModelConfigured(): Promise<ModelSettings | undefined> {
  let current = getModelSettings();
  if (!current.model) {
    const model = await vscode.window.showInputBox({
      title: 'Kraken model name',
      prompt: 'Enter the OpenAI-compatible model name to use.',
      ignoreFocusOut: true,
      placeHolder: 'gpt-4.1'
    });

    if (!model?.trim()) {
      return undefined;
    }

    await updateGlobalKrakenConfig({
      model: {
        name: model.trim()
      }
    });

    current = {
      ...current,
      model: model.trim()
    };
  }

  if (!current.apiKey) {
    const apiKey = await vscode.window.showInputBox({
      title: 'Kraken API key',
      prompt: 'Enter the API key for your configured OpenAI-compatible provider.',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'sk-...'
    });

    if (!apiKey?.trim()) {
      return undefined;
    }

    await updateGlobalKrakenConfig({
      model: {
        apiKey: apiKey.trim()
      }
    });

    current = {
      ...current,
      apiKey: apiKey.trim()
    };
  }

  return current;
}

export async function configureModel(): Promise<void> {
  ConfigPanel.show();
}

class ConfigPanel {
  private static current?: ConfigPanel;

  static show(): void {
    if (ConfigPanel.current) {
      ConfigPanel.current.panel.reveal(vscode.ViewColumn.One);
      ConfigPanel.current.render();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'krakenConfig',
      'Kraken Config',
      vscode.ViewColumn.One,
      { enableScripts: true }
    );
    ConfigPanel.current = new ConfigPanel(panel);
  }

  private constructor(private readonly panel: vscode.WebviewPanel) {
    this.panel.onDidDispose(() => {
      ConfigPanel.current = undefined;
    });
    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      this.handleMessage(message).catch((error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(text);
        this.panel.webview.postMessage({ type: 'error', message: text });
      });
    });
    this.render();
  }

  render(): void {
    const config = getKrakenConfig();
    this.panel.webview.html = getConfigHtml(this.panel.webview, configToForm(config));
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message)) {
      return;
    }
    if (message.type === 'save' && isRecord(message.values)) {
      const patch = formToConfig(message.values);
      const configPath = await updateGlobalKrakenConfig(patch);
      vscode.window.showInformationMessage(`Kraken config saved: ${configPath}`);
      this.panel.webview.postMessage({ type: 'saved', path: configPath });
      return;
    }
    if (message.type === 'openFile') {
      const configPath = getKrakenConfig().paths.globalConfigPath;
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath));
      await vscode.window.showTextDocument(document, { preview: false });
    }
  }
}

interface ConfigFormValues {
  modelBaseUrl: string;
  modelName: string;
  modelApiKey: string;
  modelProxy: string;
  contextMaxChars: number;
  agentAutoApply: boolean;
  agentAllowTerminal: boolean;
  agentAllowFileWriteTool: boolean;
  agentAllowBrowserTool: boolean;
  agentBrowserBin: string;
  agentBrowserMaxOutput: number;
  agentBrowserDefaultTimeout: number;
  agentMaxSteps: number;
  agentBrowserAllowedDomains: string;
  skillsDir: string;
  memoryEnabled: boolean;
  memoryAutoRead: boolean;
  memoryMaxChars: number;
  memoryAllowWrite: boolean;
  episodesEnabled: boolean;
  episodesAutoCapture: boolean;
  episodesAutoRecall: boolean;
  episodesMaxRecalled: number;
  episodesMaxChars: number;
  episodesStoreTranscript: boolean;
  sessionsEnabled: boolean;
}

function configToForm(config: ReturnType<typeof getKrakenConfig>): ConfigFormValues {
  return {
    modelBaseUrl: config.model.baseUrl,
    modelName: config.model.name,
    modelApiKey: config.model.apiKey,
    modelProxy: config.model.proxy ?? '',
    contextMaxChars: config.context.maxChars,
    agentAutoApply: config.agent.autoApply,
    agentAllowTerminal: config.agent.allowTerminal,
    agentAllowFileWriteTool: config.agent.allowFileWriteTool,
    agentAllowBrowserTool: config.agent.allowBrowserTool,
    agentBrowserBin: config.agent.browserBin,
    agentBrowserMaxOutput: config.agent.browserMaxOutput,
    agentBrowserDefaultTimeout: config.agent.browserDefaultTimeout,
    agentMaxSteps: config.agent.maxSteps,
    agentBrowserAllowedDomains: config.agent.browserAllowedDomains ?? '',
    skillsDir: config.skills.dir ?? '',
    memoryEnabled: config.memory.enabled,
    memoryAutoRead: config.memory.autoRead,
    memoryMaxChars: config.memory.maxChars,
    memoryAllowWrite: config.memory.allowWrite,
    episodesEnabled: config.episodes.enabled,
    episodesAutoCapture: config.episodes.autoCapture,
    episodesAutoRecall: config.episodes.autoRecall,
    episodesMaxRecalled: config.episodes.maxRecalled,
    episodesMaxChars: config.episodes.maxChars,
    episodesStoreTranscript: config.episodes.storeTranscript,
    sessionsEnabled: config.sessions.enabled,
  };
}

function formToConfig(values: Record<string, unknown>): KrakenFileConfig {
  return {
    model: {
      baseUrl: normalizeBaseUrl(stringValue(values.modelBaseUrl, 'https://api.openai.com/v1')),
      name: stringValue(values.modelName, ''),
      apiKey: stringValue(values.modelApiKey, ''),
      proxy: stringValue(values.modelProxy, ''),
    },
    context: {
      maxChars: numberValue(values.contextMaxChars, 60000),
    },
    agent: {
      autoApply: booleanValue(values.agentAutoApply),
      allowTerminal: booleanValue(values.agentAllowTerminal),
      allowFileWriteTool: booleanValue(values.agentAllowFileWriteTool),
      allowBrowserTool: booleanValue(values.agentAllowBrowserTool),
      browserBin: stringValue(values.agentBrowserBin, 'agent-browser'),
      browserMaxOutput: numberValue(values.agentBrowserMaxOutput, 50000),
      browserDefaultTimeout: numberValue(values.agentBrowserDefaultTimeout, 25000),
      maxSteps: numberValue(values.agentMaxSteps, 8),
      browserAllowedDomains: parseDomainList(values.agentBrowserAllowedDomains),
    },
    skills: {
      dir: stringValue(values.skillsDir, ''),
    },
    memory: {
      enabled: booleanValue(values.memoryEnabled),
      autoRead: booleanValue(values.memoryAutoRead),
      maxChars: numberValue(values.memoryMaxChars, 8000),
      allowWrite: booleanValue(values.memoryAllowWrite),
    },
    episodes: {
      enabled: booleanValue(values.episodesEnabled),
      autoCapture: booleanValue(values.episodesAutoCapture),
      autoRecall: booleanValue(values.episodesAutoRecall),
      maxRecalled: numberValue(values.episodesMaxRecalled, 3),
      maxChars: numberValue(values.episodesMaxChars, 12000),
      storeTranscript: booleanValue(values.episodesStoreTranscript),
    },
    sessions: {
      enabled: booleanValue(values.sessionsEnabled),
    },
  };
}

function getConfigHtml(webview: vscode.Webview, values: ConfigFormValues): string {
  const nonce = createNonce();
  const data = JSON.stringify(values).replace(/</g, '\\u003c');
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Kraken Config</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      padding: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .page {
      max-width: 980px;
      margin: 0 auto;
      padding: 18px;
    }
    .topbar {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 18px;
      border-bottom: 1px solid var(--vscode-panel-border);
      padding-bottom: 12px;
    }
    h1 {
      flex: 1;
      margin: 0;
      font-size: 20px;
      font-weight: 600;
    }
    h2 {
      margin: 22px 0 10px;
      font-size: 14px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 12px 14px;
    }
    label {
      display: grid;
      gap: 5px;
      min-width: 0;
    }
    .label {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    input[type="text"],
    input[type="password"],
    input[type="number"] {
      width: 100%;
      min-height: 30px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 5px 7px;
      font: inherit;
    }
    .check {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 30px;
      padding: 3px 0;
    }
    .check input {
      margin: 0;
    }
    button {
      border: 0;
      border-radius: 4px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      padding: 6px 10px;
      font: inherit;
      cursor: pointer;
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    .status {
      min-height: 18px;
      margin-top: 12px;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="topbar">
      <h1>Kraken Config</h1>
      <button class="secondary" id="openFile" type="button">Open TOML</button>
      <button id="save" type="button">Save</button>
    </div>
    <form id="form">
      ${section('Model', [
        text('modelBaseUrl', 'Base URL'),
        text('modelName', 'Model name'),
        password('modelApiKey', 'API key'),
        text('modelProxy', 'HTTP proxy'),
      ])}
      ${section('Context', [
        number('contextMaxChars', 'Max context chars'),
      ])}
      ${section('Agent Tools', [
        checkbox('agentAutoApply', 'Auto apply change proposals'),
        checkbox('agentAllowTerminal', 'Allow shell_command'),
        checkbox('agentAllowFileWriteTool', 'Allow write_file and replace'),
        checkbox('agentAllowBrowserTool', 'Allow agent_browser'),
        text('agentBrowserBin', 'Browser tool executable'),
        number('agentBrowserMaxOutput', 'Browser max output chars'),
        number('agentBrowserDefaultTimeout', 'Browser timeout ms'),
        number('agentMaxSteps', 'Max agent steps'),
        text('agentBrowserAllowedDomains', 'Browser allowed domains'),
      ])}
      ${section('Skills', [
        text('skillsDir', 'Custom skills directory'),
      ])}
      ${section('Memory', [
        checkbox('memoryEnabled', 'Enable memory'),
        checkbox('memoryAutoRead', 'Auto read memory'),
        number('memoryMaxChars', 'Memory max chars'),
        checkbox('memoryAllowWrite', 'Allow memory tool writes'),
      ])}
      ${section('Episodes', [
        checkbox('episodesEnabled', 'Enable episodes'),
        checkbox('episodesAutoCapture', 'Auto capture episodes'),
        checkbox('episodesAutoRecall', 'Auto recall episodes'),
        number('episodesMaxRecalled', 'Max recalled episodes'),
        number('episodesMaxChars', 'Episode max chars'),
        checkbox('episodesStoreTranscript', 'Store transcript'),
      ])}
      ${section('Sessions', [
        checkbox('sessionsEnabled', 'Enable session switcher storage'),
      ])}
    </form>
    <div class="status" id="status"></div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const initialValues = ${data};
    const statusEl = document.getElementById('status');
    for (const [key, value] of Object.entries(initialValues)) {
      const input = document.querySelector('[name="' + key + '"]');
      if (!input) continue;
      if (input.type === 'checkbox') {
        input.checked = Boolean(value);
      } else {
        input.value = value ?? '';
      }
    }
    document.getElementById('save').addEventListener('click', () => {
      vscode.postMessage({ type: 'save', values: collectValues() });
    });
    document.getElementById('openFile').addEventListener('click', () => {
      vscode.postMessage({ type: 'openFile' });
    });
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'saved') {
        statusEl.textContent = 'Saved: ' + event.data.path;
      }
      if (event.data?.type === 'error') {
        statusEl.textContent = event.data.message;
      }
    });
    function collectValues() {
      const values = {};
      for (const input of document.querySelectorAll('[name]')) {
        values[input.name] = input.type === 'checkbox' ? input.checked : input.value;
      }
      return values;
    }
  </script>
</body>
</html>`;
}

function section(title: string, controls: string[]): string {
  return `<section><h2>${escapeHtml(title)}</h2><div class="grid">${controls.join('')}</div></section>`;
}

function text(name: keyof ConfigFormValues, label: string): string {
  return `<label><span class="label">${escapeHtml(label)}</span><input type="text" name="${name}"></label>`;
}

function password(name: keyof ConfigFormValues, label: string): string {
  return `<label><span class="label">${escapeHtml(label)}</span><input type="password" name="${name}"></label>`;
}

function number(name: keyof ConfigFormValues, label: string): string {
  return `<label><span class="label">${escapeHtml(label)}</span><input type="number" name="${name}"></label>`;
}

function checkbox(name: keyof ConfigFormValues, label: string): string {
  return `<label class="check"><input type="checkbox" name="${name}"><span>${escapeHtml(label)}</span></label>`;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 'true';
}

function parseDomainList(value: unknown): string[] {
  return stringValue(value, '').split(',').map((item) => item.trim()).filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
