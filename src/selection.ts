/**
 * 用户显式模型选择的**纯折叠函数**（零依赖，可离线单测）。
 *
 * `session-controller.selectModel`（GUI 模型选择器及其它 API 客户端）会落一条持久
 * `model/selection` 事件（`api/session-controller/src/agent.ts:327`），payload 为
 * `{ provider, model, reasoningEffort? }`。本模块把「最后一次显式选择」折成
 * `SelectionState`，供 `selection-projection.ts` 注册为 DSH 持久投影。
 *
 * 语义（裁决）：任何 `selectModel` 都算显式选择；「最后一次选择 == 默认模型」时
 * 恢复自动路由（由 `index.ts` 对照 apply 时捕获的默认模型判断），否则放行。
 */

/** 一次显式模型选择（只看 provider/model，effort 不参与放行判定）。 */
export interface LastSelection {
  readonly provider: string
  readonly model: string
}

/** 投影折出的状态：最后一次显式选择，或 null（从未选过）。 */
export interface SelectionState {
  readonly lastSelection: LastSelection | null
}

/** 初始状态。 */
export function initialSelectionState(): SelectionState {
  return { lastSelection: null }
}

/**
 * 折叠一条会话事件：遇到 `model/selection` 就记录（覆盖旧值），其它事件原样返回。
 *
 * 纯函数、幂等、不抛错——非法/空 payload 视为未选择（原样返回），
 * 由上游 zod schema 在持久化/恢复时兜底校验。
 * @param state - 当前状态。
 * @param event - 一条会话事件。
 * @returns 新的状态（未变化时返回同一引用）。
 */
export function foldSelection(
  state: SelectionState,
  event: { readonly type: string; readonly data?: unknown },
): SelectionState {
  if (event.type !== 'model/selection') return state
  const data = event.data as { readonly provider?: unknown; readonly model?: unknown } | undefined
  if (typeof data?.provider !== 'string' || data.provider.length === 0
    || typeof data.model !== 'string' || data.model.length === 0) {
    return state
  }
  return { lastSelection: { provider: data.provider, model: data.model } }
}
