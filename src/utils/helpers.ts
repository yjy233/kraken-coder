/**
 * 通用辅助函数集合
 * 被 server、tools、agent 等多个模块共享。
 */

import os from 'node:os'
import path from 'node:path'

/** 将未知值解析为整数，失败时返回 fallback */
export function parseInteger(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value || ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** 将字符串解析为布尔值，支持 1/true/yes/on */
export function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

/** 解析整数并限制在 [min, max] 范围内 */
export function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number'
    ? value
    : parseInteger(typeof value === 'string' ? value : undefined, fallback)
  return Math.max(min, Math.min(max, parsed))
}

/** 清理标题：压缩空格、截断到 60 字符 */
export function sanitizeTitle(value: unknown): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
}

/** 将所有连续空白压缩为单个空格 */
export function collapseWhitespace(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

/** 截断字符串，超出长度时用省略号 */
export function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value
}

/** 判断值是否为普通对象（非 null） */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 校验会话 ID 是否只包含安全字符 */
export function isSafeSessionId(value: unknown): boolean {
  return /^[a-zA-Z0-9-]+$/.test(String(value || ''))
}

/** 展开 `~` 为当前用户 home 目录，并返回绝对路径 */
export function expandHomePath(inputPath: string): string {
  const value = inputPath.trim()
  if (!value) return value
  if (value === '~') return os.homedir()
  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2))
  }
  return value
}
