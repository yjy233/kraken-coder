import type { Message } from '../core/types.js';
import { readSkill, type Skill } from './catalog.js';
import type { Workspace } from '../tools/workspace.js';
import { contextSize, type ContextBudget } from '../context/budget.js';

/** Keep the user's original text in history and resolve only names in the advertised catalog. */
export async function prepareSkillMessage(content: string, skills: Skill[], workspace: Workspace): Promise<Message> {
  const message: Message = { role: 'user', content };
  const known = new Map(skills.map(skill => [skill.name, skill]));
  const selected = new Set<Skill>();
  // Use identifier boundaries so "$review-long" and "$review_suffix" never trigger "$review".
  const mentions = /(?<![\w$\\])\$([\w][\w.-]*(?::[\w][\w.-]*)?)(?![\w:-])/g;
  for (const match of content.matchAll(mentions)) {
    const exact = match[1]!;
    const skill = known.get(exact) ?? known.get(exact.replace(/\.+$/, ''));
    if (skill) selected.add(skill);
  }
  if (selected.size === 0) return message;
  const sections: string[] = [];
  let remaining = 24_000;
  for (const skill of selected) {
    const source = await readSkill(workspace, skill);
    const limit = Math.min(12_000, remaining);
    const excerpt = source.length > limit ? source.slice(0, limit) + '\n[Use read_skill for more.]' : source;
    sections.push(`Skill ${skill.name}\n${excerpt}`);
    remaining -= Math.min(source.length, limit);
    if (!remaining) {
      sections.push('Use read_skill for any remaining selected skills.');
      break;
    }
  }
  message.skillContext = sections.join('\n\n');
  return message;
}

/** Apply snapshots to the provider request before estimating its size, including after session replay. */
export function withSkillContext(messages: Message[], budget: ContextBudget, schemaSize: number): Message[] {
  if (!messages.some(m => m.role === 'user' && m.skillContext)) return messages;
  const view = messages.map(({ skillContext: _snapshot, ...message }) => message);
  const lastTurn = view.findLastIndex(m => m.role === 'user' && !m.steered);
  const essential = view.filter((m, i) => m.role === 'system' || i >= lastTurn);
  const threshold = budget.source === 'fallback' ? budget.thresholdChars : budget.thresholdTokens;
  let remaining = threshold - schemaSize - contextSize(essential, budget);
  const header = '\n\n[Selected skill files. Project instructions and tool permissions still apply.]\n';
  // New mentions take priority. An oversized attachment can still be paged with read_skill.
  for (let i = view.length - 1; i >= 0 && remaining > 0; i--) {
    const snapshot = messages[i]!.skillContext;
    if (!snapshot || view[i]!.role !== 'user') continue;
    let body = snapshot;
    while (body && contextSize(header + body, budget) > remaining) body = body.slice(0, Math.floor(body.length / 2));
    if (!body) continue;
    view[i]!.content += header + body;
    remaining -= contextSize(header + body, budget);
  }
  return view;
}
