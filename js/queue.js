function cloneQueueContent(content) {
    if (typeof content === 'string') return content;
    return JSON.parse(JSON.stringify(content));
}

function createQueueId() {
    return `q_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function sleepQueue(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 队列项统一结构：
//   { id, chatId, content, trimmed, status: 'queued' | 'sending' | 'failed', error: null | { message, aborted } }
// status 是唯一的"这条消息现在什么状态"真相；error 只挂在队列项上，不写进 chat.messages。
function normalizeQueueItem(item, fallbackChatId = state.currentChatId) {
    if (item === null || item === undefined) return null;
    if (typeof item === 'string' || Array.isArray(item)) {
        return {
            id: createQueueId(), chatId: fallbackChatId, content: cloneQueueContent(item),
            trimmed: false, status: 'queued', error: null
        };
    }
    if (typeof item !== 'object') return null;
    const content = item.content !== undefined ? item.content : '';
    return {
        ...item,
        id: item.id || createQueueId(),
        chatId: item.chatId || fallbackChatId,
        content: cloneQueueContent(content),
        trimmed: !!item.trimmed,
        // 刷新时残留的 sending 一律归位为 queued（请求已随页面销毁）
        status: item.status === 'failed' ? 'failed' : 'queued',
        error: item.error && typeof item.error === 'object' ? { ...item.error } : null
    };
}

function queueItemPreview(item) {
    const content = item && item.content;
    if (typeof content === 'string') return content || '（空消息）';
    if (Array.isArray(content)) {
        const text = content.filter(p => p && p.type === 'text').map(p => p.text || '').join('\n').trim();
        const images = content.filter(p => p && p.type === 'image_url').length;
        return `${text}${images ? `${text ? '\n' : ''}[${images} 张图片]` : ''}` || '（附件消息）';
    }
    return String(content ?? '');
}

// 队列面板预览：截断长文本，避免撑爆面板
function queueItemShortPreview(item, maxLen = 80) {
    const text = queueItemPreview(item).replace(/\s+/g, ' ').trim();
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + '…';
}

function describeQueueError(item) {
    if (!item || !item.error) return '';
    return item.error.message || '消息发送失败';
}

// ── 队列领域模型 ──────────────────────────────────────────────
// 每个 chat 一条独立队列；全局同一时刻只允许一个请求在途（abortController）。
// 所有队列推进都经过 pump()，由它保证"一次只跑一个 chat、一个 chat 跑完再挑下一个"。
//
// 状态机：
//   queued ──(发起请求)──> sending ──(成功)──> 出队
//                              └────(失败/中止)──> failed + pauseReason('failure'|'user')
//   失败项留在 items[0]（唯一真相），恢复只能 retryFailed()（重试队头）或 clearQueue()（放弃）。
const QueueStore = (() => {
    const queues = new Map();          // chatId -> { items, pauseReason, version }
    const processing = new Set();      // 正在处理的 chatId（含手动重生成路径）
    const listeners = new Set();
    const persistTimers = new Map();
    const persistChains = new Map();
    const persistedVersions = new Map();

    function _queue(chatId) {
        let q = queues.get(chatId);
        if (!q) {
            q = { items: [], pauseReason: null, version: 0 };
            queues.set(chatId, q);
        }
        return q;
    }

    // 只读访问，不会为陌生 chatId 创建空队列
    function _peek(chatId) { return queues.get(chatId) || null; }

    function emit() {
        listeners.forEach(fn => { try { fn(); } catch (e) { console.warn('Queue listener failed:', e); } });
    }

    function getSnapshot(chatId) {
        const q = _peek(chatId);
        const items = q ? q.items.slice() : [];
        const failedItem = items.find(it => it.status === 'failed') || null;
        const pauseReason = q ? q.pauseReason : null;
        return {
            chatId,
            items,
            pauseReason,
            paused: pauseReason !== null,
            busy: processing.has(chatId),
            sending: items.length > 0 && items[0].status === 'sending',
            failedItem,
            error: failedItem ? failedItem.error : null
        };
    }

    function isPaused(chatId) { const q = _peek(chatId); return !!q && q.pauseReason !== null; }
    function isBusy(chatId) { return processing.has(chatId); }
    function isAnyBusy() { return processing.size > 0; }
    function hasPending(chatId) { const q = _peek(chatId); return !!q && q.items.length > 0; }
    // 当前真正在跑的 chat（用于「停止生成」定位暂停目标）
    function activeChatId() { return processing.size ? processing.values().next().value : null; }

    function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

    function markBusy(chatId) { processing.add(chatId); emit(); }
    function unmarkBusy(chatId) { processing.delete(chatId); emit(); }

    // ── 持久化：按 chat 串行 + 150ms 合并写入，避免一轮对话多次全量重写 ──
    function _writeNow(chatId) {
        const q = _peek(chatId);
        if (!q) return;
        const version = q.version;
        if (persistedVersions.get(chatId) === version) return;
        persistedVersions.set(chatId, version);
        const payload = {
            chatId,
            pauseReason: q.pauseReason,
            items: q.items.map(it => ({ ...it }))
        };
        const prev = persistChains.get(chatId) || Promise.resolve();
        const job = prev
            .then(() => (payload.items.length || payload.pauseReason ? saveQueueState(payload) : deleteQueueState(chatId)))
            .catch(e => console.warn('Queue persist failed:', e));
        persistChains.set(chatId, job);
    }

    function persist(chatId, immediate = false) {
        const q = _peek(chatId);
        if (!q) return;
        const timer = persistTimers.get(chatId);
        if (timer) { clearTimeout(timer); persistTimers.delete(chatId); }
        if (immediate) { _writeNow(chatId); return; }
        persistTimers.set(chatId, setTimeout(() => {
            persistTimers.delete(chatId);
            _writeNow(chatId);
        }, 150));
    }

    function flushPersist() {
        for (const chatId of [...persistTimers.keys()]) {
            clearTimeout(persistTimers.get(chatId));
            persistTimers.delete(chatId);
            _writeNow(chatId);
        }
    }

    // 任何状态变化：版本 +1 → 合并落库 → 通知 UI
    function _touch(chatId, immediate = false) {
        const q = _peek(chatId);
        if (q) q.version++;
        persist(chatId, immediate);
        emit();
    }

    function enqueue(chatId, content, opts = {}) {
        const q = _queue(chatId);
        const item = normalizeQueueItem({ chatId, content });
        if (opts.front) q.items.unshift(item); else q.items.push(item);
        _touch(chatId);
        return item;
    }

    // 移除消息对应的气泡（user 占位 + 中止时留下的半截回复）
    function _rollbackItemMessages(chat, itemId) {
        if (!chat || !Array.isArray(chat.messages)) return;
        const before = chat.messages.length;
        chat.messages = chat.messages.filter(m => m._queueItemId !== itemId);
        if (chat.messages.length === before) return;
        saveState();
        if (chat.id === state.currentChatId) renderMessages();
    }

    function remove(chatId, id) {
        const q = _peek(chatId);
        if (!q || processing.has(chatId)) return false;
        const idx = q.items.findIndex(it => it.id === id);
        if (idx < 0) return false;
        const [removed] = q.items.splice(idx, 1);
        if (removed.status === 'failed') {
            // 移除失败项 = 放弃这条消息：撤掉它的占位气泡，解除暂停继续后面的
            const chat = state.chats.find(c => c.id === chatId);
            if (chat) _rollbackItemMessages(chat, removed.id);
            q.pauseReason = null;
        }
        if (!q.items.length) q.pauseReason = null;
        _touch(chatId, true);
        pump();
        return true;
    }

    function move(chatId, id, delta) {
        const q = _peek(chatId);
        if (!q || processing.has(chatId)) return false;
        const idx = q.items.findIndex(it => it.id === id);
        const to = idx + delta;
        if (idx < 0 || to < 0 || to >= q.items.length) return false;
        if (q.items[idx].status === 'failed' || q.items[to].status === 'failed') return false;
        const [item] = q.items.splice(idx, 1);
        q.items.splice(to, 0, item);
        _touch(chatId);
        return true;
    }

    function updateItem(chatId, id, content) {
        const q = _peek(chatId);
        if (!q || processing.has(chatId)) return false;
        const idx = q.items.findIndex(it => it.id === id);
        if (idx < 0) return false;
        const prev = q.items[idx];
        q.items[idx] = normalizeQueueItem({ ...prev, content });
        q.items[idx].status = prev.status;
        q.items[idx].error = prev.error;
        _touch(chatId);
        return true;
    }

    // 移除队列中与给定 id 集合匹配的项（含失败项），用于重放截断时清理旧队列项
    function purgeIds(chatId, ids) {
        const q = _peek(chatId);
        if (!q || !ids || !ids.size) return false;
        const before = q.items.length;
        const removedFailed = q.items.some(it => it.status === 'failed' && ids.has(it.id));
        q.items = q.items.filter(it => !ids.has(it.id));
        if (removedFailed && !q.items.some(it => it.status === 'failed')) q.pauseReason = null;
        if (!q.items.length) q.pauseReason = null;
        if (before !== q.items.length) {
            _touch(chatId, true);
            return true;
        }
        return false;
    }

    function pause(chatId, reason) {
        const q = _queue(chatId);
        q.pauseReason = reason || 'user';
        _touch(chatId, true);
    }

    function resume(chatId) {
        const q = _peek(chatId);
        if (!q || q.pauseReason === null) return;
        q.pauseReason = null;
        _touch(chatId, true);
    }

    async function resumeAndProcess(chatId) {
        const q = _peek(chatId);
        if (q && q.items.some(it => it.status === 'failed')) return retryFailed(chatId);
        resume(chatId);
        await pump();
    }

    function discardChat(chatId) {
        const timer = persistTimers.get(chatId);
        if (timer) { clearTimeout(timer); persistTimers.delete(chatId); }
        persistChains.delete(chatId);
        persistedVersions.delete(chatId);
        if (queues.delete(chatId)) {
            deleteQueueState(chatId).catch(e => console.warn('Queue delete failed:', e));
            emit();
        }
    }

    function _queueItemText(content) {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content.find(p => p && p.type === 'text')?.text || '';
        }
        return '';
    }

    function _failureMessage(result) {
        if (result && result.aborted) return '已停止生成';
        const detail = result && result.error ? (result.error.message || String(result.error)) : '';
        return detail ? `消息发送失败：${detail}` : '消息发送失败';
    }

    // 处理单个 chat 的队列，直到暂停 / 失败 / 清空。
    // 返回 { progress }：本轮是否真的推进了状态（用于 pump 避免死循环）。
    async function _processChat(chatId) {
        const q = _peek(chatId);
        if (!q) return { progress: false };
        if (processing.has(chatId)) return { progress: false };
        if (q.pauseReason !== null) return { progress: false };
        if (!q.items.length) return { progress: false };
        // 失败项只能由 retryFailed 显式重发
        if (q.items[0].status === 'failed') return { progress: false };
        if (!state.apiKey || !state.selectedModel) {
            showToast('请先配置 API Key 和模型');
            return { progress: false };
        }

        const startLength = q.items.length;
        processing.add(chatId);
        emit();

        try {
            while (q.items.length && q.pauseReason === null) {
                const activeItem = q.items[0];
                if (activeItem.status === 'failed') break;

                const chat = state.chats.find(c => c.id === chatId);
                if (!chat) {
                    q.items.shift();
                    _touch(chatId, true);
                    showToast('队列目标对话不存在，已跳过该消息');
                    continue;
                }

                activeItem.status = 'sending';
                activeItem.error = null;
                emit();

                await ensureAutoChecksBeforeSend(chat);
                if (q.pauseReason !== null) { activeItem.status = 'queued'; emit(); break; }

                const prepared = buildContextWithTrim(chat, activeItem.content);
                activeItem.trimmed = prepared.trimmed;
                if (prepared.trimmed) showToast(`此队列消息将丢弃前 ${prepared.skippedRounds} 轮对话`, { duration: 4000 });

                const existingUser = chat.messages.some(m => m._queueItemId === activeItem.id);
                if (!existingUser) {
                    const isFirstMessage = chat.messages.length === 0;
                    chat.messages.push({ role: 'user', content: cloneQueueContent(activeItem.content), _queueItemId: activeItem.id });
                    if (isFirstMessage) {
                        try { generateTitle(chat.id, _queueItemText(activeItem.content) || '分析图片'); } catch (e) {}
                    }
                }
                saveState();
                _touch(chatId, true);
                if (chat.id === state.currentChatId) renderMessages();

                // 全局单飞：等到没有请求在途再发。抢跑失败（busy）只重试，绝不当成失败。
                let result = null;
                for (let attempt = 0; attempt < 10; attempt++) {
                    await whenRequestIdle();
                    result = await executeChatRequest(chat, prepared.messages, {
                        suppressQueueAutoProcess: true,
                        queueItemId: activeItem.id
                    });
                    if (!result || !result.busy) break;
                    await sleepQueue(300);
                }
                if (!result || result.busy) {
                    result = { ok: false, aborted: false, failed: true, error: new Error('请求长时间被占用，未能启动') };
                }

                if (!result.ok) {
                    activeItem.status = 'failed';
                    activeItem.error = { message: _failureMessage(result), aborted: !!result.aborted };
                    q.pauseReason = result.aborted ? 'user' : 'failure';
                    _touch(chatId, true);
                    // 用户主动停止时 stopGeneration 已经提示过，不再重复
                    if (!result.aborted) showToast(activeItem.error.message, { duration: 5000 });
                    break;
                }

                q.items.shift();
                _touch(chatId, true);
            }
        } catch (error) {
            console.error('Queue processing failed:', error);
            const activeItem = q.items[0] || null;
            if (activeItem) {
                activeItem.status = 'failed';
                activeItem.error = { message: `队列处理失败：${error.message || error}`, aborted: false };
                q.pauseReason = 'failure';
            }
            _touch(chatId, true);
            showToast(`队列处理失败：${error.message || error}`);
        } finally {
            processing.delete(chatId);
            _touch(chatId, true);
        }

        const q2 = _peek(chatId);
        const progress = !q2 || q2.items.length !== startLength || q2.pauseReason !== null;
        return { progress };
    }

    // 全局调度：同一时刻只跑一个 chat 的队列；当前会话优先。
    let _pumpPromise = null;
    function pump() {
        if (_pumpPromise) return _pumpPromise;
        _pumpPromise = (async () => {
            const blocked = new Set();
            try {
                while (true) {
                    const chatId = _pickNextChat(blocked);
                    if (!chatId) break;
                    const { progress } = await _processChat(chatId);
                    if (!progress) blocked.add(chatId);
                }
            } finally {
                _pumpPromise = null;
            }
        })();
        return _pumpPromise;
    }

    function _pickNextChat(blocked) {
        const candidates = [];
        for (const [chatId, q] of queues) {
            if (!q.items.length) continue;
            if (q.pauseReason !== null) continue;
            if (processing.has(chatId)) continue;
            if (q.items[0].status === 'failed') continue;
            if (blocked.has(chatId)) continue;
            if (!state.chats.some(c => c.id === chatId)) continue;
            candidates.push(chatId);
        }
        if (!candidates.length) return null;
        if (candidates.includes(state.currentChatId)) return state.currentChatId;
        return candidates[0];
    }

    // 重试失败/暂停的队头消息：以气泡内容为准回滚占位，再放回队首重新处理
    async function retryFailed(chatId) {
        const q = _peek(chatId);
        if (!q) return false;
        if (processing.has(chatId)) { showToast('队列正在处理中，请稍候'); return false; }

        const item = q.items.find(it => it.status === 'failed') || null;
        if (!item) {
            if (q.pauseReason !== null) { q.pauseReason = null; _touch(chatId, true); pump(); }
            return false;
        }

        const chat = state.chats.find(c => c.id === chatId);
        if (!chat) {
            q.items = q.items.filter(it => it !== item);
            q.pauseReason = q.items.length ? 'user' : null;
            _touch(chatId, true);
            showToast('失败消息的目标对话已不存在，已清理');
            return false;
        }

        // 用户可能已在气泡里改过内容：以气泡为准
        const bubble = chat.messages.find(m => m._queueItemId === item.id);
        if (bubble) {
            item.content = cloneQueueContent(bubble.content);
            item.trimmed = false;
        }
        // 回滚这条消息留下的气泡（含中止时的半截回复），发送时按最新内容重建
        _rollbackItemMessages(chat, item.id);

        item.status = 'queued';
        item.error = null;
        q.items = [item, ...q.items.filter(it => it !== item)];
        q.pauseReason = null;
        _touch(chatId, true);
        await pump();
        return true;
    }

    // 放弃失败项但保留它已经产生的气泡（中止时留下的半截回复），继续后面的队列
    async function keepFailedAndContinue(chatId) {
        const q = _peek(chatId);
        if (!q || processing.has(chatId)) return false;
        const item = q.items.find(it => it.status === 'failed');
        if (!item) return false;
        q.items = q.items.filter(it => it !== item);
        q.pauseReason = null;
        _touch(chatId, true);
        await pump();
        return true;
    }

    // 清空队列：回滚所有已写入 chat.messages 的占位气泡，解除暂停
    async function clearQueue(chatId) {
        const q = _peek(chatId);
        if (!q) return true;
        if (processing.has(chatId)) { showToast('队列正在处理中，无法清空'); return false; }
        if (!q.items.length) {
            discardChat(chatId);
            return true;
        }
        const count = q.items.length;
        if (typeof showConfirm === 'function' && !(await showConfirm(`确定清空当前对话的 ${count} 条队列消息吗？`))) return false;
        if (processing.has(chatId)) { showToast('队列正在处理中，无法清空'); return false; }

        const chat = state.chats.find(c => c.id === chatId);
        if (chat) {
            const ids = new Set(q.items.map(it => it.id));
            chat.messages = chat.messages.filter(m => !(m._queueItemId && ids.has(m._queueItemId)));
            saveState();
            if (chat.id === state.currentChatId) renderMessages();
        }
        discardChat(chatId);
        showToast('队列已清空');
        return true;
    }

    // 旧版本把请求错误当作 assistant 消息写进历史，这些不是真实对话内容。
    // 新版本错误只存在队列项上，加载时清理一次避免污染后续请求的上下文。
    function purgeLegacyErrors() {
        let changed = false;
        for (const chat of state.chats) {
            if (!Array.isArray(chat.messages)) continue;
            const before = chat.messages.length;
            chat.messages = chat.messages.filter(m => !m.isError);
            if (chat.messages.length !== before) changed = true;
        }
        if (changed) {
            saveState();
            if (state.currentChatId) renderMessages();
        }
    }

    // 队列项与已落库消息对账：已完成（气泡后紧跟完整 assistant 回复）的残留项直接丢弃
    function _reconcileWithChat(chat, items) {
        const kept = [];
        for (const item of items) {
            const idx = chat.messages.findIndex(m => m._queueItemId === item.id);
            if (idx < 0) { kept.push(item); continue; }
            const next = chat.messages[idx + 1];
            if (next && next.role === 'assistant' && !next.aborted && !next.isError) continue;
            kept.push(item);
        }
        return kept;
    }

    // 从 IndexedDB 恢复，并迁移旧 localStorage 队列数据
    async function restore() {
        let states = [];
        try {
            states = await getQueueStates();
        } catch (e) {
            console.warn('Queue restore failed:', e);
        }

        for (const st of states) {
            if (!st || !st.chatId) continue;
            const chat = state.chats.find(c => c.id === st.chatId);
            if (!chat) {
                deleteQueueState(st.chatId).catch(() => {});
                continue;
            }
            const q = _queue(st.chatId);
            let items = (st.items || []).map(it => normalizeQueueItem(it, st.chatId)).filter(Boolean);

            // 旧版把失败项单独存进 failedItem：合并回队首，恢复"单一真相"
            if (st.failedItem) {
                const legacy = normalizeQueueItem(st.failedItem, st.chatId);
                if (legacy) {
                    legacy.status = 'failed';
                    legacy.error = legacy.error || { message: '上次发送失败', aborted: false };
                    const idx = items.findIndex(it => it.id === legacy.id);
                    if (idx >= 0) items[idx] = legacy; else items.unshift(legacy);
                }
            }

            q.items = _reconcileWithChat(chat, items);
            q.pauseReason = st.pauseReason || null;
            if (q.items.some(it => it.status === 'failed')) {
                q.pauseReason = q.pauseReason || 'failure';
            } else if (q.items.length) {
                // 刷新后不自动续跑：让用户显式点「继续队列」
                q.pauseReason = q.pauseReason || 'user';
            }
            if (!q.items.length && !q.pauseReason) {
                queues.delete(st.chatId);
                deleteQueueState(st.chatId).catch(() => {});
                continue;
            }
            q.version++;
        }

        try {
            const saved = JSON.parse(localStorage.getItem('ai_message_queue_v2') || 'null');
            if (saved && Array.isArray(saved.queue)) {
                const validChatIds = new Set(state.chats.map(chat => chat.id));
                for (const raw of saved.queue) {
                    const item = normalizeQueueItem(raw, state.currentChatId);
                    if (!item || !validChatIds.has(item.chatId)) continue;
                    const q = _queue(item.chatId);
                    if (!q.items.some(it => it.id === item.id)) q.items.push(item);
                    if (q.pauseReason === null) q.pauseReason = 'user';
                    q.version++;
                }
                if (saved.failedItem) {
                    const item = normalizeQueueItem(saved.failedItem, state.currentChatId);
                    if (item && validChatIds.has(item.chatId)) {
                        const q = _queue(item.chatId);
                        if (!q.items.some(it => it.id === item.id)) {
                            item.status = 'failed';
                            item.error = item.error || { message: '上次发送失败', aborted: false };
                            q.items.unshift(item);
                            q.pauseReason = q.pauseReason || 'failure';
                            q.version++;
                        }
                    }
                }
                localStorage.removeItem('ai_message_queue_v2');
                if (typeof showToast === 'function') showToast('已迁移旧版消息队列');
            }
        } catch (e) {
            console.warn('Legacy queue migration failed:', e);
        }

        for (const chatId of [...queues.keys()]) persist(chatId, true);
        emit();
    }

    return {
        getSnapshot, isPaused, isBusy, isAnyBusy, hasPending, activeChatId,
        onChange, markBusy, unmarkBusy,
        enqueue, remove, move, updateItem, purgeIds,
        pause, resume, resumeAndProcess, discardChat,
        pump, process: pump, retryFailed, keepFailedAndContinue, clearQueue, restore,
        purgeLegacyErrors, flushPersist
    };
})();

// 页面隐藏/卸载时把待写入的队列状态落库
if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => { try { QueueStore.flushPersist(); } catch (e) {} });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') { try { QueueStore.flushPersist(); } catch (e) {} }
    });
}

// ── 队列视图（DOM 渲染，依赖 QueueStore 快照） ──

let editingQueueItemId = null;

function toggleQueue() {
    document.getElementById('queuePanel').classList.toggle('collapsed');
}

function renderQueue() {
    const countEl = document.getElementById('queueCount');
    const listEl = document.getElementById('queueList');
    const panel = document.getElementById('queuePanel');
    const statusEl = document.getElementById('queueStatus');
    const clearBtn = document.getElementById('queueClearBtn');
    if (!countEl || !listEl || !panel) return;

    const chatId = state.currentChatId;
    const snap = chatId ? QueueStore.getSnapshot(chatId) : null;
    // 只有"一条正在发送"时不展开面板：那条消息本来就在对话里可见
    const showPanel = !!snap && (snap.paused || snap.items.length > 1 || (snap.items.length === 1 && !snap.sending));
    if (!showPanel) {
        countEl.textContent = snap ? snap.items.length : '0';
        panel.style.display = 'none';
        editingQueueItemId = null;
        return;
    }

    if (snap.busy) panel.classList.remove('collapsed');
    countEl.textContent = snap.items.length;
    panel.style.display = 'block';
    panel.classList.toggle('paused', snap.paused);

    if (statusEl) {
        statusEl.classList.toggle('sending', !snap.paused && snap.sending);
        if (snap.paused) {
            statusEl.textContent = snap.pauseReason === 'failure' ? '失败暂停' : '已暂停';
            statusEl.style.display = 'inline-flex';
        } else if (snap.sending) {
            statusEl.textContent = '发送中';
            statusEl.style.display = 'inline-flex';
        } else {
            statusEl.style.display = 'none';
        }
    }
    if (clearBtn) {
        clearBtn.style.display = snap.items.length ? 'inline-flex' : 'none';
        clearBtn.disabled = snap.busy;
    }

    if (editingQueueItemId && !snap.items.some(it => it.id === editingQueueItemId)) {
        editingQueueItemId = null;
    }
    if (!snap.items.length) {
        listEl.innerHTML = '<div class="queue-empty-hint">队列已清空。</div>';
        return;
    }

    const busy = snap.busy;
    const chat = state.chats.find(c => c.id === chatId);
    listEl.innerHTML = snap.items.map((item, i) => {
        const failed = item.status === 'failed';
        const sending = item.status === 'sending';
        const structureLocked = busy || failed;
        // 中止时已经落库的半截回复可以保留，此时允许"保留并继续"
        const canKeep = failed && !!chat && chat.messages.some(m => m.role === 'assistant' && m._queueItemId === item.id);

        if (item.id === editingQueueItemId) {
            const text = Array.isArray(item.content)
                ? (item.content.find(p => p && p.type === 'text')?.text || '')
                : (typeof item.content === 'string' ? item.content : '');
            return `<div class="queue-item-wrap">
                <div class="queue-item queue-item-editing">
                    <textarea id="queueEditArea" class="queue-edit-area" rows="3">${escapeHtml(text)}</textarea>
                    <div class="queue-edit-actions">
                        <button class="queue-item-btn primary" onclick="saveQueueEdit()">保存</button>
                        <button class="queue-item-btn" onclick="cancelQueueEdit()">取消</button>
                    </div>
                </div>
            </div>`;
        }

        const tags = [
            sending ? '<span class="queue-item-tag sending">发送中</span>' : '',
            failed ? '<span class="queue-item-tag failed">失败</span>' : '',
            item.trimmed ? '<span class="queue-item-tag">已裁剪</span>' : ''
        ].join('');

        const errorBlock = failed
            ? `<div class="queue-item-error">
                    <span class="queue-item-error-text">${escapeHtml(describeQueueError(item))}</span>
                    ${canKeep ? `<button class="queue-item-btn" onclick="keepQueueFailed()" ${busy ? 'disabled' : ''} title="保留已生成的部分回复，放弃这条队列消息并继续">保留回复</button>` : ''}
                    <button class="queue-item-btn primary" onclick="retryQueueFailed()" ${busy ? 'disabled' : ''}>重试</button>
               </div>`
            : '';

        return `<div class="queue-item-wrap${failed ? ' failed' : ''}${sending ? ' sending' : ''}">
            <div class="queue-item">
                <span class="queue-item-num">${i + 1}</span>
                <span class="queue-item-text">${escapeHtml(queueItemShortPreview(item))}${tags}</span>
                <button class="queue-item-btn" onclick="moveQueueItem('${escapeAttr(item.id)}', -1)" title="上移" ${structureLocked ? 'disabled' : ''}>↑</button>
                <button class="queue-item-btn" onclick="moveQueueItem('${escapeAttr(item.id)}', 1)" title="下移" ${structureLocked ? 'disabled' : ''}>↓</button>
                <button class="queue-item-btn" onclick="editQueueItem('${escapeAttr(item.id)}')" title="编辑" ${structureLocked ? 'disabled' : ''}>✎</button>
                <button class="queue-item-remove" onclick="removeQueueItem('${escapeAttr(item.id)}')" title="移除" ${busy ? 'disabled' : ''}>
                    <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                </button>
            </div>
            ${errorBlock}
        </div>`;
    }).join('');
}

function removeQueueItem(id) {
    const chatId = state.currentChatId;
    if (QueueStore.isBusy(chatId)) return showToast('队列正在处理中，无法移除');
    QueueStore.remove(chatId, id);
}

function moveQueueItem(id, delta) {
    const chatId = state.currentChatId;
    if (QueueStore.isBusy(chatId)) return showToast('队列正在处理中，无法调换');
    if (!QueueStore.move(chatId, id, delta)) showToast('失败的消息不能调整顺序，请先重试或移除');
}

function editQueueItem(id) {
    const chatId = state.currentChatId;
    if (QueueStore.isBusy(chatId)) return showToast('队列正在处理中，无法编辑');
    const snap = QueueStore.getSnapshot(chatId);
    const item = snap.items.find(it => it.id === id);
    if (item && item.status === 'failed') return showToast('失败的消息不能编辑，请先重试或移除');
    editingQueueItemId = id;
    renderQueue();
    const textarea = document.getElementById('queueEditArea');
    if (textarea) { textarea.focus(); textarea.select(); }
}

function saveQueueEdit() {
    const chatId = state.currentChatId;
    const id = editingQueueItemId;
    const textarea = document.getElementById('queueEditArea');
    if (!id || !textarea) return;
    const newText = textarea.value;
    const snap = QueueStore.getSnapshot(chatId);
    const item = snap.items.find(it => it.id === id);
    if (!item) return;
    let content;
    if (Array.isArray(item.content)) {
        content = item.content.map(part => part.type === 'text' ? { ...part, text: newText } : part);
    } else {
        content = newText;
    }
    QueueStore.updateItem(chatId, id, content);
    editingQueueItemId = null;
    renderQueue();
    showToast('队列消息已更新');
}

function cancelQueueEdit() {
    editingQueueItemId = null;
    renderQueue();
}

async function clearQueueClick() {
    const chatId = state.currentChatId;
    const ok = await QueueStore.clearQueue(chatId);
    if (ok) editingQueueItemId = null;
}

async function retryLastAndResume() {
    await QueueStore.retryFailed(state.currentChatId);
}

async function retryQueueFailed() {
    await QueueStore.retryFailed(state.currentChatId);
}

async function keepQueueFailed() {
    await QueueStore.keepFailedAndContinue(state.currentChatId);
}

function addToQueue() {
    const chatId = state.currentChatId;
    const text = DOM.userInput.value.trim();
    if (!text && !state.attachments.length) return showToast('请先输入消息或添加附件');
    const content = cloneMessageContent(buildMessageContent(text));
    QueueStore.enqueue(chatId, content);
    DOM.userInput.value = '';
    DOM.userInput.style.height = '52px';
    if (state.attachments.length) clearAttachments();
    renderQueue();
    updateTrimIndicator();
    showToast('已加入队列');
    if (!QueueStore.isBusy(chatId) && !QueueStore.isPaused(chatId)) QueueStore.pump();
}
