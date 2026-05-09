import * as vscode from 'vscode';
import { ModelSettings } from '../shared/types';

export function getModelSettings(): ModelSettings {
  const config = vscode.workspace.getConfiguration('kraken');
  return {
    baseUrl: normalizeBaseUrl(config.get<string>('model.baseUrl') ?? 'https://api.openai.com/v1'),
    provider: 'openai-compatible',
    model: config.get<string>('model.name')?.trim() ?? ''
  };
}

export async function ensureModelConfigured(): Promise<ModelSettings | undefined> {
  const current = getModelSettings();
  if (current.model) {
    return current;
  }

  const model = await vscode.window.showInputBox({
    title: 'Kraken model name',
    prompt: 'Enter the OpenAI-compatible model name to use.',
    ignoreFocusOut: true,
    placeHolder: 'gpt-4.1'
  });

  if (!model?.trim()) {
    return undefined;
  }

  await vscode.workspace
    .getConfiguration('kraken')
    .update('model.name', model.trim(), vscode.ConfigurationTarget.Global);

  return {
    ...current,
    model: model.trim()
  };
}

export async function configureModel(): Promise<void> {
  const settings = getModelSettings();
  const baseUrl = await vscode.window.showInputBox({
    title: 'Kraken model base URL',
    prompt: 'Enter an OpenAI-compatible base URL.',
    ignoreFocusOut: true,
    value: settings.baseUrl
  });

  if (!baseUrl?.trim()) {
    return;
  }

  const model = await vscode.window.showInputBox({
    title: 'Kraken model name',
    prompt: 'Enter the model name.',
    ignoreFocusOut: true,
    value: settings.model
  });

  if (!model?.trim()) {
    return;
  }

  const config = vscode.workspace.getConfiguration('kraken');
  await config.update('model.baseUrl', normalizeBaseUrl(baseUrl), vscode.ConfigurationTarget.Global);
  await config.update('model.name', model.trim(), vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage('Kraken model configuration updated.');
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

