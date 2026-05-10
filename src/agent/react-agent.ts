/**
 * ReActAgent —— ReAct 循环 Agent 类
 *
 * 职责：管理多轮"推理 → 行动 → 观察"循环。
 * 每次循环委托 loopQuery 执行单轮模型调用+工具执行，
 * 直到模型不再请求工具，或达到最大步数限制。
 */

import crypto from 'node:crypto'
import { loopQuery } from './loop-query.js'
import type { AgentMessage, ReActAgentConfig, RunResult, RunStep, EmitFn, RunAgentRequestResult, ToolDefinition } from './types.js'
import type { SkillRuntimeState } from '../skills/types.js'

export class ReActAgent {
  constructor(private config: ReActAgentConfig) {}

  async run(params: {
    messages: AgentMessage[]
    model?: string
    systemPrompt?: string
    tools?: ToolDefinition[] | undefined
    skillState?: SkillRuntimeState | undefined
    emit?: EmitFn | undefined
  }): Promise<RunAgentRequestResult & { finalMessages: AgentMessage[] }> {
    const model = params.model || this.config.defaultModel
    const baseSystemPrompt = params.systemPrompt || this.config.defaultSystemPrompt
    const emit = params.emit
    const tools = params.tools || this.config.toolRegistry
    const currentSystemPrompt = baseSystemPrompt

    // 初始化运行记录
    const run: RunResult = {
      id: crypto.randomUUID(),
      sessionId: '',
      createdAt: new Date().toISOString(),
      model,
      steps: [],
      finalText: '',
      usage: [],
      toolExecutions: [],
    }

    let currentMessages = [...params.messages]

    emit?.('run:start', { runId: run.id, model, maxAgentSteps: this.config.maxSteps })

    // ReAct 主循环
    for (let stepIndex = 0; stepIndex < this.config.maxSteps; stepIndex += 1) {
      emit?.('run:step', { runId: run.id, step: stepIndex + 1, phase: 'model_request' })

      // 委托单轮查询
      const loopParams: Parameters<typeof loopQuery>[0] = {
        messages: currentMessages,
        model,
        systemPrompt: currentSystemPrompt,
        tools,
        maxOutputTokens: this.config.maxTokens,
        step: stepIndex + 1,
        emit,
      }
      if (this.config.timeout !== undefined) {
        loopParams.timeout = this.config.timeout
      }
      const result = await loopQuery(loopParams)

      // 收集本轮运行数据
      const step: RunStep = {
        step: stepIndex + 1,
        stopReason: result.stopReason,
        assistantText: result.assistantText,
        toolUseCount: result.toolUseCount,
      }
      run.steps.push(step)
      run.usage.push(result.usage)
      run.toolExecutions.push(...result.toolExecutions)

      currentMessages = result.updatedMessages

      // 模型不再请求工具 → 拿到最终答案，结束循环
      if (result.done) {
        const finalText = result.assistantText || 'The model returned without text.'
        run.finalText = finalText
        const loadedSkills = Array.from(params.skillState?.loadedSkillNames || [])
        return { reply: finalText, run, finalMessages: currentMessages, loadedSkills }
      }
    }

    // 达到最大步数限制，返回兜底消息
    const exhaustedMessage = `Agent stopped after reaching the maximum step limit (${this.config.maxSteps}).`
    run.finalText = exhaustedMessage
    const loadedSkills = Array.from(params.skillState?.loadedSkillNames || [])
    currentMessages.push({ role: 'assistant', content: exhaustedMessage })
    return { reply: exhaustedMessage, run, finalMessages: currentMessages, loadedSkills }
  }
}
