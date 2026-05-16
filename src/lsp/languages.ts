import path from 'node:path'
import type { LspLanguage } from './types'

const extensionToLanguage = new Map<string, LspLanguage>([
  ['.ts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.mts', 'typescript'],
  ['.cts', 'typescript'],
  ['.go', 'go'],
  ['.py', 'python'],
  ['.pyi', 'python'],
])

export const defaultLspLanguages: LspLanguage[] = ['typescript', 'go', 'python']

export function detectLspLanguage(filePath: string): LspLanguage | undefined {
  return extensionToLanguage.get(path.extname(filePath).toLowerCase())
}

export function isLspLanguage(value: unknown): value is LspLanguage {
  return value === 'typescript' || value === 'go' || value === 'python'
}

export function normalizeLspLanguages(value: unknown): LspLanguage[] {
  if (!Array.isArray(value)) {
    return defaultLspLanguages
  }
  const result = value.filter(isLspLanguage)
  return result.length ? Array.from(new Set(result)) : defaultLspLanguages
}

export function lspLanguageMatchesPath(language: LspLanguage, filePath: string): boolean {
  return detectLspLanguage(filePath) === language
}
