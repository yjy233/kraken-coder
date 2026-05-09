import * as vscode from 'vscode';

const apiKeySecret = 'kraken.apiKey';

export class SecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  getApiKey(): Thenable<string | undefined> {
    return this.secrets.get(apiKeySecret);
  }

  async setApiKey(): Promise<string | undefined> {
    const key = await vscode.window.showInputBox({
      title: 'Kraken API Key',
      prompt: 'Enter the API key for your configured OpenAI-compatible provider.',
      password: true,
      ignoreFocusOut: true
    });

    if (!key?.trim()) {
      return undefined;
    }

    await this.secrets.store(apiKeySecret, key.trim());
    vscode.window.showInformationMessage('Kraken API key saved.');
    return key.trim();
  }

  async ensureApiKey(): Promise<string | undefined> {
    const existing = await this.getApiKey();
    if (existing) {
      return existing;
    }

    return this.setApiKey();
  }
}

