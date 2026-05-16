import type { SlashCommand } from '../types';

export function buildSelectedSkillPrompt(skillName: string, task: string): string {
  return [
    `User selected skill: ${skillName}`,
    '',
    'You must activate this skill before answering:',
    `- Call the skill tool with action="activate" and name="${skillName}".`,
    '- Follow the activated skill instructions for this task.',
    '- If you need bundled references, call skill action="read_reference" after activation.',
    '',
    'Task:',
    task,
  ].join('\n');
}

export const skillCommand: SlashCommand = {
  name: 'skill',
  aliases: ['use-skill'],
  description: 'Run the agent with a selected skill.',
  usage: '/skill <name> <task>',
  execute: async (invocation, context) => {
    const skillName = invocation.positionals[0]?.trim();
    if (!skillName) {
      context.postAssistantMessage([
        '/skill requires a skill name.',
        '',
        'Usage:',
        `- \`${skillCommand.usage}\``,
      ].join('\n'));
      return;
    }

    const availableSkills = context.getAvailableSkills();
    const skill = availableSkills.find((entry) => entry.name === skillName);
    if (!skill) {
      context.postAssistantMessage([
        `Unknown skill: ${skillName}`,
        '',
        'Available skills:',
        ...availableSkills.map((entry) => `- \`${entry.name}\`: ${entry.description}`),
      ].join('\n'));
      return;
    }

    const task = invocation.argsText.slice(skillName.length).trim();
    if (!task) {
      context.postAssistantMessage([
        `/skill ${skill.name} requires a task.`,
        '',
        'Usage:',
        `- \`${skillCommand.usage}\``,
      ].join('\n'));
      return;
    }

    await context.runAgent(buildSelectedSkillPrompt(skill.name, task));
  },
};
