import type { Skill } from '../skills/types.js'
import type { ToolDefinition } from './types.js'

const WORKING_PROCESS_HEADER = '## Working Process'
const AVAILABLE_TOOLS_HEADER = '## Available Tools'
const DEFAULT_WORKING_PROCESS_LINES = [
  '1. For multi-step tasks, first use `todo` to create a task list.',
  '2. Gather information using available tools.',
  '3. Mark todos as done when steps complete.',
  '4. Provide a concise final answer.',
]

/**
 * PromptBuilder —— 根据可用工具动态构建 System Prompt
 *
 * 职责：
 * - 接收基础 prompt 和工具列表
 * - 按固定结构拼接：基础 prompt → 工作流指导 → 可用工具列表 → 针对性工具指南
 */

export class PromptBuilder {
  constructor(
    private basePrompt: string,
    private tools: ToolDefinition[],
    private skills: Skill[] = []
  ) {}

  /** 构建完整的 System Prompt */
  build(): string {
    const sections: string[] = [
      this.basePrompt,
      '',
      this.buildWorkingProcess(),
      '',
      this.buildAvailableTools(),
    ]

    const skillsMetaSection = this.buildAvailableSkills()
    if (skillsMetaSection) {
      sections.push('', skillsMetaSection)
    }

    sections.push('', this.buildMarkdownMediaGuidelines())

    const skillSection = this.buildSkillGuidelines()
    if (skillSection) {
      sections.push('', skillSection)
    }

    const todoSection = this.buildTodoGuidelines()
    if (todoSection) {
      sections.push('', todoSection)
    }

    const webSection = this.buildWebToolsGuidelines()
    if (webSection) {
      sections.push('', webSection)
    }

    const replaceSection = this.buildReplaceGuidelines()
    if (replaceSection) {
      sections.push('', replaceSection)
    }

    return sections.join('\n')
  }

  /** 通用工作流指导 */
  private buildWorkingProcess(): string {
    return [
      WORKING_PROCESS_HEADER,
      ...DEFAULT_WORKING_PROCESS_LINES,
    ].join('\n')
  }

  /** 可用工具列表 */
  private buildAvailableTools(): string {
    const lines = [AVAILABLE_TOOLS_HEADER]
    for (const tool of this.tools) {
      lines.push(`- ${tool.name}: ${tool.description}`)
    }
    return lines.join('\n')
  }

  /** Markdown 图片输出约定（所有输出通用） */
  private buildMarkdownMediaGuidelines(): string {
    return [
      '## Markdown Media Guidelines',
      '- When an image is useful in an answer or tool-derived summary, embed it with standard Markdown image syntax: `![alt text](path-or-url)`.',
      '- For local images created or discovered with tools, use the exact readable file path returned by the tool.',
      '- Do not invent local image paths, and do not inline base64 image data in normal responses.',
    ].join('\n')
  }

  /** todo 工具使用指南（当 todo 开启时追加） */
  private buildTodoGuidelines(): string | null {
    if (!this.hasTool('todo')) return null
    return [
      '## Todo Tool Guidelines',
      '- ALWAYS create a todo list before starting complex tasks with multiple steps.',
      '- Update todos as you progress through the task.',
      '- Mark todos as done when each step is finished.',
      '- Use todos to stay organized and avoid losing track of sub-tasks.',
    ].join('\n')
  }

  /** web 工具使用指南（当 web_fetch/search 开启时追加） */
  private buildWebToolsGuidelines(): string | null {
    const hasWebFetch = this.hasTool('web_fetch')
    const hasSearch = this.hasTool('search')
    const hasAgentBrowser = this.hasTool('agent_browser')
    if (!hasWebFetch && !hasSearch && !hasAgentBrowser) return null

    const lines = ['## Web Tools Guidelines']
    if (hasSearch) {
      lines.push('- Use `search` when you need up-to-date information from the internet.')
    }
    if (hasWebFetch) {
      lines.push('- Use `web_fetch` when you need to read a specific webpage in detail.')
    }
    if (hasAgentBrowser) {
      lines.push('- Use `agent_browser` for real browser automation, dynamic pages, forms, screenshots, and frontend verification.')
      lines.push('- Agent browser workflow: open a URL, take a snapshot, use refs like @e1 for click/fill/type, wait after navigation, then snapshot again.')
      lines.push('- Prefer `web_fetch` for static page text; prefer `agent_browser` when interaction or rendered UI state matters.')
    }
    lines.push('- Prefer local tools (read_file, grep) over web tools when the information is already in the project.')
    return lines.join('\n')
  }

  /** replace 工具使用指南（当 replace 开启时追加） */
  private buildReplaceGuidelines(): string | null {
    if (!this.hasTool('replace')) return null
    return [
      '## Replace Tool Guidelines',
      '- Use `replace` for precise text substitutions in existing files.',
      '- For large rewrites, use `write_file` instead.',
    ].join('\n')
  }

  /** 可用 Skill 元数据列表（常驻上下文） */
  private buildAvailableSkills(): string | null {
    if (this.skills.length === 0) return null
    const lines = ['## Available Skills']
    for (const skill of this.skills) {
      lines.push(`- **${skill.name}**: ${skill.description}`)
    }
    lines.push('')
    lines.push('When a skill is needed, call the `skill` tool with `action="activate"`.')
    lines.push('When you need a file from a loaded skill, call the `skill` tool with `action="read_reference"`.')
    return lines.join('\n')
  }

  /** skill / skill_install 工具使用指南 */
  private buildSkillGuidelines(): string | null {
    const hasSkill = this.hasTool('skill')
    const hasSkillInstall = this.hasTool('skill_install')
    if (!hasSkill && !hasSkillInstall) return null

    const lines = ['## Skill Tool Guidelines']
    if (hasSkill) {
      lines.push('- Use `skill` with `action="activate"` before relying on an installed skill.')
      lines.push('- Only use `skill` with `action="read_reference"` after that skill has been activated.')
      lines.push('- If the user asks to create or update a skill, activate `skill-creator` first when it is available.')
    }
    if (hasSkillInstall) {
      lines.push('- If the required skill is not listed under `Available Skills`, consider `skill_install` to add it.')
      lines.push('- Use `skill_install` only when the user asked to install a skill or clearly approved that setup change.')
      lines.push('- If the user provides a ClawHub page or slug such as `owner/skill`, use `skill_install` with `source="clawhub"` and pass that slug or URL in `slug`.')
      lines.push('- Use `source="github"` only when you have a verified GitHub repository and a verified path to the skill directory inside that repo.')
      lines.push('- For local skill authoring, prefer `skill_install` actions in this order: `init_local`, then `validate_local`, then `link` or `install`.')
    }
    return lines.join('\n')
  }

  private hasTool(name: string): boolean {
    return this.tools.some((t) => t.name === name)
  }
}

export function extractBaseSystemPrompt(prompt: string): string {
  const trimmed = prompt.trim()
  if (!trimmed) {
    return trimmed
  }

  if (!DEFAULT_WORKING_PROCESS_LINES.every((line) => trimmed.includes(line))) {
    return trimmed
  }

  const workingProcessIndex = trimmed.indexOf(`\n${WORKING_PROCESS_HEADER}\n`)
  const availableToolsIndex = trimmed.indexOf(`\n${AVAILABLE_TOOLS_HEADER}\n`)
  if (workingProcessIndex === -1 || availableToolsIndex <= workingProcessIndex) {
    return trimmed
  }

  return trimmed.slice(0, workingProcessIndex).trim()
}
