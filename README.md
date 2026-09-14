# my-chatgpt-router（DSH 插件）

按任务预估在 `deepseek-official` 与 `chatgpt-web` 之间路由模型。**不做超时 fallback**。

**位置**：`C:\Users\Nieou\.dsh\plugins\my-chatgpt-router\`（用户级插件目录，随用户走，不污染上游 DSH 检出）。

## 状态

| 部分 | 状态 |
| --- | --- |
| 纯函数（`measure` / `keywords` / `policy` / `route` / `capture` / `selection`） | ✅ **35/35 单测通过**（离线、零外部依赖） |
| `index.ts`（接线）+ `selection-projection.ts`（投影） | ✅ 已写；**⚠ 未真机验证** |
| 在 `web` profile 中挂载 | ✅ 已加进 `dsh.profile.bundles`（重启后生效） |

## 路由表（判断顺序 1→8，先匹配先返回）

| 顺序 | 条件 | provider | model |
| --- | --- | --- | --- |
| 1 | **累积**会话文本加权 > 100000（启发式） | deepseek-official | deepseek-flash |
| 2 | 命中 `快速\|立刻\|简单\|简短\|就一句\|马上` | deepseek-official | deepseek-flash |
| 3 | 命中 `复杂\|多步\|架构\|设计变更\|调试\|bug\|契约`（i） | chatgpt-web | chatgpt-web/high |
| 4 | 命中 `写代码\|refactor\|重构\|审查\|review\|代码`（i） | chatgpt-web | chatgpt-web/high |
| 5 | **最后一条用户消息**加权 ≤ 100 | chatgpt-web | **chatgpt-web/light** |
| 6 | **最后一条用户消息**加权 101–2000 | chatgpt-web | chatgpt-web/medium |
| 7 | **最后一条用户消息**加权 > 2000（无关键词） | chatgpt-web | chatgpt-web/high |
| 8 | 兜底（空口径 / 无快照时） | chatgpt-web | chatgpt-web/medium |

**长度口径统一加权**：CJK = 2，其他 = 1（按码点迭代，代理对算 1）。

> ⚠ **规则 1 是「启发式体量路由」，不是物理上限保证。** 阈值 10 万（加权）给 JSON 转义、
> 工具 schema、协议文本留约 5 万余量；极端输入（海量转义字符）仍可能超过 ChatGPT Web 的
> 200,000 字符 composer 预算，此时由 `dsh-llm-chatgpt-web` adapter 报错兜底。真正的硬保证
> 需要 adapter 同源估算或 DSH 暴露 prompt 长度预检——留作未来工作。

### model id 必须来自 provider 目录（实测）

| provider | 目录 id | 出处 |
| --- | --- | --- |
| chatgpt-web | `chatgpt-web/luna` \| `think` \| `light` \| `medium` \| `high` \| `extra-high` \| `pro` | `dsh-llm-chatgpt-web/src/index.ts:59-67` |
| deepseek-official | `deepseek-flash` \| `deepseek-v4-flash` \| `deepseek-v4-pro` \| `deepseek-v4-flash-vision-exp` | `llm-deepseek/src/index.ts:92-122` |

⚠ **DSH 里显示名 "Instant" 的那一档，model id 是 `chatgpt-web/light`**——
`chatgpt-web/instant` **不存在**（旧代码写错）。`policy.ts` 用 `MODELS_BY_PROVIDER`
（逐 provider 的目录快照）做**可执行断言**：写错 id 或 provider-model 错配，单测立刻红。

注意：`listModels` 目录是 advisory（不被目录成员资格强制路由），因此这里的校验是
「插件自己挑的决策不越界」，不是运行时可解析性的保证。缺目录目标的告警措辞是
「可能在 adapter/provider 阶段失败」，而不是 `NO_ADAPTER`（后者只表示 provider 无 adapter 注册）。

## 两条文本口径是刻意的（bug 修正 ①）

- **关键词（2–4）与分档（5–7）只看最后一条用户消息** —— 反映「**当前意图**」；
- **累积阈值（1）看累积会话加权** —— 反映「**桥接体量**」（启发式）。

### 口径从哪来（规则 1 失效的根因）

旧实现把 `cumulative` 建成「`agent/pre-step` 收到的 `messages` 的拼接」。但那个 payload
里的 `messages` = **本步从 inbox 领走的新消息**（`agent-loop/src/agent.ts:244` 的
`inbox.claim(...)`），**不是会话历史**。⇒ 恢复的巨大会话只领到一条短消息 ⇒ 规则 1 永不
触发 ⇒ 撞 `COMPOSER_CHAR_BUDGET = 200_000`（`dsh-llm-chatgpt-web/src/chatgpt/turn.ts:47`）。

现在口径取自 `session.deriveMessages()`（完整、压缩感知、含恢复历史）+ 尚未落盘的本步新
消息。`capture.ts` 折算时**流式累加 `cumulativeWeight`，超阈值早停**（不再构造完整大字符串）。

**计入体量**：`text` + `tool-call.arguments` + `tool-result` 内层文本。**不计**：`reasoning`
（provider 内部思考）、`image`/`file`/未知块。`last` 只认**用户本人**消息（`source.kind === 'user'`），
且**最新用户消息无文本时 `last` 覆盖为 `''`**（P2-01：避免旧关键词泄漏）。

## 用户显式选择优先（bug 修正 ②，裁决后）

| 场景 | 行为 |
| --- | --- |
| 从未手动切过 | 插件**路由**（规则 1→8） |
| 手动切到**非默认**模型 | 插件**放行**（不改 provider/model） |
| 手动切回**默认**模型 | 插件**恢复自动路由**（「切回默认即恢复自动」） |

判据是**持久投影**，不是猜的：GUI 模型选择器走 `session-controller.selectModel` →
`agent.session.append('model/selection', …)`（`api/session-controller/src/agent.ts:327`）。
插件用**自注册投影**（`selection-projection.ts`）把「最后一次 `model/selection`」折成
`{ lastSelection }`，在 `agent/request` 里与**启动时捕获的默认模型**对比：

- 为什么用投影：`Session.eventAt()` 在宿主里被标 `@deprecated` 且「new calls are prohibited」；
  `session/event` 订阅在 resume 时**不重放历史**；投影由 `sessionProjections.stateOf()`
  懒折叠**全量内存日志**（含 resume/fork 继承），跨重启语义正确。
- 为什么默认参照在 `apply()` 时捕获一次：`selectModel` 会 `saveSelection` 改写 settings 里的
  默认模型，每请求读 `currentSelection()` 会让「默认」永远等于「最后一次选择」，使
  「切回默认恢复自动」失效。

> 注意：任何 `selectModel` 调用（GUI 或 API 客户端）都算显式选择；「手动切过」本身不区分来源。

## effort 政策（裁决后收敛，唯一硬不变量）

统一 `finalizeConfig`——**按目标 provider 决定，不按路径**（自动/手动/non-root 全走同一出口）：

| 目标 provider | `reasoningEffort` 行为 |
| --- | --- |
| `chatgpt-web` | **删**（`chatgpt-web` 绝不带 effort——唯一硬不变量） |
| `deepseek-official` | **尊重继承值**（adapter 支持 off/low/high/max，插件不越界定义允许集） |
| `deepseek-official` + `FORCE_DEEPSEEK_HIGH=true` | **写 `high`**（覆盖继承值） |

`assertEffort(provider, effort)` 简化为只检查「chatgpt-web ⇒ 无 effort」，不再定义 DeepSeek 允许集。

## `index.ts` 分支行为契约（逐分支）

| 触发条件 | provider 目标 | `reasoningEffort` |
| --- | --- | --- |
| **非 root**（`ctx.agents.roots()` 里没有它） | 放行（不改） | 走 `finalizeConfig`（目标是 chatgpt-web 也清 effort） |
| root + 手动切到**非默认**模型 | 放行（不改） | 走 `finalizeConfig` |
| root + 口径为空 / 无快照 | chatgpt-web/medium | 清 effort |
| root + 有口径 | 由 `route()` 决定 | 走 `finalizeConfig` |

**实现次序**：`agent/request` 里先 `await next()`（让下游定稿），再由本插件定稿 ⇒ **下游优先、本插件最后定**。

## ⚠ 必读：package.json 必须带 `version`

`plugin-package-inventory-deepseek` 每次 official DeepSeek 请求前枚举 active 插件身份，
`identityFromManifest`（`llm/plugin-package-inventory-deepseek/src/index.ts:64-67`）对**缺
`version`** 的包直接 `throw`，被 `llm-deepseek` 包成 `REQUEST_EXTENSION`。本插件已补
`"version": "0.1.0"`。以后任何挂进 bundles 的插件，`package.json` 都必须有非空 `name` + `version`。

## 依赖与挂载

- `inject = ['agents', 'llm', 'sessionProjections', 'agentDefaultModel']`。
- 运行时 import：`@deepseek-ai/dsh-llm`（`ReasoningEffortId`）+ `zod`（投影 schema）。
  `@deepseek-ai/dsh-session` 只用 `import type`（brand 擦除），不新增运行时依赖。
- 挂载：`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 已含 `my-chatgpt-router`
  （装载链只认 bundles：`boot/app-boot/src/profile.ts:776`、`apps/cli/src/profile-boot.ts:235`）。

