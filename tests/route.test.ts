/**
 * 纯函数单测（零依赖：Node 原生 TS 类型剥离 + `node --test`）。
 *
 * 覆盖：规则 1→8 每条、**顺序**（快速 vs 代码）、两条口径的**分离**（bug 修正）、
 * 长度分档边界、硬约束守卫（luna / extra-high / effort / provider-model 错配）、以及
 * **model id 与 provider 目录一致**（`chatgpt-web/instant` 不存在——回归守卫）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { KEYWORD_RULES } from '../src/keywords.ts'
import { CUMULATIVE_LIMIT, MEDIUM_LIMIT, SHORT_LIMIT, weight } from '../src/measure.ts'
import {
  assertEffort,
  assertRouteDecision,
  CW_HIGH,
  CW_INSTANT,
  CW_MEDIUM,
  CW_MODELS,
  DEEPSEEK,
  DEEPSEEK_MODELS,
  FORBIDDEN_MODEL,
  MODELS_BY_PROVIDER,
} from '../src/policy.ts'
import { route } from '../src/route.ts'

/** 短输入 + 给定累积文本（自动折算加权）的便捷构造。 */
function at(last: string, cumulative = last) {
  return route({ last, cumulativeWeight: weight(cumulative) })
}

test('weight：CJK 计 2、其余计 1（含全角标点与代理对）', () => {
  assert.equal(weight(''), 0)
  assert.equal(weight('abcd'), 4)
  assert.equal(weight('中文'), 4)
  assert.equal(weight('中a'), 3)
  assert.equal(weight('，'), 2)          // 全角标点落在 FF00-FFEF
  assert.equal(weight('😀'), 1)          // 代理对按**码点**算 1（"其他=1"）
  assert.equal(weight('中文abc'), 7)
})

// ---------------------------------------------------------------- 规则 1
test('规则 1：累积加权超阈值 ⇒ DeepSeek', () => {
  assert.equal(at('你好', 'a'.repeat(CUMULATIVE_LIMIT)).provider, 'chatgpt-web')       // 恰为阈值：不触发
  assert.equal(at('你好', 'a'.repeat(CUMULATIVE_LIMIT + 1)).provider, 'deepseek-official')
  // 加权口径：阈值/2 个汉字 = 阈值 ⇒ 不触发；再加一个汉字即触发
  assert.equal(at('你好', '中'.repeat(CUMULATIVE_LIMIT / 2)).provider, 'chatgpt-web')
  assert.equal(at('你好', '中'.repeat(CUMULATIVE_LIMIT / 2 + 1)).provider, 'deepseek-official')
})

test('规则 1 只看**累积**口径，不因最后一条很短而放行', () => {
  const huge = 'x'.repeat(CUMULATIVE_LIMIT + 1)
  assert.deepEqual(at('你好', huge), DEEPSEEK)
})

// ---------------------------------------------------------------- 规则 2/3/4
test('规则 2：速度/简短要求 ⇒ DeepSeek', () => {
  for (const text of ['快速看一下', '立刻回答', '简单说', '简短点', '就一句', '马上给我']) {
    assert.deepEqual(at(text), DEEPSEEK, text)
  }
})

test('规则 3：复杂度信号 ⇒ chatgpt-web/high（含大小写）', () => {
  for (const text of ['这个架构怎么改', '多步推理', '设计变更', '调试一下', '有个BUG', '契约不一致']) {
    assert.deepEqual(at(text), CW_HIGH, text)
  }
})

test('规则 4：代码/审查信号 ⇒ chatgpt-web/high（含大小写与 refactor/review）', () => {
  for (const text of ['帮我写代码', 'refactor this', '重构这段', '审查一下', 'Do a REVIEW', '这段代码']) {
    assert.deepEqual(at(text), CW_HIGH, text)
  }
})

test('顺序：「快速 + 代码」必须走规则 2（速度优先于复杂度）', () => {
  assert.deepEqual(at('快速帮我写个函数'), DEEPSEEK)
  assert.deepEqual(at('简单重构一下就行'), DEEPSEEK)
  assert.deepEqual(at('马上 review 这段代码'), DEEPSEEK)
})

test('结构：规则 2 必须排在规则 3/4 之前（改序即红）', () => {
  const ids = KEYWORD_RULES.map(rule => rule.id)
  assert.deepEqual(ids, [2, 3, 4])
})

// ---------------------------------------------------------------- 规则 5/6/7
test('规则 5/6/7：**最后一条**的加权长度分档', () => {
  assert.deepEqual(at('a'.repeat(SHORT_LIMIT)), CW_INSTANT)                 // 100 ⇒ light
  assert.deepEqual(at('a'.repeat(SHORT_LIMIT + 1)), CW_MEDIUM)              // 101 ⇒ medium
  assert.deepEqual(at('a'.repeat(MEDIUM_LIMIT)), CW_MEDIUM)                 // 2000 ⇒ medium
  assert.deepEqual(at('a'.repeat(MEDIUM_LIMIT + 1)), CW_HIGH)               // 2001 ⇒ high
  assert.deepEqual(at('中'.repeat(SHORT_LIMIT / 2)), CW_INSTANT)            // 50 汉字 = 100
  assert.deepEqual(at('中'.repeat(SHORT_LIMIT / 2 + 1)), CW_MEDIUM)         // 51 汉字 = 102
})

