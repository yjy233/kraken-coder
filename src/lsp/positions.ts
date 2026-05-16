import type { LspPosition, LspRange } from './types'

export interface ZeroBasedPosition {
  line: number
  character: number
}

export interface ZeroBasedRange {
  start: ZeroBasedPosition
  end: ZeroBasedPosition
}

export function toZeroBasedPosition(position: LspPosition): ZeroBasedPosition {
  return {
    line: Math.max(0, Math.floor(position.line) - 1),
    character: Math.max(0, Math.floor(position.character) - 1),
  }
}

export function fromZeroBasedPosition(position: ZeroBasedPosition): LspPosition {
  return {
    line: Math.max(1, Math.floor(position.line) + 1),
    character: Math.max(1, Math.floor(position.character) + 1),
  }
}

export function fromZeroBasedRange(range: ZeroBasedRange): LspRange {
  return {
    start: fromZeroBasedPosition(range.start),
    end: fromZeroBasedPosition(range.end),
  }
}

export function normalizeAgentPosition(line: unknown, character: unknown): LspPosition {
  const normalizedLine = Number(line)
  const normalizedCharacter = Number(character)
  if (!Number.isFinite(normalizedLine) || !Number.isFinite(normalizedCharacter)) {
    throw new Error('line and character are required')
  }
  return {
    line: Math.max(1, Math.floor(normalizedLine)),
    character: Math.max(1, Math.floor(normalizedCharacter)),
  }
}