## 启动期自检（只 warn，不 fallback）

`apply()` 对两个 provider 各调一次 `listModels`，核对四个路由目标 id：
- 缺任何一个 ⇒ `warn`（可能在 adapter/provider 阶段失败——DSH 的正确报错，插件不吞错）；
- `listModels` 抛错 ⇒ `warn`（同样不 fallback）。

## 影响面限定（只对 root session）

`AgentRegistry.roots()` = 所有 `entry.owner === undefined` 的存活 agent
（`packages/core/agent/src/index.ts:591-599`），据此 `isRoot`。代价 O(存活 agent 数)/请求（可忽略）。
**注意**：被恢复的 fork 仍可能算 root——这是文档定义的语义。

## 运行单测

```sh
cd C:\Users\Nieou\.dsh\plugins\my-chatgpt-router
npm test                                   # = node --test --test-isolation=none "tests/*.test.ts"
```

**两处坑（实测）**：① 必须 `--test-isolation=none`——本机沙箱禁止「子进程 + 管道 stdio」，
默认每文件子进程会 `spawn EPERM`；② 该模式下传**目录**会被当模块路径，必须用 **glob**。

## 目录

```
my-chatgpt-router/
  src/measure.ts           # 加权度量 + 阈值（100k / 100 / 2000）
  src/keywords.ts          # 关键词规则表（规则 2/3/4）
  src/policy.ts            # 决策常量、逐 provider 目录快照、硬约束守卫
  src/route.ts             # 纯路由（规则 1→8）
  src/capture.ts           # 历史+本步消息 → { last, cumulativeWeight }（流式）
  src/selection.ts         # 纯折叠：model/selection → lastSelection
  src/selection-projection.ts  # 持久投影（替换 deprecated eventAt）
  src/index.ts             # 接线：pre-step / request / finalizeConfig / 自检
  tests/{route,capture,selection}.test.ts   # 35 条单测
  package.json             # type: module + version + test 脚本
  cordis.patch.yml
  README.md
```

## 未做的事（诚实边界）

- **未真机验证**：`index.ts` 的接线、投影注册、root 判定、effort 收口、`model/selection` 放行
  都**没在运行时跑过**——需要重启 DSH 后用 `request/header` 核对最终 provider/model/effort，
  并验证「手动切模型 / 巨大会话 / 切回默认 / resume / provider-model 错配」五个场景。
- **未写 `index.ts` 的集成测试**：它的分支依赖 harness 运行时；已把可纯化的部分（口径折算、
  选择折叠）抽到 `capture.ts` / `selection.ts` 并测到。投影的 resume/fork/compaction 正确性
  **委托宿主投影机制保证**（`cellFor` 会折完整内存日志），未单独集成测试。
