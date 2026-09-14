/**
 * 路由策略常量与**硬约束守卫**。
 *
 * 硬约束（裁决后收敛）：
 * 1. 路由到 `chatgpt-web` 时**绝不写** `reasoningEffort` —— 这是**唯一**的 effort 不变量；
 * 2. `deepseek-official` 的 effort **尊重继承值**（adapter 真实支持 off/low/high/max，
 *    插件不越界重复定义允许集，adapter 拒绝的值交给 adapter 报错）；
 * 3. **绝不**路由到 `luna` 或 `extra-high`（账号层拒绝）。
 *
 * **model id 必须来自 provider 目录（实测）**，不许凭印象写：
 * - `chatgpt-web` 的 7 个 id 见 `dsh-llm-chatgpt-web/src/index.ts:59-67`；
 *   注意 DSH 里显示名是 "Instant" 的那档，**id 是 `chatgpt-web/light`**——
 *   曾经写成 `chatgpt-web/instant`（不存在）。
 * - `deepseek-official` 的 4 个 id 见 `llm-deepseek/src/index.ts:92-122`。
 *
 * `MODELS_BY_PROVIDER` 是**逐 provider** 的目录快照：写错 id 或 provider-model 错配，
 * 单测立刻红。注意 `listModels` 目录是 advisory（不被目录成员资格强制路由），
 * 因此这里的校验是「插件自己挑的决策不越界」，不是对运行时可解析性的保证。
 */

/** 允许出现的 provider（唯一白名单）。 */
export const PROVIDERS = ['deepseek-official', 'chatgpt-web'] as const

/** 允许的 provider 字面量联合。 */
export type Provider = (typeof PROVIDERS)[number]

/** 一次路由决策。 */
export interface RouteDecision {
  readonly provider: Provider
  readonly model: string
}

/** deepseek-official 的目标（规则 1 / 2）。 */
export const DEEPSEEK: RouteDecision = { provider: 'deepseek-official', model: 'deepseek-flash' }

/** chatgpt-web 低档（规则 5）。**显示名 Instant，id 是 `light`。** */
export const CW_INSTANT: RouteDecision = { provider: 'chatgpt-web', model: 'chatgpt-web/light' }

/** chatgpt-web 中档（规则 6 / 8）。 */
export const CW_MEDIUM: RouteDecision = { provider: 'chatgpt-web', model: 'chatgpt-web/medium' }

/** chatgpt-web 高档（规则 3 / 4 / 7）。 */
export const CW_HIGH: RouteDecision = { provider: 'chatgpt-web', model: 'chatgpt-web/high' }

/** chatgpt-web provider 目录里的**全部 7 个** model id（含被禁的两档）。 */
export const CW_MODELS = [
  'chatgpt-web/luna',
  'chatgpt-web/think',
  'chatgpt-web/light',
  'chatgpt-web/medium',
  'chatgpt-web/high',
  'chatgpt-web/extra-high',
  'chatgpt-web/pro',
] as const

/** deepseek-official provider 目录里的 model id（4 个）。 */
export const DEEPSEEK_MODELS = [
  'deepseek-flash',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-v4-flash-vision-exp',
] as const

/** 逐 provider 的目录快照（禁止 provider-model 错配）。 */
export const MODELS_BY_PROVIDER: ReadonlyMap<Provider, ReadonlySet<string>> = new Map<Provider, ReadonlySet<string>>([
  ['deepseek-official', new Set<string>(DEEPSEEK_MODELS)],
  ['chatgpt-web', new Set<string>(CW_MODELS)],
])

/**
 * 禁止的 model 名（硬约束 3）。
 *
 * 这两档在 provider 目录里**存在**（`luna` / `extra-high` 都在 `CW_MODELS` 内），
 * 是**账号层**拒绝它们，所以守卫必须**先查禁止名、再查逐 provider 清单**。
 */
export const FORBIDDEN_MODEL = /\bluna\b|extra-high/i

/**
 * 校验一条决策是否满足硬约束。
 * @param decision - 待校验决策。
 * @throws Error 当 provider 不在白名单、model 命中禁止名、或 model 不属于该 provider。
 */
export function assertRouteDecision(decision: RouteDecision): void {
  if (!PROVIDERS.includes(decision.provider)) {
    throw new Error(`my-chatgpt-router: provider "${decision.provider}" 不在白名单内`)
  }
  if (FORBIDDEN_MODEL.test(decision.model)) {
    throw new Error(`my-chatgpt-router: model "${decision.model}" 命中禁止名（luna / extra-high）`)
  }
  const allowed = MODELS_BY_PROVIDER.get(decision.provider)
  if (allowed === undefined || !allowed.has(decision.model)) {
    throw new Error(
      `my-chatgpt-router: model "${decision.model}" 不属于 provider "${decision.provider}"`
      + `（允许：${[...(allowed ?? [])].join('|')}）`,
    )
  }
}

/**
 * effort 硬约束（唯一一条）：`chatgpt-web` 绝不写 `reasoningEffort`。
 *
 * deepseek-official 的 effort 由 adapter 决定（off/low/high/max 都合法），插件不检查。
 * @param provider - 目标 provider（可为任意字符串）。
 * @param effort - 待写 effort（`undefined` = 不写，永远合法）。
 * @throws Error 当 provider 为 chatgpt-web 且写了 effort。
 */
export function assertEffort(provider: string, effort: string | undefined): void {
  if (provider === 'chatgpt-web' && effort !== undefined) {
    throw new Error(`my-chatgpt-router: provider "chatgpt-web" 绝不写 reasoningEffort（硬约束 1）`)
  }
}
