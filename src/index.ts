/**
 * my-chatgpt-router：按任务预估在 `deepseek-official` 与 `chatgpt-web` 之间路由模型。
 *
 * **不做超时 fallback**（需求硬约束）：判定是纯同步函数，路由目标不可解析时让 DSH 以
 * `NO_ADAPTER` **大声失败**，插件不吞错、不降级、不换 provider。
 *
 * 接线（三条，全部在 agent 作用域事件上）：
 * 1. `agent/pre-step`：折算两条**分开**的文本口径（最后一条用户消息 / 累积加权）——缓存 `WeakMap<Agent, …>`；
 * 2. `agent/request`：先 `await next()`，再定稿——「用户显式选过非默认模型 ⇒ 放行」，否则路由；
 * 3. 启动期自检：核对四个路由目标是否在 `listModels` 结果内（**只 warn**）。
 *
 * ## 三个已修的 bug + 一个坑（都曾让保护线失效）
 *
 * **① 口径取错：`cumulative` 不是会话历史。** 旧实现拼 `agent/pre-step` 的 `messages`——
 * 那是本步从 inbox 领走的**新消息**（`agent-loop/src/agent.ts:244`），不是历史。
 * 恢复的巨大会话只领到一条短消息 ⇒ 规则 1 永不触发 ⇒ 撞 `COMPOSER_CHAR_BUDGET = 200_000`。
 * 现在口径取自 `session.deriveMessages()`（完整、压缩感知、含恢复历史）。
 *
 * **② 无视用户显式选择。** 旧实现无条件覆盖。现在用**自注册投影**读最后一次
 * `model/selection`，若 ≠ 启动时捕获的默认模型 ⇒ 放行（「切回默认即恢复自动」）。
 *
 * **③ `chatgpt-web/instant` 不存在。** 已改为 `chatgpt-web/light`（见 `policy.ts`）。
 *
 * **④ 缺 `version` 触发 `REQUEST_EXTENSION`。** `plugin-package-inventory-deepseek` 要求
 * active bare package 有非空 name/version，已补 `"version": "0.1.0"`。
 *
 * ## effort 政策（裁决后收敛，唯一硬不变量）
 *
 * 统一 `finalizeConfig`：**按目标 provider 决定，不按路径**——
 * - `chatgpt-web`：**删** `reasoningEffort`（无论自动/手动/non-root）；
 * - `deepseek-official`：**尊重继承值**（adapter 支持 off/low/high/max）；
 * - `FORCE_DEEPSEEK_HIGH=true` 时 deepseek 分支强制写 `high`。
 *
 * ⚠ 为什么必须「删除」而不是「不写」：本部署 `agent-default-model` 带 `reasoningEffort: high`
 * （`~/.dsh/settings.yaml` 实测），DSH 循环规则是「显式设置会保留」
 * （`packages/core/agent-loop/README.md:93`）⇒ 只换 provider/model 会让 `high` 跨路由存活。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'

import { measureInput, type CapturedInput } from './capture.ts'
import { CW_HIGH, CW_INSTANT, CW_MEDIUM, DEEPSEEK, assertEffort, type RouteDecision } from './policy.ts'
import { route } from './route.ts'
import { routerSelectionProjectionDefinition } from './selection-projection.ts'

/** 插件名（cordis.yml 条目 id 之外的显示名）。 */
export const name = 'my-chatgpt-router'

/** 依赖：`agents`（root 判定）、`llm`（自检）、`sessionProjections`（显式选择投影）、`agentDefaultModel`（默认参照）。 */
export const inject = ['agents', 'llm', 'sessionProjections', 'agentDefaultModel']

/**
 * 是否把 deepseek-official 路由的 effort **强制**写为 `high`。
 *
 * 默认 `false` = **保留继承值**（adapter 支持 off/low/high/max，插件不越界覆盖）。
 * 置 `true` 时显式写 `high`（覆盖继承值）。
 */
const FORCE_DEEPSEEK_HIGH = false

/** 四个路由目标（自检用；与实际决策同源，不另抄一份）。 */
const ROUTE_TARGETS: readonly RouteDecision[] = [DEEPSEEK, CW_INSTANT, CW_MEDIUM, CW_HIGH]

/**
 * 启动期自检：四个路由目标是否在目录里。**只 warn，不 fallback**。
 *
 * 理由：model id 拼错时 DSH 会大声失败——那是**正确的**报错，插件不得替它吞掉。
 * 注意 `listModels` 目录是 advisory（不强制路由），所以告警措辞用「可能在
 * adapter/provider 阶段失败」而不是「NO_ADAPTER」。
 * @param ctx - 宿主上下文（需 `llm` 服务）。
 */
