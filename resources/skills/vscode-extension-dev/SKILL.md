---
name: vscode-extension-dev
description: Guidance for developing, debugging, and packaging the Kraken Coder VS Code extension.
---

# VS Code Extension Development

Use this skill when the task touches VS Code activation, commands, webviews, contributed views, SecretStorage, workspace APIs, or extension packaging.

## Workflow

1. Inspect `package.json` contributions before changing command IDs, view IDs, settings, activation events, or menus.
2. Keep extension runtime code in `src/` and compile output in `out/` via `npm run compile`.
3. For webview work, keep Content Security Policy constraints in mind and avoid loading untrusted scripts.
4. Prefer `vscode.Uri`, `vscode.workspace`, and `vscode.window` APIs over manually guessing editor state.
5. Verify with `npm run check` and `npm run compile`.

## Notes

- The extension entrypoint is `src/extension.ts`.
- The chat UI is generated from `src/webview/html.ts`.
- Model configuration and workspace paths are under `src/vscode/`.
