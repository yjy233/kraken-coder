import { initSkill, normalizeSkillName, validateSkillDir } from '../skills/authoring.js'
import { installSkillFromClawHub, installSkillFromGitHub, linkSkillFromLocalDir } from '../skills/install.js'
import { getAvailableSkills, getSkillInstallRoot } from '../skills/manager.js'
import type { Tool } from './types.js'

export const skillInstallTool: Tool = {
  name: 'skill_install',
  description: 'Install, initialize, validate, or link a skill in the local skill registry.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['install', 'inspect_installed', 'validate_local', 'link', 'init_local'],
        description: 'Skill installation action.',
      },
      source: {
        type: 'string',
        enum: ['github', 'clawhub'],
        description: 'Install source. Use clawhub for ClawHub skill pages/slugs. Defaults to github.',
      },
      repo: {
        type: 'string',
        description: 'GitHub repository in owner/name format. Required for github installs.',
      },
      path: {
        type: 'string',
        description: 'Local skill directory path, or the path to the skill directory inside the repo. Required for github installs and local actions.',
      },
      slug: {
        type: 'string',
        description: 'ClawHub skill slug or ClawHub skill page URL. Required for clawhub installs.',
      },
      ref: {
        type: 'string',
        description: 'Optional git ref. Defaults to main. Only used for github installs.',
      },
      name: {
        type: 'string',
        description: 'Installed skill name to inspect.',
      },
      force: {
        type: 'boolean',
        description: 'Overwrite an existing installed skill.',
      },
      base_dir: {
        type: 'string',
        description: 'Base directory for creating a new local skill. Required for init_local.',
      },
      description: {
        type: 'string',
        description: 'Optional description to seed a newly initialized skill.',
      },
    },
    required: ['action'],
  },
  execute: async (input, ctx) => {
    const action = String(input.action || '').trim()

    if (action === 'install') {
      const source = String(input.source || 'github').trim()
      const installRoot = getSkillInstallRoot()
      const force = Boolean(input.force)
      let installed

      if (source === 'clawhub') {
        const slug = String(input.slug || '').trim()
        if (!slug) {
          throw new Error('slug is required for clawhub installs')
        }
        installed = await installSkillFromClawHub({
          clawhubSlug: slug,
          installRoot,
          force,
        })
      } else if (source === 'github') {
        const repo = String(input.repo || '').trim()
        const skillPath = String(input.path || '').trim()
        if (!repo) {
          throw new Error('repo is required for github installs')
        }
        if (!skillPath) {
          throw new Error('path is required for github installs')
        }

        const installParams: {
          repo: string
          skillPath: string
          installRoot: string
          force: boolean
          ref?: string
        } = {
          repo,
          skillPath,
          installRoot,
          force,
        }
        if (typeof input.ref === 'string' && input.ref.trim()) {
          installParams.ref = input.ref.trim()
        }

        installed = await installSkillFromGitHub(installParams)
      } else {
        throw new Error(`Unsupported install source: ${source}`)
      }

      const refreshed = ctx.refreshSkills()
      ctx.setAvailableSkills(refreshed)
      const installedSkill = refreshed.find((skill) => skill.name === installed.skill.name) || installed.skill

      return {
        output: [
          `Installed skill: ${installedSkill.name}`,
          `Source: ${source}`,
          `Description: ${installedSkill.description}`,
          `Install dir: ${installed.installDir}`,
          `Available skills: ${refreshed.map((skill) => skill.name).join(', ')}`,
        ].join('\n'),
      }
    }

    if (action === 'init_local') {
      const skillName = normalizeSkillName(String(input.name || '').trim())
      const baseDir = String(input.base_dir || '').trim()
      if (!baseDir) {
        throw new Error('base_dir is required')
      }

      const initParams: {
        skillName: string
        baseDir: string
        force: boolean
        description?: string
      } = {
        skillName,
        baseDir,
        force: Boolean(input.force),
      }
      if (typeof input.description === 'string' && input.description.trim()) {
        initParams.description = input.description.trim()
      }

      const result = await initSkill(initParams)
      const validation = await validateSkillDir(result.skillDir)

      return {
        output: [
          `Initialized skill: ${result.skill.name}`,
          `Directory: ${result.skillDir}`,
          `Description: ${result.skill.description}`,
          `Validation: ${validation.valid ? 'passed' : 'failed'}`,
          ...formatValidationMessages(validation),
        ].join('\n'),
      }
    }

    if (action === 'validate_local') {
      const targetPath = String(input.path || '').trim()
      if (!targetPath) {
        throw new Error('path is required')
      }
      const validation = await validateSkillDir(targetPath)
      return {
        output: [
          `Validation: ${validation.valid ? 'passed' : 'failed'}`,
          ...(validation.skill ? [
            `Skill: ${validation.skill.name}`,
            `Description: ${validation.skill.description}`,
            `Directory: ${validation.skill.dirPath}`,
          ] : []),
          ...formatValidationMessages(validation),
        ].join('\n'),
      }
    }

    if (action === 'link') {
      const targetPath = String(input.path || '').trim()
      if (!targetPath) {
        throw new Error('path is required')
      }

      const validation = await validateSkillDir(targetPath)
      if (!validation.valid) {
        throw new Error([
          'Local skill validation failed before linking:',
          ...formatValidationMessages(validation),
        ].join('\n'))
      }

      const installRoot = getSkillInstallRoot()
      const linked = await linkSkillFromLocalDir({
        sourceDir: targetPath,
        installRoot,
        force: Boolean(input.force),
      })

      const refreshed = ctx.refreshSkills()
      ctx.setAvailableSkills(refreshed)

      return {
        output: [
          `Linked skill: ${linked.skill.name}`,
          `Directory: ${linked.installDir}`,
          `Description: ${linked.skill.description}`,
          `Available skills: ${refreshed.map((skill) => skill.name).join(', ')}`,
        ].join('\n'),
      }
    }

    if (action === 'inspect_installed') {
      const name = String(input.name || '').trim()
      if (!name) {
        throw new Error('name is required')
      }
      const skill = getAvailableSkills().find((entry) => entry.name === name)
      if (!skill) {
        throw new Error(`Installed skill not found: ${name}`)
      }
      return {
        output: [
          `Skill: ${skill.name}`,
          `Description: ${skill.description}`,
          `Directory: ${skill.dirPath}`,
        ].join('\n'),
      }
    }

    throw new Error(`Unsupported skill_install action: ${action}`)
  },
}

function formatValidationMessages(validation: {
  errors: string[]
  warnings: string[]
}): string[] {
  const lines: string[] = []
  for (const error of validation.errors) {
    lines.push(`Error: ${error}`)
  }
  for (const warning of validation.warnings) {
    lines.push(`Warning: ${warning}`)
  }
  if (lines.length === 0) {
    lines.push('No validation issues found.')
  }
  return lines
}
