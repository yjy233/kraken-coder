import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { FileChange } from '../../shared/types';
import type { SlashCommand, SlashCommandInvocation } from '../types';

interface WorkspaceSnapshot {
  root: string;
  rootEntries: string[];
  packageJson?: PackageSummary;
  readmeTitle?: string;
  hasTsConfig: boolean;
  hasVSCodeLaunch: boolean;
  hasExistingAgent: boolean;
  hasWorkspaceConfig: boolean;
  hasSkillKeep: boolean;
  existingAgentText?: string;
}

interface PackageSummary {
  name?: string;
  description?: string;
  scripts: Record<string, string>;
  dependencies: string[];
  devDependencies: string[];
}

const agentPath = 'AGENT.md';
const workspaceConfigPath = 'kraken-coder/config/config.toml';
const skillKeepPath = '.kraken-coder/skills/.gitkeep';

export const initCommand: SlashCommand = {
  name: 'init',
  description: 'Create a reviewable AGENT.md and workspace Kraken config proposal.',
  usage: '/init [--force] [--refresh] [--dry-run]',
  execute: async (invocation, context) => {
    if (!context.workspaceRoot) {
      context.postAssistantMessage('/init requires an open VS Code workspace folder.');
      return;
    }

    context.postProgress('Running /init...');
    const snapshot = await inspectWorkspace(context.workspaceRoot);
    const dryRun = hasFlag(invocation, 'dry_run');
    const force = hasFlag(invocation, 'force');
    const refresh = hasFlag(invocation, 'refresh');

    if (snapshot.hasExistingAgent && !force && !refresh) {
      context.postAssistantMessage([
        'AGENT.md already exists.',
        '',
        'Use `/init --refresh` to propose updates, or `/init --force` to propose a replacement.',
      ].join('\n'));
      return;
    }

    const changes = buildInitChanges(snapshot, { force, refresh });
    if (dryRun) {
      context.postAssistantMessage([
        '/init dry run. The following files would be proposed:',
        '',
        ...changes.map((change) => `- ${change.path} (${change.type})`),
      ].join('\n'));
      return;
    }

    if (!changes.length) {
      context.postAssistantMessage('No /init changes are needed.');
      return;
    }

    context.postProgress('Creating /init change proposal...');
    const result = await context.addReviewableChangeProposal('Initialize Kraken Coder workspace', changes);
    context.postAssistantMessage([
      'Prepared Kraken Coder workspace initialization.',
      '',
      result,
      '',
      'Files:',
      ...changes.map((change) => `- ${change.path}`),
    ].join('\n'));
  },
};

async function inspectWorkspace(root: string): Promise<WorkspaceSnapshot> {
  const rootEntries = await listRootEntries(root);
  const packageJson = await readPackageSummary(path.join(root, 'package.json'));
  const readmeTitle = await readReadmeTitle(root);

  const existingAgentText = await readTextFile(path.join(root, agentPath));

  return {
    root,
    rootEntries,
    packageJson,
    readmeTitle,
    hasTsConfig: await pathExists(path.join(root, 'tsconfig.json')),
    hasVSCodeLaunch: await pathExists(path.join(root, '.vscode', 'launch.json')),
    hasExistingAgent: await pathExists(path.join(root, agentPath)),
    hasWorkspaceConfig: await pathExists(path.join(root, workspaceConfigPath)),
    hasSkillKeep: await pathExists(path.join(root, skillKeepPath)),
    existingAgentText,
  };
}

function buildInitChanges(snapshot: WorkspaceSnapshot, options: { force: boolean; refresh: boolean }): FileChange[] {
  const changes: FileChange[] = [];
  if (!snapshot.hasExistingAgent || options.force || options.refresh) {
    changes.push({
      path: agentPath,
      type: snapshot.hasExistingAgent ? 'modify' : 'create',
      fullText: buildAgentMd(snapshot, options),
      rationale: 'Create project instructions for Kraken Coder agents.',
    });
  }

  if (!snapshot.hasWorkspaceConfig || options.force) {
    changes.push({
      path: workspaceConfigPath,
      type: snapshot.hasWorkspaceConfig ? 'modify' : 'create',
      fullText: buildWorkspaceConfigToml(),
      rationale: 'Create workspace-level Kraken Coder configuration.',
    });
  }

  if (!snapshot.hasSkillKeep) {
    changes.push({
      path: skillKeepPath,
      type: 'create',
      fullText: '',
      rationale: 'Create the workspace skill directory.',
    });
  }

  return changes;
}

