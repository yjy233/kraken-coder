import { ChatMessage, ContextItem, ModelMessage } from '../shared/types';
import { AgentTool } from './tools';

const workingProcessHeader = '## Working Process';
const availableToolsHeader = '## Available Tools';
const workingProcessLines = [
  '1. For multi-step tasks, first use `todo` to create a task list.',
  '2. Gather information using available tools.',
  '3. Mark todos as done when steps complete.',
  '4. Provide a concise final answer.'
];

export function buildModelMessages(
  userText: string,
  history: ChatMessage[],
  context: ContextItem[],
  maxChars: number,
  tools: AgentTool[] = []
): ModelMessage[] {
  const trimmedHistory = history.slice(-10);
  const contextBlock = buildContextBlock(context, maxChars);

  const messages: ModelMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt(tools)
    }
  ];

  for (const message of trimmedHistory) {
    if (message.role === 'system') {
      continue;
    }

    messages.push({
      role: message.role,
      content: message.content
    });
  }

  messages.push({
    role: 'user',
    content: [
      contextBlock,
      '',
      'User task:',
      userText
    ].join('\n')
  });

  return messages;
}

function buildSystemPrompt(tools: AgentTool[]): string {
  const sections = [
    [
      'You are Kraken Coder, a pragmatic coding assistant running inside VS Code.',
      'Use available tools to inspect project files before making claims about code you have not seen.',
      'Use project-relative paths. Never request secrets. Do not invent files you have not seen unless creating new files is clearly requested.',
      'For reviewable VS Code edits, use `propose_changes`. Use `write_file` or `replace` only when direct file-write tools are enabled and direct mutation is appropriate.',
      'After `propose_changes` succeeds, do not repeat full file contents or return the same changes again.'
    ].join('\n'),
    buildWorkingProcess(),
    buildAvailableTools(tools),
    buildMarkdownMediaGuidelines()
  ];

  const todoSection = buildTodoGuidelines(tools);
  if (todoSection) {
    sections.push(todoSection);
  }

  const webSection = buildWebToolsGuidelines(tools);
  if (webSection) {
    sections.push(webSection);
  }

  const replaceSection = buildReplaceGuidelines(tools);
  if (replaceSection) {
    sections.push(replaceSection);
  }

  const skillSection = buildSkillGuidelines(tools);
  if (skillSection) {
    sections.push(skillSection);
  }

  return sections.join('\n\n');
}

function buildWorkingProcess(): string {
  return [
    workingProcessHeader,
    ...workingProcessLines
  ].join('\n');
}

function buildAvailableTools(tools: AgentTool[]): string {
  const lines = [availableToolsHeader];
  for (const tool of tools) {
    lines.push(`- ${tool.name}: ${tool.description}`);
  }
  return lines.join('\n');
}

function buildMarkdownMediaGuidelines(): string {
  return [
    '## Markdown Media Guidelines',
    '- When an image is useful in an answer or tool-derived summary, embed it with standard Markdown image syntax: `![alt text](path-or-url)`.',
    '- For local images created or discovered with tools, use the exact readable file path returned by the tool.',
    '- Do not invent local image paths, and do not inline base64 image data in normal responses.'
  ].join('\n');
}

function buildTodoGuidelines(tools: AgentTool[]): string | null {
  if (!hasTool(tools, 'todo')) {
    return null;
  }
  return [
    '## Todo Tool Guidelines',
    '- ALWAYS create a todo list before starting complex tasks with multiple steps.',
    '- Update todos as you progress through the task.',
    '- Mark todos as done when each step is finished.',
    '- Use todos to stay organized and avoid losing track of sub-tasks.'
  ].join('\n');
}

function buildWebToolsGuidelines(tools: AgentTool[]): string | null {
  const hasWebFetch = hasTool(tools, 'web_fetch');
  const hasSearch = hasTool(tools, 'search');
  const hasAgentBrowser = hasTool(tools, 'agent_browser');
  if (!hasWebFetch && !hasSearch && !hasAgentBrowser) {
    return null;
  }

  const lines = ['## Web Tools Guidelines'];
  if (hasSearch) {
    lines.push('- Use `search` when you need up-to-date information from the internet.');
  }
  if (hasWebFetch) {
    lines.push('- Use `web_fetch` when you need to read a specific webpage in detail.');
  }
  if (hasAgentBrowser) {
    lines.push('- Use `agent_browser` for real browser automation, dynamic pages, forms, screenshots, and frontend verification.');
    lines.push('- Agent browser workflow: open a URL, take a snapshot, use refs like @e1 for click/fill/type, wait after navigation, then snapshot again.');
    lines.push('- Prefer `web_fetch` for static page text; prefer `agent_browser` when interaction or rendered UI state matters.');
  }
  lines.push('- Prefer local tools (read_file, grep) over web tools when the information is already in the project.');
  return lines.join('\n');
}

function buildReplaceGuidelines(tools: AgentTool[]): string | null {
  if (!hasTool(tools, 'replace')) {
    return null;
  }
  return [
    '## Replace Tool Guidelines',
    '- Use `replace` for precise text substitutions in existing files.',
    '- For large rewrites, use `write_file` or `propose_changes` instead.'
  ].join('\n');
}

function buildSkillGuidelines(tools: AgentTool[]): string | null {
  const hasSkill = hasTool(tools, 'skill');
  const hasSkillInstall = hasTool(tools, 'skill_install');
  if (!hasSkill && !hasSkillInstall) {
    return null;
  }

  const lines = ['## Skill Tool Guidelines'];
  if (hasSkill) {
    lines.push('- Use `skill` with `action="activate"` before relying on an installed skill.');
    lines.push('- Only use `skill` with `action="read_reference"` after that skill has been activated.');
    lines.push('- If the user asks to create or update a skill, activate `skill-creator` first when it is available.');
  }
  if (hasSkillInstall) {
    lines.push('- If the required skill is not listed under `Available Skills`, consider `skill_install` to add it.');
    lines.push('- Use `skill_install` only when the user asked to install a skill or clearly approved that setup change.');
    lines.push('- If the user provides a ClawHub page or slug such as `owner/skill`, use `skill_install` with `source="clawhub"` and pass that slug or URL in `slug`.');
    lines.push('- Use `source="github"` only when you have a verified GitHub repository and a verified path to the skill directory inside that repo.');
    lines.push('- For local skill authoring, prefer `skill_install` actions in this order: `init_local`, then `validate_local`, then `link` or `install`.');
  }
  return lines.join('\n');
}

function hasTool(tools: AgentTool[], name: string): boolean {
  return tools.some((tool) => tool.name === name);
}

function buildContextBlock(context: ContextItem[], maxChars: number): string {
  if (!context.length) {
    return 'Workspace context: none provided.';
  }

  const sections: string[] = [];
  let used = 0;

  for (const item of context) {
    const header = `Context: ${item.label}${item.path ? ` (${item.path})` : ''}`;
    const remaining = maxChars - used - header.length - 8;
    if (remaining <= 0) {
      break;
    }

    const content = item.content.length > remaining
      ? `${item.content.slice(0, Math.max(0, remaining - 80))}\n...[truncated]`
      : item.content;
    used += header.length + content.length;
    sections.push([header, content].join('\n'));
  }

  if (!sections.length) {
    return 'Workspace context: omitted because token budget was exhausted.';
  }

  return ['Workspace context:', ...sections].join('\n\n');
}
