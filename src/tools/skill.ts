import { describeSkillResources, readSkillReference } from '../skills/registry.js'
import type { Tool } from './types.js'

export const skillTool: Tool = {
  name: 'skill',
  description: 'Activate an available skill or read a reference file from an activated skill.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['activate', 'read_reference'],
        description: 'Skill action to perform.',
      },
      name: {
        type: 'string',
        description: 'Skill name.',
      },
      path: {
        type: 'string',
        description: 'Reference file path under references/. Required for read_reference.',
      },
    },
    required: ['action', 'name'],
  },
  execute: async (input, ctx) => {
    const action = String(input.action || '').trim()
    const skillName = String(input.name || '').trim()

    if (!skillName) {
      throw new Error('skill name is required')
    }

    const skill = ctx.availableSkills.find((entry) => entry.name === skillName)
    if (!skill) {
      throw new Error(`Unknown skill: ${skillName}`)
    }

    if (action === 'activate') {
      ctx.skillState.loadedSkillNames.add(skill.name)
      return {
        output: [
          `Activated skill: ${skill.name}`,
          '',
          `Description: ${skill.description}`,
          '',
          ...describeSkillResources(skill),
          '',
          'Instructions:',
          '',
          skill.body,
        ].join('\n'),
      }
    }

    if (action === 'read_reference') {
      if (!ctx.skillState.loadedSkillNames.has(skill.name)) {
        throw new Error(`Skill is not activated: ${skill.name}`)
      }
      const refPath = String(input.path || '').trim()
      if (!refPath) {
        throw new Error('reference path is required')
      }
      const content = readSkillReference(skill, refPath)
      return {
        output: `[Skill Reference: ${skill.name}/${refPath}]\n\n${content}`,
      }
    }

    throw new Error(`Unsupported skill action: ${action}`)
  },
}
