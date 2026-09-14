/**
 * 用户显式模型选择的**持久投影**（替换 deprecated 的 `Session.eventAt()` 逐条扫描）。
 *
 * 为什么用投影：
 * - `eventAt()` 在宿主里被标 `@deprecated` 且「new calls are prohibited」；
 * - `session/event` 订阅在恢复/resume 时**不重放历史**（"constructor seeds do not emit"），
 *   会丢失进程重启前的显式选择；
 * - 自注册投影由 `sessionProjections.stateOf()` 懒折叠**全量内存日志**（含 resume 种子、
 *   fork 继承前缀），跨 resume/fork/import 语义正确，是 DSH 官方的持久状态机制
 *   （`packages/session/session-projection/src/index.ts:615` 的 `cellFor` 会
 *   `buildCell` 折完整 `snapshotEvents()`）。
 */

import { z as zod } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

import { foldSelection, initialSelectionState, type SelectionState } from './selection.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** 本插件最后一次用户显式模型选择（host-only，不上客户端快照）。 */
    routerSelection: SelectionState
  }
}

/** zod schema：投影状态在持久化/恢复时的校验边界。 */
const lastSelectionSchema = zod.object({
  provider: zod.string().min(1),
  model: zod.string().min(1),
}).strict()

const selectionStateSchema = zod.object({
  lastSelection: lastSelectionSchema.nullable(),
})

/** host-only 投影定义：折 `model/selection` → `{ lastSelection }`。 */
export const routerSelectionProjectionDefinition = {
  key: 'routerSelection',
  stateVersion: 1,
  stateSchema: selectionStateSchema,
  init: initialSelectionState,
  apply: foldSelection,
} satisfies ProjectionDefinition<'routerSelection', SelectionState>
