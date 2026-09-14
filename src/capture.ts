/**
 * 输入捕获：把**会话历史**与**本步新消息**折算成 `route()` 要的两条口径。
 *
 * ## 为什么单开一个模块（bug 修正的核心）
 *
 * 旧实现把 `cumulative` 建成「`agent/pre-step` 收到的 `messages` 的拼接」。但
 * `agent/pre-step` 的 payload 是 `{ agent, messages, turn, step, signal }`，其中
 * `messages` = **本步从 inbox 领走的消息**（`agent-loop/src/agent.ts:244` 的
 * `inbox.claim(...)`），**不是会话历史**。
 *
 * 后果：被**恢复**的巨大会话（例如累积 140 万字符）在进程内只会领到用户新敲的
 * 那一条短消息 ⇒ `cumulative` 始终很小 ⇒ 规则 1 **永不触发** ⇒ 落到规则 5 的
 * 短输入档 ⇒ 路由到 chatgpt-web ⇒ 撞上 `COMPOSER_CHAR_BUDGET = 200_000`
 * （`dsh-llm-chatgpt-web/src/chatgpt/turn.ts:47`）。
 *
 * 修正：口径取自 `session.deriveMessages()`——**完整的、已按压缩规则投影过的**
 * 模型可见历史（`core/session/src/index.ts:832`），它天然包含恢复出来的旧历史。
 * 再把**尚未落盘**的本步新消息补上（`agent/request` 在用户批次提交**之前**跑）。
 *
 * 性能：不再构造完整 `cumulative` 大字符串——`cumulativeWeight` 在单次遍历里
 * **流式累加**，一旦超过阈值就停止累加（早停），避免 140 万字符场景的巨额分配。
 *
 * 本模块**纯函数、零外部运行时依赖**（只有 `import type` + 同目录 `measure.ts`），
 * 因此可以离线单测。
 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { CUMULATIVE_LIMIT, weight } from './measure.ts'

/** `route()` 的两条口径。 */
export interface CapturedInput {
  /** 最后一条**用户本人**消息的文本（规则 2–7 的依据）= 「当前意图」。 */
  readonly last: string
  /** 会话全部模型可见文本的**加权字符数**（规则 1 的依据）。 */
  readonly cumulativeWeight: number
}

/**
 * 一个内容块贡献的**模型可见文本**。
 *
 * - `text`：正文；
 * - `tool-call`：参数 JSON（真的会进请求）；
 * - `tool-result`：内层块递归（工具输出常常是巨大会话的主要体量）；
 * - `reasoning`：**不计**——它是 provider 内部思考，不是对话体量；
 * - `image` / `file` / 未知块：计 0（无法在纯函数里估字节）。
 * @param block - 待折算的内容块。
 * @returns 该块的文本（可能为空串）。
 */
export function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text': return block.text
    case 'tool-call': return block.arguments
    case 'tool-result': return block.content.map(blockText).filter(text => text !== '').join('\n')
    default: return ''
  }
}

/**
 * 一条消息的模型可见文本。
 * @param message - 任意消息。
 * @returns 各内容块文本以换行连接。
 */
export function messageText(message: Message): string {
  return message.content.map(blockText).filter(text => text !== '').join('\n')
}

/**
 * 是否是**用户本人**写的消息。
 *
 * plugin（goal / steer / 上下文投影）注入的 user-role 消息不算「当前意图」——
 * 否则规则 2–7 会被注入内容劫持。
 * @param message - 任意消息。
 * @returns 用户本人消息为 true。
 */
export function isUserAuthored(message: Message): boolean {
  return message.role === 'user' && message.source.kind === 'user'
}

/**
 * 折算两条口径。`batch` 排在 `history` 之后，因此**本步的消息决定 `last`**。
 *
 * - `last`：最新一条用户本人消息的文本，**即使为空也覆盖旧值**（P2-01 修正——
 *   否则「上一句『快速』+ 本步纯图片」会把旧关键词泄漏到当前路由）；
 * - `cumulativeWeight`：流式累加，超阈值后停止累加（早停）。
 * @param history - `session.deriveMessages()`：完整、压缩感知的模型可见历史。
 * @param batch - 本步将要进入请求的新消息（尚未落盘）；默认空。
 * @returns 两条口径。
 */
export function measureInput(
  history: readonly Message[],
  batch: readonly Message[] = [],
): CapturedInput {
  let last = ''
  let total = 0
  for (const message of [...history, ...batch]) {
    const text = messageText(message)
    if (isUserAuthored(message)) last = text
    if (text === '') continue
    if (total <= CUMULATIVE_LIMIT) total += weight(text)
  }
  return { last, cumulativeWeight: total }
}
