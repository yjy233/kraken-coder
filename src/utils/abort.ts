export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Operation interrupted.')
  }
}

export function combineAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal))
  if (activeSignals.length === 0) {
    return undefined
  }
  if (activeSignals.length === 1) {
    return activeSignals[0]
  }

  const controller = new AbortController()
  const abort = () => controller.abort()
  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort()
      break
    }
    signal.addEventListener('abort', abort, { once: true })
  }
  return controller.signal
}
