/**
 * 关键词规则表（规则 2 / 3 / 4）。
 *
 * **数组顺序 = 判断顺序**，先匹配先返回。「快速」类词必须排在「代码」类词之前——
 * 用户显式的**速度要求优先于任务复杂度**（需求原文），例如
 * 「快速帮我写个函数」同时命中规则 2 与规则 4，必须走规则 2（DeepSeek）。
 */

import { CW_HIGH, DEEPSEEK, type RouteDecision } from './policy.ts'

/** 一条关键词规则。 */
export interface KeywordRule {
  /** 需求中的规则编号（1→8），仅用于报错与测试定位。 */
  readonly id: number
  /** 命中即返回该决策。 */
  readonly re: RegExp
  /** 命中后的目标。 */
  readonly to: RouteDecision
}

/** 有序规则表（顺序即优先级）。 */
export const KEYWORD_RULES: readonly KeywordRule[] = [
  // 规则 2：速度/简短要求 → DeepSeek（**必须**排在规则 3/4 之前）
  { id: 2, re: /快速|立刻|简单|简短|就一句|马上/, to: DEEPSEEK },
  // 规则 3：复杂度信号 → chatgpt-web/high
  { id: 3, re: /复杂|多步|架构|设计变更|调试|bug|契约/i, to: CW_HIGH },
  // 规则 4：代码工作信号 → chatgpt-web/high
  { id: 4, re: /写代码|refactor|重构|审查|review|代码/i, to: CW_HIGH },
]
