---
name: skill-creator
description: Guide for creating or updating Kraken Coder skills with clear instructions, compact context, and correct SKILL.md structure.
---

# Skill Creator

Use this skill when the user wants to create, update, review, or install a local Kraken Coder skill.

## Target Locations

Prefer the user's requested location. When unspecified:

1. Workspace skill: `<workspace>/.kraken-coder/skills/<skill-name>/SKILL.md`
2. Global skill: `~/kraken-coder/skills/<skill-name>/SKILL.md`
3. Built-in skill: `resources/skills/<skill-name>/SKILL.md` only when modifying the extension repo itself.

Legacy `skill` directories may exist, but new skills should use plural `skills`.

## Required Structure

Every skill must contain a `SKILL.md` file:

```markdown
---
name: example-skill
description: Clear trigger conditions and the capability this skill provides.
---

# Example Skill

Use this skill when ...

## Workflow

1. ...
2. ...
```

The frontmatter must include `name` and `description`. Keep the name lowercase and URL-safe, using hyphens between words.

Optional directories:

- `references/`: task-specific docs loaded only when needed.
- `scripts/`: deterministic helper scripts.
- `assets/`: templates or files used to produce output.

Do not add extra files such as `README.md`, changelogs, or installation guides unless the user explicitly asks.

## Writing Rules

- Keep `SKILL.md` concise; include only instructions the agent needs at runtime.
- Put detailed reference material in `references/` and link to it from `SKILL.md`.
- Make the `description` specific enough for the model to decide when to activate the skill.
- Prefer actionable workflow steps over broad background explanation.
- Avoid duplicating the same information in both `SKILL.md` and reference files.
- Include validation steps when the skill changes code, configuration, data, or generated assets.

## Update Workflow

1. Inspect the existing skill directory before editing.
2. Preserve the skill name unless the user explicitly requests a rename.
3. Keep edits scoped to the behavior the user asked for.
4. If references or scripts are added, mention when the agent should read or run them.
5. Validate the final `SKILL.md` still has valid frontmatter and a useful activation description.

## Kraken Coder Notes

- Available skills are listed in the system prompt by name and description.
- The agent must call the `skill` tool with `action="activate"` before relying on a skill body.
- References are read with the `skill` tool using `action="read_reference"` and paths under `references/`.
- Workspace skills override global and built-in skills with the same name.
