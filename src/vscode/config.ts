import * as vscode from 'vscode';
import { ModelSettings } from '../shared/types';
import { getKrakenConfig, normalizeBaseUrl, updateGlobalKrakenConfig } from './krakenConfig';

export function getModelSettings(): ModelSettings {
  const config = getKrakenConfig();
  return {
    baseUrl: config.model.baseUrl,
    provider: 'openai-compatible',
    model: config.model.name
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

  await updateGlobalKrakenConfig({
    model: {
      name: model.trim()
    }
  });

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

  const configPath = await updateGlobalKrakenConfig({
    model: {
      baseUrl: normalizeBaseUrl(baseUrl),
      name: model.trim()
    }
  });
  vscode.window.showInformationMessage(`Kraken model configuration updated: ${configPath}`);
}
