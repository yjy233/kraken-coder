# Kraken Coder

Kraken Coder is a VS Code coding assistant extension focused on pragmatic coding help, tool use, and reviewable code changes.

See the [technical design](https://github.com/yjy233/kraken-coder/blob/main/docs/vscode-extension-technical-design.md) for implementation notes.

## Development

```bash
npm install
npm run compile
```

Open this folder in VS Code and run the `Run Extension` launch configuration.

## First Run

1. Run `Kraken: Configure Model`.
2. Choose a model/provider and set the provider API key.
3. Open the Kraken Coder activity bar view and send a coding task.

Kraken Coder supports chat, selection-aware prompts, diagnostics context, workspace file-list context, reviewable change proposals, diff preview, user-confirmed apply, attachments, thinking display, usage tracking, sessions, memory, and episode recall.

## Packaging

```bash
npm run compile
npm run vscode:package
```

The generated `.vsix` can be installed locally or published to the VS Code Marketplace with `npm run vscode:publish` after logging in with `vsce`.
