# 消息队列审查与重构记录

> 范围：`js/queue.js`（QueueStore + 队列面板）、`js/api.js`（executeChatRequest / stopGeneration / updateSendButton）、`js/app.js`（sendMessage / retry* / buildContextWithTrim / init）、`js/db.js`（queue store）、`css/components/input.css`。
> 上一版报告针对的是 `isProcessingQueue` / `messageQueue` / 全局 `currentChat` 快照的旧实现，代码已不存在，本文件整体重写。

---

## 一、本轮修复的问题

### P0-1 跨会话发送把「忙」记成「失败」
旧行为：A 会话流式输出时在 B 会话按回车 → `sendMessage` 只看当前会话是否 busy → `executeChatRequest` 发现 `abortController` 已被占用 → 返回 `failed` → 队列判定失败、暂停，并往 B 的 `chat.messages` 里写一条「消息发送失败：已有请求正在执行」。

现状：
- `executeChatRequest` 遇到在途请求返回 `{ ok:false, busy:true }`，**不再算失败**。
- 新增 `whenRequestIdle()` / `notifyRequestIdle()`（`js/api.js`），队列与就地重试都先等待全局空闲再发，抢跑失败只重试（最多 10 次 × 300ms）。
- 所有队列推进统一走 `QueueStore.pump()`：全局单飞、当前会话优先、一个会话跑完再挑下一个。
- 发送键只在「当前会话自己」有请求时变成停止键（`getActiveRequestChatId()`），别的会话在跑时仍可正常发送/入队。

### P0-2 错误消息污染对话上下文
旧行为：失败/中止时 `_recordError` 把一条 `role:'assistant', isError:true` 的消息 push 进 `chat.messages` 并落库，`buildContextWithTrim` 全量透传，之后每次请求都会把「消息发送失败：HTTP 500」当 assistant 回复发给模型。

现状：
- 错误只挂在队列项上：`item.status='failed'` + `item.error={message,aborted}`，由队列面板展示（含「重试 / 保留回复 / 移除」）。
- `chat.messages` 不再产生 `isError` 消息；`buildContextWithTrim` 额外过滤 `isError` 兜底。
- 启动时 `QueueStore.purgeLegacyErrors()` 清理历史遗留的 `isError` 消息（这些是自动生成的传输错误文本，不是用户内容）。

### P0-3 中止丢失已生成内容
旧行为：`aborted` 时 `assistantCommitted` 为 false，整段流式输出直接丢弃。

现状：中止也会把已生成内容落库（`aborted:true` + `_queueItemId`）。队列面板提供：
- **重试**：回滚该条气泡（user 占位 + 半截回复），按最新内容重发；
- **保留回复**：保留半截回复，丢弃该队列项并继续后面的队列。

### P0-4 失败项「两份真相」
旧行为：失败项同时存在于 `items[0]` 和 `failedItem`，且 `restore()` 会把失败项从 `items` 里删掉（刷新前后行为不一致）；暂停时还能移动/删除失败项，导致「移除」是假的、重试顺序错乱。

现状：
- 失败项只存在于 `items`（`status:'failed'`），`getSnapshot().failedItem` 由它派生。
- `restore()` 把旧记录里的 `failedItem` 合并回队首；`_reconcileWithChat()` 会丢弃「user 气泡后已紧跟完整 assistant 回复」的残留项。
- 暂停/失败期间：失败项禁止移动与编辑（`move`/`updateItem` 直接返回 false），但允许「移除」——移除会撤掉它的气泡并解除暂停、继续后面的队列。
- 刷新后不自动续跑：有残留项的队列一律置为「已暂停」，交给用户点「继续队列」。

---

## 二、当前实现要点

### 状态机
```
queued ──(发起请求)──> sending ──(成功)──> 出队
                           └────(失败/中止)──> failed + pauseReason('failure'|'user')
```
- `pauseReason` 只有 `'user' | 'failure' | null`；失败项只能由 `retryFailed()`（重试）、`keepFailedAndContinue()`（保留回复）、`remove()`/`clearQueue()`（放弃）解除。
- `pump()` 保证同一时刻只有一个会话在跑队列；`processing` 集合同时承载「队列处理中」与「就地重生成」（`markBusy`）。
- 单条消息发送也走队列（入队 → pump → 出队），所以「停止 → 重试/保留/清空」是统一路径。

### 持久化
- 按会话串行写入（`persistChains`），150ms 合并，`pagehide`/`visibilitychange` 强制 flush。
- 队列为空且未暂停时删除记录，不再积累空记录。
- 版本号去重，避免同一轮对话多次全量重写。

### 界面
- 面板仅在「暂停 / 多项排队 / 单项等待中」时出现；单条正在发送时不展开（消息本身在对话里可见）。
- 每项状态标签：`发送中` / `失败` / `已裁剪`；失败项下方内联错误详情与操作按钮。
- 发送键：停止（当前会话有请求）/ 重试（失败暂停）/ 继续队列（用户暂停）/ 处理中 / 发送。

---

## 三、遗留问题与取舍

| 级别 | 问题 | 说明 |
| --- | --- | --- |
| 中 | 队列项含 base64 附件 | 队列记录与 `chat.messages` 各存一份图片；大图队列仍会放大 IndexedDB 占用。彻底解决需要拆出独立 blob store。 |
| 中 | 无队列长度/单条体积上限 | 可无限堆积；建议后续加条数与总体积阈值。 |
| 中 | 重试策略不分类 | `executeChatRequest` 对 401/400/429 一律重试 3 次（0/3s/6s）；401 无意义，429 会加剧限流。 |
| 低 | 刷新后不自动续跑 | 有意为之（避免打开页面就自动发请求），靠「继续队列」按钮显式恢复。 |
| 低 | 全局单飞 | 一个会话的队列跑完才轮到下一个；符合当前「同时只允许一个请求」的设定，但多会话批量任务会串行。 |
| 低 | autoPolish / autoFixEnglish / detectRefuse 的 fetch 不归 abortController 管 | 停止生成只能中止主请求，这些附属请求仍会跑完（结果只作用于最后一条 assistant，最坏是跳过）。 |
| 低 | 队列面板 innerHTML 全量重建 | 每次状态变化重建整个列表；队列很长时会有轻微抖动。 |

---

## 四、待测试清单

| 等级 | 场景 | 期望 |
| --- | --- | --- |
| Lv1 | 页面加载、切换会话、开关队列面板 | 无报错；面板状态随会话切换正确 |
| Lv2 | 单条发送 → 停止 → 重试 / 保留回复 / 清空 | 三种出口都能正确收尾，不残留队列项 |
| Lv2 | A 会话流式输出时在 B 会话发送 | 入队提示「等待当前请求完成」，A 结束后自动发 B，B 不出现错误气泡 |
| Lv3 | 连发 3~5 条（Enter 或「加入队列」） | 严格按顺序串行，逐条出队，中断后停在失败项 |
| Lv3 | 失败注入（断网 / 错误 Key） | 面板显示失败详情，`chat.messages` 无错误消息，刷新后仍为暂停态 |
| Lv3 | 队列中途刷新页面 | 恢复为「已暂停」，点继续后不重复发送已完成的消息 |
| Lv4 | 带图片消息入队 + 刷新 | 内容完整，尺寸大时观察写入耗时 |
| Lv5 | 会话 A 队列运行中删除会话 B / 清空 B 对话 | 互不影响，B 的队列记录被清理 |
