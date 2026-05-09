import { ChatMessage, ContextItem, ModelMessage } from '../shared/types';

export function buildModelMessages(userText: string, history: ChatMessage[], context: ContextItem[], maxChars: number): ModelMessage[] {
  const trimmedHistory = history.slice(-10);
  const contextBlock = buildContextBlock(context, maxChars);

  const messages: ModelMessage[] = [
    {
      role: 'system',
      content: [
        'You are Kraken Coder, a pragmatic coding assistant running inside VS Code.',
        'Prioritize precise, reviewable answers. When proposing file edits, return a JSON object only.',
        'For code changes, use this exact JSON shape:',
        '{"summary":"...","changes":[{"path":"relative/path","type":"create|modify|delete","fullText":"complete desired file content","rationale":"..."}],"commands":[{"command":"npm test","rationale":"..."}],"followUps":["..."]}',
        'Only include changes when the user asks you to create or modify files.',
        'Use workspace-relative paths. Never request secrets. Do not invent files you have not seen unless creating new files is clearly requested.'
      ].join('\n')
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