async function selfCheck(ctx: Context): Promise<void> {
  for (const provider of ['deepseek-official', 'chatgpt-web'] as const) {
    try {
      const models = await ctx.llm.listModels(provider)
      const ids = new Set(models.map(model => model.id))
      for (const target of ROUTE_TARGETS.filter(candidate => candidate.provider === provider)) {
        if (!ids.has(target.model)) {
          ctx.logger.warn(
            `[my-chatgpt-router] 路由目标 ${provider}/${target.model} 不在当前 listModels 目录内：`
            + `可能在 adapter/provider 阶段失败（插件不 fallback）`,
          )
        }
      }
    } catch (error) {
      ctx.logger.warn(
        `[my-chatgpt-router] listModels(${provider}) 调用失败：${String(error)}（仅告警，不 fallback）`,
      )
    }
  }
  ctx.logger.info(
    '[my-chatgpt-router] 提示：chatgpt-web 路由会**删除**继承的 reasoningEffort，'
    + 'deepseek-official 路由保留继承值'
    + `（FORCE_DEEPSEEK_HIGH=${String(FORCE_DEEPSEEK_HIGH)}）`,
  )
}

/**
 * 安装插件：捕获输入 → 判断是否放行 → 路由 → 统一 effort 收口。
 * @param ctx - cordis 上下文。
 */
export function apply(ctx: Context): void {
  /** per-agent 快照（**不用模块级全局**：subagent / goal 轮次并发会串线）。 */
  const captured = new WeakMap<Agent, CapturedInput>()

  /**
   * 启动时的**默认模型参照**。用 apply 时捕获的值，而不是每请求读
   * `currentSelection()`——因为 `selectModel` 会 `saveSelection` 改写 settings 里的
   * 默认模型，每请求读会让「默认」永远等于「最后一次选择」，使「切回默认恢复自动」失效。
   */
  const defaultModel = ctx.agentDefaultModel.currentSelection()

  ctx.sessionProjections.register(routerSelectionProjectionDefinition)
  void selfCheck(ctx)

  /**
   * 用户最后一次显式选择是否**非默认模型**。
   * - 从未选过（null）⇒ false（自动路由）；
   * - 最后一次选择 == 启动默认 ⇒ false（用户切回了默认，恢复自动路由）；
   * - 否则 ⇒ true（放行，尊重选择）。
   * @param agent - 待判定的 agent。
   */
  function manualNonDefault(agent: Agent): boolean {
    const last = ctx.sessionProjections.stateOf(agent.session, 'routerSelection')?.lastSelection ?? null
    if (last === null) return false
    return !(last.provider === defaultModel.provider && last.model === defaultModel.model)
  }

  /**
   * 统一 effort 收口（唯一硬不变量：chatgpt-web 不带 effort）。按**目标 provider** 决定，
   * 自动/手动/non-root 全部走这一出口。
   * @param config - 最终配置（provider/model 已定稿）。
   * @returns 收口后的配置。
   */
  function finalizeConfig(config: LlmCallConfig): LlmCallConfig {
    let result: LlmCallConfig = config
    if (config.provider === 'chatgpt-web') {
      const { reasoningEffort: _dropped, ...without } = config
      result = without
    } else if (config.provider === 'deepseek-official' && FORCE_DEEPSEEK_HIGH) {
      result = { ...config, reasoningEffort: ReasoningEffortId('high') }
    }
    assertEffort(result.provider, result.reasoningEffort) // 不变量：chatgpt-web 永不带 effort
    return result
  }

  // ① 捕获：口径 = **完整会话历史**（`deriveMessages`）+ **本步新消息**。
  //    retry 不重跑 pre-step ⇒ 同一轮内快照稳定（重试沿用首次决策的输入）。
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    captured.set(agent, measureInput(agent.session.deriveMessages(), decision.messages))
    return decision
  })

  // ② 路由：先让下游（默认模型选择等）跑完，再由本插件定稿
  ctx.on('agent/request', async ({ agent }, next): Promise<LlmCallConfig> => {
    const resolved = await next()

    // 默认放行（non-root / 用户显式选过非默认模型）：不改 provider/model
    let target: LlmCallConfig = resolved

    const isRoot = ctx.agents.roots().some(candidate => candidate.id === agent.id)
    if (isRoot && !manualNonDefault(agent)) {
      const snapshot = captured.get(agent) ?? measureInput(agent.session.deriveMessages())
      // 无快照（未观察到 pre-step）或空口径 = 判不了 ⇒ 走规则 8 兜底档
      const decision: RouteDecision = snapshot.cumulativeWeight === 0 && snapshot.last === ''
        ? CW_MEDIUM
        : route(snapshot)
      target = { ...resolved, provider: decision.provider, model: decision.model }
    }

    return finalizeConfig(target)
  })
}

export default { name, inject, apply }
