/**
 * 输入长度度量：**CJK = 2，其他 = 1**，按**码点**迭代（代理对算 1）。
 *
 * 裁决：规则 1 的累积阈值与规则 5–7 的 100 / 2000 分档**共用同一口径**——
 * 否则同一句中文在两个规则里会被量成两个长度。
 *
 * 规则 1 是**启发式体量路由**（不是物理上限保证）：阈值 10 万留出约 5 万加权余量，
 * 覆盖 JSON 转义、工具 schema、协议文本等常见膨胀；极端输入（海量转义字符）仍可能
 * 超出 ChatGPT Web 的 200,000 字符 composer 预算，由 adapter 报错兜底。
 */

/** CJK 与全角区（含全角标点）。 */
const CJK = /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/u

/** 加权字符数：CJK 计 2，其余计 1。 */
export function weight(text: string): number {
  let total = 0
  for (const ch of text) total += CJK.test(ch) ? 2 : 1
  return total
}

/** 累积输入阈值（规则 1，启发式）：超过即路由 deepseek-official。 */
export const CUMULATIVE_LIMIT = 100_000

/** 短输入上界（规则 5）。 */
export const SHORT_LIMIT = 100

/** 中等输入上界（规则 6）。 */
export const MEDIUM_LIMIT = 2_000
