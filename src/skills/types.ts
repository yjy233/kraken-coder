/**
 * Skill 类型定义
 *
 * Skill 是自包含的领域知识包，包含 SKILL.md（YAML frontmatter + Markdown body）
 * 和可选的 scripts/、references/、assets/ 资源目录。
 */

export interface Skill {
  /** Skill 标识名（URL-safe，小写+连字符） */
  name: string

  /** Skill 功能描述与触发条件（用于模型判定是否加载） */
  description: string

  /** SKILL.md 的 Markdown body（不含 frontmatter） */
  body: string

  /** Skill 所在目录的绝对路径 */
  dirPath: string
}

export interface SkillRuntimeState {
  loadedSkillNames: Set<string>
}
