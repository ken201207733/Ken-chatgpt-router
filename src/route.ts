/**
 * 纯路由函数：判断顺序 **1 → 8**，先匹配先返回。
 *
 * **两条输入口径是刻意的**（bug 修正）：
 * - **关键词命中**（规则 2–4）与**长度分档**（规则 5–7）只看**最后一条**用户消息
 *   ——它们反映「**当前意图**」；用累积文本会让「你好」因为历史长而被判成 high，
 *   也会让 20 轮后的对话因历史累积而误触发高档。
 * - **累积阈值**（规则 1）用**累积加权**——它反映「**桥接体量**」（启发式）。
 *
 * 注意：`cumulativeWeight` 是**已算好的加权数**（由 `capture.measureInput` 流式累加，
 * 避免构造完整大字符串），不是字符串。规则 8 的兜底不在本函数里做——
 * 空输入在接线层（`index.ts`）特判 `CW_MEDIUM`，本函数的 `?? CW_MEDIUM` 是结构性
 * 保险（规则 5–7 已穷尽 last 输入空间，实际不可达）。
 */

import { KEYWORD_RULES } from './keywords.ts'
import { CUMULATIVE_LIMIT, MEDIUM_LIMIT, SHORT_LIMIT, weight } from './measure.ts'
import { CW_HIGH, CW_INSTANT, CW_MEDIUM, DEEPSEEK, assertRouteDecision, type RouteDecision } from './policy.ts'

/** `route()` 的输入：两条口径必须分别给出。 */
export interface RouteInput {
  /** 最后一条用户消息（关键词与分档的依据）。 */
  readonly last: string
  /** 累积会话文本的**加权字符数**（规则 1 的依据）。 */
  readonly cumulativeWeight: number
}

/**
 * 规则 1–7；**可能返回 `undefined`**（结构性留空，交给 `route()` 的兜底）。
 * @param input - 两条口径。
 * @returns 命中的决策，或 `undefined`（无规则命中）。
 */
function selectDecision(input: RouteInput): RouteDecision | undefined {
  // 规则 1：累积加权超阈值 ⇒ DeepSeek（启发式体量保护）
  if (input.cumulativeWeight > CUMULATIVE_LIMIT) return DEEPSEEK

  // 规则 2 → 3 → 4：关键词（顺序即优先级）
  for (const rule of KEYWORD_RULES) {
    if (rule.re.test(input.last)) return rule.to
  }

  // 规则 5 / 6 / 7：最后一条消息的加权长度分档（与规则 1 同一口径）
  const last = weight(input.last)
  if (last <= SHORT_LIMIT) return CW_INSTANT
  if (last <= MEDIUM_LIMIT) return CW_MEDIUM
  return CW_HIGH
}

/**
 * 完整路由：规则 1→8，含**结构性兜底**与硬约束守卫。
 * @param input - 两条口径。
 * @returns 一条通过硬约束校验的路由决策（**永不返回 `undefined`**）。
 */
export function route(input: RouteInput): RouteDecision {
  // 结构性兜底：规则 5–7 已穷尽 last 输入空间，此分支仅在改表出现缺口时兜底
  const decision = selectDecision(input) ?? CW_MEDIUM
  assertRouteDecision(decision)
  return decision
}
