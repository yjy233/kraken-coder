# Tool Message Flow

Tool calls flow through these layers:

1. `src/agent/loop-query.ts` receives model tool calls.
2. `src/agent/runtime.ts` emits progress events.
3. `src/providers/krakenViewProvider.ts` stores tool messages in the chat session.
4. `src/webview/html.ts` renders collapsed tool cards.

Keep tool call IDs stable so UI state such as expanded cards can survive streaming re-renders.