function buildAgentMd(snapshot: WorkspaceSnapshot, options: { force: boolean; refresh: boolean }): string {
  if (options.refresh && !options.force && snapshot.existingAgentText) {
    return appendRefreshNotes(snapshot.existingAgentText, snapshot);
  }

  const packageJson = snapshot.packageJson;
  const title = snapshot.readmeTitle || packageJson?.name || path.basename(snapshot.root);
  const scripts = packageJson?.scripts ?? {};
  const verification = buildVerificationLines(scripts);
  const rootEntries = snapshot.rootEntries.slice(0, 40);

  const lines: Array<string | undefined> = [
    '# AGENT.md',
    '',
    '## Project Overview',
    '',
    `${title} is the current VS Code workspace. Keep this section updated with the project purpose, runtime, and important entry points.`,
    packageJson?.description ? `Package description: ${packageJson.description}` : undefined,
    '',
    '## Architecture',
    '',
    '- Read the local project before making implementation claims.',
    '- Prefer existing module boundaries and project conventions.',
    snapshot.hasTsConfig ? '- TypeScript configuration is present in `tsconfig.json`.' : undefined,
    snapshot.hasVSCodeLaunch ? '- VS Code launch configuration is present in `.vscode/launch.json`.' : undefined,
    '',
    'Root entries:',
    ...rootEntries.map((entry) => `- ${entry}`),
    '',
    '## Build And Verification',
    '',
    ...verification,
    '',
    '## Coding Guidelines',
    '',
    '- Keep changes scoped to the requested behavior.',
    '- Prefer existing project patterns before adding abstractions.',
    '- Use reviewable change proposals for generated edits.',
    '- Update this file when project commands or conventions change.',
    '',
    '## Tool And Permission Notes',
    '',
    '- This project is used from VS Code.',
    '- API keys are stored in `~/kraken-coder/config/config.toml` under `[model].apiKey`.',
    '- Workspace TOML config overrides global TOML config.',
    '- Do not assume browser, shell, or direct file-write tools are enabled.',
    '',
    '## Known Constraints',
    '',
    '- If this file becomes long, summarize the task-relevant instructions before working.',
    '- If instructions here conflict with system or tool safety rules, system and tool rules win.',
    options.refresh ? '- This file was regenerated with `/init --refresh`; review preserved project-specific details carefully.' : undefined,
    options.force ? '- This file was regenerated with `/init --force`; review replacement content carefully.' : undefined,
    '',
  ];

  return lines.filter((line): line is string => line !== undefined).join('\n') + '\n';
}

function appendRefreshNotes(existingText: string, snapshot: WorkspaceSnapshot): string {
  const heading = '## Kraken Coder Refresh Notes';
  const section = buildRefreshNotesSection(snapshot);
  const normalized = existingText.trimEnd();
  const headingIndex = normalized.indexOf(`\n${heading}\n`);
  if (headingIndex < 0) {
    return `${normalized}\n\n${section}\n`;
  }

  const before = normalized.slice(0, headingIndex).trimEnd();
  const afterStart = headingIndex + 1;
  const nextHeadingIndex = normalized.slice(afterStart + heading.length).search(/\n##\s+/);
  if (nextHeadingIndex < 0) {
    return `${before}\n\n${section}\n`;
  }

  const after = normalized.slice(afterStart + heading.length + nextHeadingIndex).trimStart();
  return `${before}\n\n${section}\n\n${after}\n`;
}

function buildRefreshNotesSection(snapshot: WorkspaceSnapshot): string {
  const scripts = snapshot.packageJson?.scripts ?? {};
  const verification = buildVerificationLines(scripts);
  const lines: string[] = [
    '## Kraken Coder Refresh Notes',
    '',
    'Detected workspace details:',
    snapshot.packageJson?.name ? `- Package: ${snapshot.packageJson.name}` : '- Package: not detected',
    snapshot.hasTsConfig ? '- `tsconfig.json` is present.' : '- `tsconfig.json` was not detected.',
    snapshot.hasVSCodeLaunch ? '- `.vscode/launch.json` is present.' : '- `.vscode/launch.json` was not detected.',
    '',
    'Detected verification commands:',
    ...verification,
    '',
    'Recent root entries:',
    ...snapshot.rootEntries.slice(0, 24).map((entry) => `- ${entry}`),
  ];
  return lines.join('\n');
}

function buildWorkspaceConfigToml(): string {
  return [
    '[context]',
    'maxChars = 60000',
    '',
    '[agent]',
    'autoApply = false',
    'allowTerminal = false',
    'allowFileWriteTool = false',
    'allowBrowserTool = false',
    '',
  ].join('\n');
}

function buildVerificationLines(scripts: Record<string, string>): string[] {
  const preferred = ['check', 'compile', 'test', 'lint', 'typecheck', 'build'];
  const lines = preferred
    .filter((name) => scripts[name])
    .map((name) => `- \`npm run ${name}\`: ${scripts[name]}`);

  if (lines.length) {
    return lines;
  }

  const scriptNames = Object.keys(scripts);
  if (scriptNames.length) {
    return scriptNames.slice(0, 8).map((name) => `- \`npm run ${name}\`: ${scripts[name]}`);
  }

  return ['- Add the commands used to verify this workspace.'];
}

async function listRootEntries(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => !entry.name.startsWith('.') || entry.name === '.vscode')
      .filter((entry) => !['node_modules', 'out', 'dist', 'build', 'coverage'].includes(entry.name))
      .map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

async function readPackageSummary(filePath: string): Promise<PackageSummary | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>;
    return {
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      description: typeof parsed.description === 'string' ? parsed.description : undefined,
      scripts: asStringRecord(parsed.scripts),
      dependencies: Object.keys(asStringRecord(parsed.dependencies)).sort(),
      devDependencies: Object.keys(asStringRecord(parsed.devDependencies)).sort(),
    };
  } catch {
    return undefined;
  }
}

async function readReadmeTitle(root: string): Promise<string | undefined> {
  for (const name of ['README.md', 'readme.md']) {
    try {
      const content = await fs.readFile(path.join(root, name), 'utf8');
      const title = content.split(/\r?\n/).find((line) => line.startsWith('# '));
      if (title) {
        return title.replace(/^#\s+/, '').trim();
      }
    } catch {
      // Try the next common README name.
    }
  }
  return undefined;
}

async function readTextFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function asStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') {
      result[key] = item;
    }
  }
  return result;
}

function hasFlag(invocation: SlashCommandInvocation, name: string): boolean {
  return invocation.flags[name] === true;
}
