---
name: kraken-tools
description: Guidance for working with Kraken Coder local tools, tool messages, and ReAct tool execution.
---

# Kraken Tools

Use this skill when adding, debugging, or documenting local agent tools.

## Workflow

1. Inspect `src/tools/registry.ts` and the specific tool file before changing tool behavior.
2. Keep tool input schemas accurate because the model depends on them.
3. Return concise, useful tool output; long outputs should be summarized or truncated where appropriate.
4. Keep VS Code-specific tool wiring in `src/vscode/agentTools.ts`.
5. For tool UI changes, verify the progress events from runtime to provider to webview.

## References

- Read `references/tool-message-flow.md` when debugging tool call ordering or UI state.
