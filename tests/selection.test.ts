/**
 * `selection.ts` 的单测——用户显式模型选择折叠（替换 deprecated eventAt 的纯逻辑）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { foldSelection, initialSelectionState } from '../src/selection.ts'

test('初始状态：lastSelection = null', () => {
  assert.deepEqual(initialSelectionState(), { lastSelection: null })
})

test('非 model/selection 事件：原样返回（同一引用）', () => {
  const state = initialSelectionState()
  assert.equal(foldSelection(state, { type: 'turn/start' }), state)
  assert.equal(foldSelection(state, { type: 'user/message' }), state)
  assert.equal(foldSelection(state, { type: 'request/header' }), state)
})

test('一次显式选择：记录 provider/model', () => {
  const next = foldSelection(initialSelectionState(), {
    type: 'model/selection',
    data: { provider: 'chatgpt-web', model: 'chatgpt-web/high', reasoningEffort: undefined },
  })
  assert.deepEqual(next, { lastSelection: { provider: 'chatgpt-web', model: 'chatgpt-web/high' } })
})

test('多次显式选择：只保留最后一次', () => {
  let state = initialSelectionState()
  state = foldSelection(state, { type: 'model/selection', data: { provider: 'chatgpt-web', model: 'chatgpt-web/high' } })
  state = foldSelection(state, { type: 'model/selection', data: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  assert.deepEqual(state, { lastSelection: { provider: 'deepseek-official', model: 'deepseek-flash' } })
})

test('非法 payload：视为未选择（原样返回）', () => {
  const state = initialSelectionState()
  assert.equal(foldSelection(state, { type: 'model/selection', data: undefined }), state)
  assert.equal(foldSelection(state, { type: 'model/selection', data: {} }), state)
  assert.equal(foldSelection(state, { type: 'model/selection', data: { provider: '', model: 'x' } }), state)
  assert.equal(foldSelection(state, { type: 'model/selection', data: { provider: 'p', model: '' } }), state)
})

test('已记录后再遇非选择事件：保持原选择', () => {
  let state = foldSelection(initialSelectionState(), {
    type: 'model/selection',
    data: { provider: 'chatgpt-web', model: 'chatgpt-web/pro' },
  })
  state = foldSelection(state, { type: 'turn/start' })
  assert.deepEqual(state, { lastSelection: { provider: 'chatgpt-web', model: 'chatgpt-web/pro' } })
})
