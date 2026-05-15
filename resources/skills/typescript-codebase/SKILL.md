---
name: typescript-codebase
description: Guidance for safe TypeScript changes in the Kraken Coder codebase.
---

# TypeScript Codebase Work

Use this skill for TypeScript implementation, refactors, type fixes, or module-boundary changes.

## Workflow

1. Read the local types and call sites before changing exported interfaces.
2. Preserve strict TypeScript behavior and avoid weakening types to `any`.
3. Keep imports aligned with the existing module style.
4. Prefer focused changes over broad refactors.
5. Run `npm run check` before finishing.

## Conventions

- Source files use TypeScript under `src/`.
- Compiled CommonJS output is generated under `out/`.
- Shared UI/runtime contracts live in `src/shared/types.ts`.