test('bug 修正：历史很长但最后一句很短 ⇒ 按**当前意图**分档（不误判 high）', () => {
  const history = 'x'.repeat(20_000)          // 远低于阈值
  assert.deepEqual(at('你好', history), CW_INSTANT)
  assert.deepEqual(at('谢谢', history), CW_INSTANT)
})

test('规则 8：route() 对任意输入都返回合法决策（永不 undefined）', () => {
  const samples = ['', 'a', '你好世界', '中'.repeat(1000), 'x'.repeat(CUMULATIVE_LIMIT + 5), '快速修复']
  for (const text of samples) {
    const decision = route({ last: text, cumulativeWeight: weight(text) })
    assertRouteDecision(decision)                              // 不抛 = 通过硬约束
    assert.ok(decision.model.length > 0)
  }
})

// ---------------------------------------------------------------- 硬约束
test('硬约束：禁止 luna / extra-high 出现在任何模型名里', () => {
  assert.ok(FORBIDDEN_MODEL.test('luna'))
  assert.ok(FORBIDDEN_MODEL.test('chatgpt-web/extra-high'))
  assert.throws(() => assertRouteDecision({ provider: 'chatgpt-web', model: 'luna' }), /禁止名/)
  assert.throws(() => assertRouteDecision({ provider: 'chatgpt-web', model: 'x/extra-high' }), /禁止名/)
  for (const decision of [DEEPSEEK, CW_INSTANT, CW_MEDIUM, CW_HIGH, ...KEYWORD_RULES.map(r => r.to)]) {
    assertRouteDecision(decision)
    assert.ok(!FORBIDDEN_MODEL.test(decision.model), decision.model)
  }
})

test('硬约束：provider 白名单', () => {
  assert.throws(
    () => assertRouteDecision({ provider: 'openai' as never, model: 'gpt' }),
    /不在白名单/,
  )
})

test('硬约束：effort —— chatgpt-web 绝不写；deepseek 不越界检查', () => {
  assertEffort('chatgpt-web', undefined)                       // 不写 = 合法
  assert.throws(() => assertEffort('chatgpt-web', 'high'), /绝不写/)   // 写了 = 违规
  // deepseek-official 的 effort 由 adapter 决定，插件不检查（off/low/high/max 都合法）
  assertEffort('deepseek-official', undefined)
  assertEffort('deepseek-official', 'high')
  assertEffort('deepseek-official', 'off')
  assertEffort('deepseek-official', 'max')
  assertEffort('deepseek-official', 'extra-high')              // 不抛：交给 adapter
})

// ---------------------------------------------------------------- model id 回归
test('model id：低档必须是 chatgpt-web/light（DSH 里 "Instant" 的 id 是 light）', () => {
  assert.equal(CW_INSTANT.model, 'chatgpt-web/light')
  // `chatgpt-web/instant` **不存在**：写错必须被判非法
  assert.throws(
    () => assertRouteDecision({ provider: 'chatgpt-web', model: 'chatgpt-web/instant' }),
    /不属于 provider/,
  )
})

test('model id：目录快照逐 provider 完整，错配被拒', () => {
  assert.deepEqual([...CW_MODELS], [
    'chatgpt-web/luna',
    'chatgpt-web/think',
    'chatgpt-web/light',
    'chatgpt-web/medium',
    'chatgpt-web/high',
    'chatgpt-web/extra-high',
    'chatgpt-web/pro',
  ])
  assert.deepEqual([...DEEPSEEK_MODELS], [
    'deepseek-flash',
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'deepseek-v4-flash-vision-exp',
  ])
  const cw = MODELS_BY_PROVIDER.get('chatgpt-web')!
  const ds = MODELS_BY_PROVIDER.get('deepseek-official')!
  for (const model of CW_MODELS) assert.ok(cw.has(model), model)
  for (const model of DEEPSEEK_MODELS) assert.ok(ds.has(model), model)
  // provider-model 错配必须被拒（P2-03）
  assert.throws(
    () => assertRouteDecision({ provider: 'deepseek-official', model: 'chatgpt-web/high' }),
    /不属于 provider/,
  )
  assert.throws(
    () => assertRouteDecision({ provider: 'chatgpt-web', model: 'deepseek-flash' }),
    /不属于 provider/,
  )
  // luna / extra-high 在**目录**里（所以能查到），但被禁止名守卫挡下
  assert.throws(() => assertRouteDecision({ provider: 'chatgpt-web', model: 'chatgpt-web/luna' }), /禁止名/)
})

test('model id：所有路由目标的 model 都在其 provider 目录内（再打错一个即红）', () => {
  for (const decision of [DEEPSEEK, CW_INSTANT, CW_MEDIUM, CW_HIGH, ...KEYWORD_RULES.map(r => r.to)]) {
    assert.ok(MODELS_BY_PROVIDER.get(decision.provider)?.has(decision.model), decision.model)
    assertRouteDecision(decision)
  }
})
