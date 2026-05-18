# AGENT.md

## Project Overview

Kraken Coder is the current VS Code workspace. Keep this section updated with the project purpose, runtime, and important entry points.
Package description: AI coding assistant for VS Code with chat, context, and reviewable edits.

## Architecture

- Read the local project before making implementation claims.
- Prefer existing module boundaries and project conventions.
- TypeScript configuration is present in `tsconfig.json`.
- VS Code launch configuration is present in `.vscode/launch.json`.

Root entries:
- .vscode/
- CHANGELOG.md
- config.example.toml
- docs/
- kraken-coder-0.1.0.vsix
- LICENSE
- package-lock.json
- package.json
- README.md
- resources/
- src/
- tsconfig.json

## Build And Verification

- `npm run check`: tsc -p ./ --noEmit
- `npm run compile`: tsc -p ./

## Coding Guidelines

- Keep changes scoped to the requested behavior.
- Prefer existing project patterns before adding abstractions.
- Use reviewable change proposals for generated edits.
- Update this file when project commands or conventions change.

## Tool And Permission Notes

- This project is used from VS Code.
- API keys are stored per provider in `~/kraken-coder/config/config.toml` under `[providers.<name>].apiKey`.
- Workspace TOML config overrides global TOML config.
- Do not assume browser, shell, or direct file-write tools are enabled.

## Known Constraints

- If this file becomes long, summarize the task-relevant instructions before working.
- If instructions here conflict with system or tool safety rules, system and tool rules win.

