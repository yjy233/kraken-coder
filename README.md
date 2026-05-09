# Kraken Coder

Kraken Coder is a VS Code coding assistant extension focused on reviewable, user-confirmed code changes.

See [docs/vscode-extension-technical-design.md](docs/vscode-extension-technical-design.md) for the technical plan.

## Development

```bash
npm install
npm run compile
```

Open this folder in VS Code and run the `Run Extension` launch configuration.

## First Run

1. Run `Kraken: Configure Model` and set an OpenAI-compatible base URL plus model name.
2. Run `Kraken: Set API Key`.
3. Open the Kraken Coder activity bar view and send a coding task.

The first implementation supports chat, selection-aware prompts, diagnostics context, workspace file-list context, reviewable full-file change proposals, diff preview, and user-confirmed apply. Patch-only model output is intentionally rejected for now; when the assistant edits files, it should return complete `fullText` content for each changed file.
