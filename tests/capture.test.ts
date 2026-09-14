/**
 * `capture.ts` 的单测——**规则 1 失效的根因回归** + 空消息语义 + 流式权重。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Message } from '@deepseek-ai/dsh-llm'

import { measureInput, messageText } from '../src/capture.ts'
import { CUMULATIVE_LIMIT, weight } from '../src/measure.ts'
import { CW_INSTANT, DEEPSEEK } from '../src/policy.ts'
import { route } from '../src/route.ts'

let seq = 0

/** 用户本人写的消息。 */
function user(text: string): Message {
  return {
    id: `u${seq++}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as unknown as Message
}

/** 模型回复。 */
function assistant(text: string): Message {
  return {
    id: `a${seq++}`,
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'p', model: 'm' },
  } as unknown as Message
}

/** 插件注入的 user-role 消息（goal / steer / notice）。 */
function injected(text: string): Message {
  return {
    id: `p${seq++}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'test', form: 'notice', summary: 'test' },
  } as unknown as Message
}

/** 纯图片的用户消息（无文本）。 */
function userImage(): Message {
  return {
    id: `i${seq++}`,
    role: 'user',
    content: [{ type: 'image', attachment: { id: 'img1', mediaType: 'image/png', byteSize: 10, savedPath: '/tmp/x.png' } }],
    source: { kind: 'user' },
  } as unknown as Message
}

/** 工具结果消息（体量常常是巨大会话的主体）。 */
function toolResult(text: string): Message {
  return {
    id: `t${seq++}`,
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text }] }],
    source: { kind: 'tool', toolCallId: 'c1' },
  } as unknown as Message
}

/** 只带 reasoning 块的 assistant 消息。 */
function thinking(text: string): Message {
  return {
    id: `r${seq++}`,
    role: 'assistant',
    content: [{ type: 'reasoning', text }],
    source: { kind: 'model', provider: 'p', model: 'm' },
  } as unknown as Message
}

// ------------------------------------------------------- 根因回归（规则 1）
test('根因回归：恢复出来的巨大会话 + 一条短消息 ⇒ 规则 1 触发 DeepSeek', () => {
  const history = [user('x'.repeat(CUMULATIVE_LIMIT)), assistant('好的')]
  const batch = [user('继续')]
  const snapshot = measureInput(history, batch)
  assert.ok(snapshot.cumulativeWeight > CUMULATIVE_LIMIT)
  assert.deepEqual(route(snapshot), DEEPSEEK)
})

test('根因回归：只看本步新消息（旧口径）必然漏掉历史 ⇒ 不会触发规则 1', () => {
  const onlyNew = measureInput([], [user('继续')])
  assert.notDeepEqual(route(onlyNew), DEEPSEEK)
  assert.deepEqual(route(onlyNew), CW_INSTANT)
})

test('规则 1 的阈值口径：历史恰好等于阈值不触发，超出即触发', () => {
  assert.notDeepEqual(route(measureInput([user('x'.repeat(CUMULATIVE_LIMIT))])), DEEPSEEK)
  assert.deepEqual(route(measureInput([user('x'.repeat(CUMULATIVE_LIMIT + 1))])), DEEPSEEK)
})

// ------------------------------------------------------- 两条口径分离
test('last 用**本步**用户消息（不被历史末尾的 assistant / 工具结果顶替）', () => {
  const snapshot = measureInput([user('旧问题'), assistant('y'.repeat(5_000))], [user('你好')])
  assert.equal(snapshot.last, '你好')
  assert.deepEqual(route(snapshot), CW_INSTANT)          // 规则 5：按当前意图分档
})

test('插件注入的 user-role 消息**不**劫持 last（当前意图仍是用户那句话）', () => {
  const snapshot = measureInput([user('你好')], [injected('goal 轮次继续')])
  assert.equal(snapshot.last, '你好')
  assert.deepEqual(route(snapshot), CW_INSTANT)
  assert.ok(snapshot.cumulativeWeight >= weight('你好'))   // 注入文本体量照算
})

test('连续多轮：last 取最后一条用户消息，cumulativeWeight 覆盖全部历史', () => {
  const history = [user('第一问'), assistant('答一'), user('第二问'), assistant('答二')]
  const snapshot = measureInput(history, [user('第三问')])
  assert.equal(snapshot.last, '第三问')
  const expected = weight('第一问') + weight('答一') + weight('第二问') + weight('答二') + weight('第三问')
  assert.equal(snapshot.cumulativeWeight, expected)
})

// ------------------------------------------------------- 空消息语义（P2-01）
test('bug 修正：最新用户消息无文本时，last 覆盖为 ""（不泄漏旧关键词）', () => {
  const snapshot = measureInput([user('快速帮我写个函数')], [userImage()])
  assert.equal(snapshot.last, '')                       // 纯图片 ⇒ last 为空，不沿用「快速」
  assert.deepEqual(route(snapshot), CW_INSTANT)          // 不再命中旧「快速」⇒ DeepSeek
})

// ------------------------------------------------------- 文本折算
test('messageText：工具结果内层文本计入（巨大会话的主体）', () => {
  assert.equal(messageText(toolResult('tool output')), 'tool output')
  const snapshot = measureInput([toolResult('z'.repeat(CUMULATIVE_LIMIT + 1))])
  assert.deepEqual(route(snapshot), DEEPSEEK)
})

test('messageText：reasoning 文本**不计**（provider 内部思考，不是对话体量）', () => {
  assert.equal(messageText(thinking('思考'.repeat(1_000))), '')
  const snapshot = measureInput([assistant('答'), thinking('思考'.repeat(200_000))], [user('继续')])
  assert.ok(snapshot.cumulativeWeight < 1_000)
  assert.deepEqual(route(snapshot), CW_INSTANT)
})

test('messageText：空消息不产生体量', () => {
  const empty = { id: 'e1', role: 'user', content: [], source: { kind: 'user' } } as unknown as Message
  const snapshot = measureInput([empty], [])
  assert.equal(snapshot.cumulativeWeight, 0)
  assert.equal(snapshot.last, '')
})

test('空历史 + 空批次 ⇒ 空口径（路由交给调用方的兜底档）', () => {
  const snapshot = measureInput([], [])
  assert.deepEqual(snapshot, { last: '', cumulativeWeight: 0 })
  assert.deepEqual(route({ last: '', cumulativeWeight: 0 }), CW_INSTANT)
})

// ------------------------------------------------------- 流式权重（P2-05）
test('流式权重：超过阈值后不再累加（早停，结果只用于 >阈值 判定）', () => {
  const history = [user('x'.repeat(CUMULATIVE_LIMIT + 1)), user('y'.repeat(1_000_000))]
  const snapshot = measureInput(history)
  // 早停：一旦 > 阈值就不再继续累加，cumulativeWeight 是「已超阈值」的有界值
  assert.ok(snapshot.cumulativeWeight > CUMULATIVE_LIMIT)
  assert.ok(snapshot.cumulativeWeight < CUMULATIVE_LIMIT * 2)
  assert.deepEqual(route(snapshot), DEEPSEEK)
})
