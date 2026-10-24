function getMaxAttachmentBytes() {
    const mb = Number.isFinite(state.maxAttachmentMB) && state.maxAttachmentMB > 0 ? state.maxAttachmentMB : 5;
    return mb * 1024 * 1024;
}

function isTextLikeFile(file) {
    if (file.type.startsWith('text/')) return true;
    const textExts = ['txt','md','markdown','json','js','mjs','cjs','ts','tsx','jsx','py','java','c','h','cpp','hpp','cc','cs','go','rs','rb','php','swift','kt','sql','sh','bash','zsh','yml','yaml','toml','ini','cfg','conf','xml','html','htm','css','scss','less','vue','svelte','csv','tsv','log','env','gitignore','dockerfile'];
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    return textExts.includes(ext);
}

function addFiles(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    const maxBytes = getMaxAttachmentBytes();
    const mb = state.maxAttachmentMB || 5;
    list.forEach((file) => {
        if (file.size > maxBytes) {
            showToast(`文件「${file.name}」超过 ${mb}MB，已跳过`);
            return;
        }
        if (file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = (e) => {
                state.attachments.push({ kind: 'image', name: file.name || 'image', data: e.target.result });
                renderAttachments(); updateTrimIndicator();
            };
            reader.readAsDataURL(file);
        } else if (isTextLikeFile(file)) {
            const reader = new FileReader();
            reader.onload = (e) => {
                const ext = (file.name.split('.').pop() || '').toLowerCase();
                state.attachments.push({ kind: 'file', name: file.name || 'file', ext, data: e.target.result });
                renderAttachments(); updateTrimIndicator();
            };
            reader.readAsText(file);
        } else {
            showToast(`不支持的文件类型「${file.name}」`);
        }
    });
}

function handleFileUpload(event) {
    addFiles(event.target.files);
    event.target.value = '';
}

const FILE_TILE_ICON = '<svg viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>';

function renderAttachments() {
    if (!DOM.attachmentPreview) return;
    if (!state.attachments.length) {
        DOM.attachmentPreview.innerHTML = '';
        DOM.attachmentPreview.style.display = 'none';
        return;
    }
    DOM.attachmentPreview.innerHTML = state.attachments.map((att, i) => {
        if (att.kind === 'image') {
            return `<div class="img-wrap"><img src="${att.data}" alt="${escapeHtml(att.name)}"><button class="remove-btn" onclick="removeAttachment(${i})" title="移除">×</button></div>`;
        }
        return `<div class="file-tile" title="${escapeHtml(att.name)}"><span class="file-tile-icon">${FILE_TILE_ICON}</span><span class="file-tile-name">${escapeHtml(att.name)}</span><button class="remove-btn" onclick="removeAttachment(${i})" title="移除">×</button></div>`;
    }).join('');
    DOM.attachmentPreview.style.display = 'flex';
}

function removeAttachment(index) {
    state.attachments.splice(index, 1);
    renderAttachments();
    updateTrimIndicator();
}

function clearAttachments() {
    state.attachments = [];
    renderAttachments();
    updateTrimIndicator();
}

// 将当前文字与附件构建为消息 content。无附件时返回纯文本字符串。
function buildMessageContent(text) {
    if (!state.attachments.length) return text;
    const parts = [];
    const fileParts = state.attachments.filter(a => a.kind === 'file');
    const imageParts = state.attachments.filter(a => a.kind === 'image');
    let textBlock = text || '';
    fileParts.forEach((f) => {
        textBlock += (textBlock ? '\n\n' : '') + `文件: ${f.name}\n\`\`\`${f.ext || ''}\n${f.data}\n\`\`\``;
    });
    if (!textBlock && imageParts.length) textBlock = '分析这张图片';
    parts.push({ type: 'text', text: textBlock });
    imageParts.forEach((img) => {
        parts.push({ type: 'image_url', image_url: { url: img.data } });
    });
    return parts;
}

function createNewChat(render = true) {
    if (render) closeSettings();
    const newChat = { id: Date.now().toString(), title: "新对话", messages: [], maxTokens: 0, contextLimit: 131072, contextLimitWarned: false, temperature: 0.7, stream: true, systemPrompt: '', userPrefix: '', selectedPreset: 'custom' };
    state.chats.unshift(newChat); state.currentChatId = newChat.id; state.editingIndex = -1; saveState();
    if (render) { renderChatList(); renderMessages(); updateTrimIndicator(); updatePrefixBadge(); DOM.userInput.focus(); renderQueue(); updateSendButton(false); }
}

function applySwitchChat(id) {
    state.currentChatId = id; state.editingIndex = -1; setVisibleCount(id, MESSAGE_PAGE_SIZE); autoScroll = true; saveState(); renderChatList(); renderMessages(); updateTrimIndicator(); updatePrefixBadge(); closeSettings(); closeSidebar(); clearSearch(); renderQueue(); updateSendButton(false);
}

let _switchChatToken = 0;
function switchChat(id) {
    if (id === state.currentChatId) return;
    const el = DOM.chatMessages;
    const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const hasContent = el && el.querySelector(':scope > .message-wrapper');
    if (prefersReduced || !el || !hasContent) {
        applySwitchChat(id);
        return;
    }
    const token = ++_switchChatToken;
    el.classList.add('switching-out');
    setTimeout(() => {
        if (token !== _switchChatToken) return;
        el.classList.remove('switching-out');
        applySwitchChat(id);
    }, 100);
}

async function deleteChat(id, event) {
    event.stopPropagation();
    if (QueueStore.isAnyBusy() || abortController) return showToast("请等待当前请求完成");
    if (!(await showConfirm("确定要永久删除这个对话吗？"))) return;
    if (QueueStore.isAnyBusy() || abortController) return showToast("请等待当前请求完成");
    state.chats = state.chats.filter(c => c.id !== id);
    if(state.currentChatId === id) state.currentChatId = state.chats.length ? state.chats[0].id : null;
    if(state.chats.length === 0) createNewChat(false);
    QueueStore.discardChat(id);
    saveState(); renderChatList(); renderMessages(); renderQueue(); updateSendButton(false);
}

async function clearCurrentChat() {
    if (QueueStore.isAnyBusy() || abortController) return showToast("请等待当前请求完成");
    if (!(await showConfirm("确定清空当前对话的所有消息吗？此操作无法撤销。"))) return;
    if (QueueStore.isAnyBusy() || abortController) return showToast("请等待当前请求完成");
    const chat = state.chats.find(c => c.id === state.currentChatId);
    if(chat) { chat.messages = []; state.editingIndex = -1; saveState(); QueueStore.discardChat(chat.id); renderMessages(); renderQueue(); updateTrimIndicator(); showToast("对话已清空"); }
}

function renderChatList() {
    DOM.chatList.innerHTML = '';
    state.chats.forEach(chat => {
        const div = document.createElement('div');
        div.className = `chat-item ${chat.id === state.currentChatId ? 'active' : ''}`;
        div.textContent = chat.title; div.title = chat.title;
        div.onclick = () => switchChat(chat.id);
        div.oncontextmenu = (e) => showContextMenu(e, chat.id);

        const delBtn = document.createElement('button');
        delBtn.className = 'delete-chat-btn'; delBtn.title = "删除对话";
        delBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
        delBtn.onclick = (e) => deleteChat(chat.id, e);
        div.appendChild(delBtn);
        DOM.chatList.appendChild(div);
    });
}

function copyMessage(index) {
    const chat = state.chats.find(c => c.id === state.currentChatId);
    let content = chat.messages[index].content;
    if(Array.isArray(content)) content = content.find(c=>c.type==='text')?.text || '';
    navigator.clipboard.writeText(content).then(() => showToast("已复制到剪贴板"));
}

async function deleteMessage(index) {
    if (QueueStore.isAnyBusy() || abortController) return showToast("请等待当前请求完成");
    if (!(await showConfirm("确定删除此条消息吗？"))) return;
    if (QueueStore.isAnyBusy() || abortController) return showToast("请等待当前请求完成");
    const chat = state.chats.find(c => c.id === state.currentChatId);
    chat.messages.splice(index, 1); saveState(); renderMessages(); updateTrimIndicator();
}

function startEdit(index) { state.editingIndex = index; renderMessages(); }
function cancelEdit() { state.editingIndex = -1; renderMessages(); }
function saveEdit(index, newText) {
    if (QueueStore.isAnyBusy() || abortController) return showToast("请等待当前请求完成");
    const chat = state.chats.find(c => c.id === state.currentChatId);
    if (Array.isArray(chat.messages[index].content)) {
        let textPart = chat.messages[index].content.find(c => c.type === 'text');
        if(textPart) textPart.text = newText;
    } else { chat.messages[index].content = newText; }
    chat.messages[index]._renderVersion = (chat.messages[index]._renderVersion || 0) + 1;
    state.editingIndex = -1; saveState(); renderMessages(); updateTrimIndicator(); showToast("修改已保存");
}

// 根据消息索引定位其对应的气泡 DOM（考虑被折叠的历史消息）
function getWrapperForIndex(index) {
    const chat = state.chats.find(c => c.id === state.currentChatId);
    if (!chat) return null;
    const msgs = chat.messages.filter(m => m.role !== 'system');
    const visibleCount = Math.min(getVisibleCount(state.currentChatId), msgs.length);
    const startIdx = Math.max(0, msgs.length - visibleCount);
    const pos = index - startIdx;
    if (pos < 0) return null;
    const wrappers = DOM.chatMessages.querySelectorAll(':scope > .message-wrapper');
    return wrappers[pos] || null;
}

function cloneMessageContent(content) {
    if (typeof content === 'string') return content;
    return JSON.parse(JSON.stringify(content));
}

// 截断 chat.messages 并将 fromIndex 起（含/不含自身）的 user 消息重放入队。
// includeSelf=true：从 fromIndex 截断并重放自身（user 消息重试）；
// includeSelf=false：保留 fromIndex 条消息（assistant 重试），仅重放其后 user 消息。
// 返回重放入队的条数。
function enqueueReplayFrom(chat, fromIndex, includeSelf) {
    const keepEnd = includeSelf ? fromIndex : fromIndex + 1;
    // 被截断删除的消息若对应队列项（失败项等），一并清理，避免旧内容重复发送
    const removedIds = new Set(
        chat.messages.slice(keepEnd).map(m => m._queueItemId).filter(Boolean)
    );
    const replayContents = chat.messages
        .slice(keepEnd)
        .filter(m => m.role === 'user')
        .map(m => cloneMessageContent(m.content));
    if (!replayContents.length) return 0;
    state.editingIndex = -1;
    chat.messages = chat.messages.slice(0, keepEnd);
    QueueStore.purgeIds(chat.id, removedIds);
    for (let i = replayContents.length - 1; i >= 0; i--) {
        QueueStore.enqueue(chat.id, replayContents[i], { front: true });
    }
    if (QueueStore.isPaused(chat.id)) QueueStore.resume(chat.id);
    saveState();
    renderMessages();
    return replayContents.length;
}

// 串行重试改造为「全部入队」：从指定 index 起截断消息，把剩余 user 消息按原顺序
// 推入队列前方，交由 QueueStore.pump 统一处理。失败时由队列暂停机制
// （retryLastAndResume / clearQueue）接管。
async function retryUserMessagesFrom(chat, index) {
    if (QueueStore.isPaused(chat.id)) return showToast("请先处理当前暂停消息");
    if (QueueStore.isAnyBusy() || abortController) return showToast("请等待当前请求完成");

    const replayCount = chat.messages.slice(index).filter(m => m.role === 'user').length;
    if (!replayCount) return;

    if (index < chat.messages.length - 1) {
        const confirmMsg = `重试将从此用户消息开始，删除后续消息，并把 ${replayCount} 条用户消息按原顺序插入队列最前方，确定吗？`;
        if (!(await showConfirm(confirmMsg))) return;
        if (QueueStore.isPaused(chat.id)) return showToast("请先处理当前暂停消息");
        if (QueueStore.isAnyBusy() || abortController) return showToast("请等待当前请求完成");
    }

    const n = enqueueReplayFrom(chat, index, true);
    renderQueue();
    showToast(n > 1 ? `已加入队列 ${n} 条，开始重放` : '开始重试用户消息');
    updateSendButton(false);
    QueueStore.pump();
}

// 就地重生成（不走队列）：必须等全局请求空闲，避免与队列抢 abortController
async function runChatRequestIdle(chat, preparedMessages, options = {}) {
    for (let attempt = 0; attempt < 10; attempt++) {
        await whenRequestIdle();
        const result = await executeChatRequest(chat, preparedMessages, options);
        if (!result || !result.busy) return result;
        await new Promise(r => setTimeout(r, 300));
    }
    showToast('当前有请求正在处理，请稍后再试');
    return { ok: false, busy: true, skipped: true, aborted: false, failed: false, error: null };
}

// 工具栏「重试」：询问用户是否将该消息之后的所有 user 消息按原顺序加入队列重放。
//   - user 消息：截断到该消息（含）之前 + 把该消息及其后的所有 user 消息入队
//   - assistant 消息：保留该 assistant 消息 + 截断其后所有消息 + 把其后所有
//     user 消息入队；无后续 user 消息时退化为就地重生成。
async function retryAssistantMessage(chat, index) {
    if (QueueStore.isPaused(chat.id)) return showToast("请先处理当前暂停消息");
    if (QueueStore.isAnyBusy() || abortController) return showToast("请等待当前请求完成");
    const msg = chat.messages[index];
    if (!msg) return;

    const replayContents = chat.messages
        .slice(index + 1)
        .filter(m => m.role === 'user')
        .map(m => cloneMessageContent(m.content));

    const confirmMsg = replayContents.length > 0
        ? `是否将此条消息之后的 ${replayContents.length} 条用户消息插入队列最前方重放？`
        : '此条消息之后没有可重放的用户消息，是否仍重新生成该 assistant 回复？';

    if (!(await showConfirm(confirmMsg))) return;
    if (QueueStore.isPaused(chat.id)) return showToast("请先处理当前暂停消息");
    if (QueueStore.isAnyBusy() || abortController) return showToast("请等待当前请求完成");

    if (replayContents.length === 0) {
        // 退化路径：没有后续 user 消息，就只重生成这一条 assistant（就地复用气泡）
        const backup = chat.messages.map(m => ({ ...m, content: cloneMessageContent(m.content) }));
        QueueStore.markBusy(chat.id);
        updateSendButton(false);
        try {
            // 先等全局空闲再动消息，避免"已截断却在等别的会话"的中间态
            await whenRequestIdle();
            let reuseWrapper = null;
            const w = getWrapperForIndex(index);
            if (w && w.classList.contains('bot') && w.isConnected) reuseWrapper = w;
            chat.messages = chat.messages.slice(0, index);
            state.editingIndex = -1;
            saveState();
            if (reuseWrapper) {
                let sibling = reuseWrapper.nextElementSibling;
                while (sibling) {
                    const toRemove = sibling;
                    sibling = sibling.nextElementSibling;
                    if (toRemove.classList.contains('message-wrapper')) toRemove.remove();
                }
                reuseWrapper.classList.remove('bubble-reenter');
                reuseWrapper.classList.add('bubble-resetting');
                await new Promise(resolve => {
                    let done = false;
                    const onEnd = () => {
                        if (done) return;
                        done = true;
                        reuseWrapper.removeEventListener('animationend', onEnd);
                        resolve();
                    };
                    reuseWrapper.addEventListener('animationend', onEnd);
                    setTimeout(onEnd, 400);
                });
                const result = await runChatRequestIdle(chat, null, { reuseWrapper });
                if (!result || !result.ok) {
                    chat.messages = backup;
                    saveState();
                    if (chat.id === state.currentChatId) renderMessages();
                }
                return result;
            }
            renderMessages();
            const result = await runChatRequestIdle(chat);
            if (!result || !result.ok) {
                chat.messages = backup;
                saveState();
                if (chat.id === state.currentChatId) renderMessages();
            }
            return result;
        } catch (error) {
            chat.messages = backup;
            saveState();
            if (chat.id === state.currentChatId) renderMessages();
            return { ok: false, aborted: false, failed: true, error };
        } finally {
            QueueStore.unmarkBusy(chat.id);
            updateSendButton(false);
        }
    }

    const n = enqueueReplayFrom(chat, index, false);
    renderQueue();
    showToast(`已加入队列 ${n} 条，开始重放`);
    updateSendButton(false);
    QueueStore.pump();
}

// 单条消息重试：统一走队列重放。user 消息截断到自身并连同其后 user 消息入队；
// assistant 消息保留自身并重放其后 user 消息；无后续 user 消息时退化为就地重生成。
async function retryMessage(index) {
    const chat = state.chats.find(c => c.id === state.currentChatId);
    if (!chat) return;
    if (QueueStore.isPaused(chat.id)) return showToast("请先处理当前暂停消息");
    if (QueueStore.isAnyBusy() || abortController) return showToast("请等待当前请求完成");
    const msg = chat.messages[index];
    if (!msg) return;

    if (msg.role === 'user') {
        if (index < chat.messages.length - 1) {
            const n = chat.messages.slice(index).filter(m => m.role === 'user').length;
            if (!(await showConfirm(`重试将从此用户消息开始，删除后续消息，并把 ${n} 条用户消息按原顺序插入队列最前方，确定吗？`))) return;
            if (QueueStore.isPaused(chat.id)) return showToast("请先处理当前暂停消息");
            if (QueueStore.isAnyBusy() || abortController) return showToast("请等待当前请求完成");
        }
        const n = enqueueReplayFrom(chat, index, true);
        renderQueue();
        showToast(n > 1 ? `已加入队列 ${n} 条，开始重放` : '开始重试用户消息');
        updateSendButton(false);
        QueueStore.pump();
        return;
    }

    const followCount = chat.messages.slice(index + 1).filter(m => m.role === 'user').length;
    if (followCount > 0) {
        if (!(await showConfirm(`是否将此条消息之后的 ${followCount} 条用户消息插入队列最前方重放？`))) return;
        if (QueueStore.isPaused(chat.id)) return showToast("请先处理当前暂停消息");
        if (QueueStore.isAnyBusy() || abortController) return showToast("请等待当前请求完成");
        const n = enqueueReplayFrom(chat, index, false);
        renderQueue();
        showToast(`已加入队列 ${n} 条，开始重放`);
        updateSendButton(false);
        QueueStore.pump();
        return;
    }

    // 无后续 user 消息：就地重生成该 assistant（复用气泡）
    const backup = chat.messages.map(m => ({ ...m, content: cloneMessageContent(m.content) }));
    QueueStore.markBusy(chat.id);
    updateSendButton(false);
    try {
        await whenRequestIdle();
        state.editingIndex = -1;
        const reuseWrapper = getWrapperForIndex(index);
        chat.messages = chat.messages.slice(0, index);
        saveState();
        if (!reuseWrapper || !reuseWrapper.isConnected) renderMessages();
        showToast("正在重试...");
        const result = await runChatRequestIdle(chat, null, { reuseWrapper: reuseWrapper && reuseWrapper.isConnected ? reuseWrapper : undefined });
        if (!result.ok) {
            chat.messages = backup;
            saveState();
            if (chat.id === state.currentChatId) renderMessages();
        }
        return result;
    } catch (error) {
        chat.messages = backup;
        saveState();
        if (chat.id === state.currentChatId) renderMessages();
        return { ok: false, aborted: false, failed: true, error };
    } finally {
        QueueStore.unmarkBusy(chat.id);
        updateSendButton(false);
    }
}

async function retryChatSerialFromStart(chat) {
    if (QueueStore.isAnyBusy() || abortController) return showToast("请等待当前请求完成");
    if (!chat) return showToast("未找到对话");
    if (QueueStore.isPaused(chat.id)) return showToast("请先处理当前暂停消息");
    if (!state.apiKey || !state.selectedModel) return showToast("请先配置 API Key 和模型");

    const firstUserIndex = chat.messages.findIndex(m => m.role === 'user');
    if (firstUserIndex < 0) return showToast("当前对话没有可重试的用户消息");

    await retryUserMessagesFrom(chat, firstUserIndex);
}

async function retryCurrentChatSerialFromStart() {
    const chat = state.chats.find(c => c.id === state.currentChatId);
    await retryChatSerialFromStart(chat);
}

async function retryContextMenuChatSerialFromStart() {
    if (DOM.contextMenu) DOM.contextMenu.style.display = 'none';
    const chatId = contextMenuChatId || state.currentChatId;
    const chat = state.chats.find(c => c.id === chatId);
    if (chat && chat.id !== state.currentChatId) {
        applySwitchChat(chat.id);
    }
    await retryChatSerialFromStart(chat);
}

async function translateAssistantEnglishTokens(index, options = {}) {
    const silent = !!options.silent;
    const chat = options.chat || state.chats.find(c => c.id === state.currentChatId);
    if (!chat) return false;
    const msg = chat.messages[index];
    if (!msg || msg.role !== 'assistant') return false;
    if (!state.apiKey || !state.selectedModel) {
        if (!silent) showToast("请先配置 API Key 和模型");
        return false;
    }

    const plainText = getMessagePlainText(msg);
    const tokens = extractEnglishTokens(plainText);
    if (!tokens.length) {
        if (!silent) showToast("未发现需要翻译的英文片段");
        return false;
    }

    if (!silent) showToast(`正在翻译 ${tokens.length} 处英文...`);
    const modelToUse = state.selectedModel;
    try {
        const prompt = `你是中英翻译。下面是从一段中文回复中抽取的、混入的错误英文片段（可能是单词、词组或短句）。请将每个英文片段翻译成最贴合中文上下文的简短译文。仅返回 JSON 对象，键为英文片段（保持原样、原大小写、原内部空格），值为对应中文翻译。不要添加多余解释。\n\n英文片段列表：\n${JSON.stringify(tokens)}`;
        const response = await fetch(`${API_BASE}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.apiKey}` },
            body: JSON.stringify({
                model: modelToUse,
                messages: [{ role: 'user', content: prompt }],
                stream: false,
                temperature: 0.2,
                response_format: { type: 'json_object' }
            })
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        let text = data.choices?.[0]?.message?.content?.trim() || '';
        text = text.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) text = jsonMatch[0];
        let map;
        try { map = JSON.parse(text); } catch (e) { throw new Error('翻译结果解析失败'); }
        if (!map || typeof map !== 'object') throw new Error('翻译结果格式错误');
        if (!state.chats.includes(chat) || chat.messages[index] !== msg) return false;

        let original = msg.content;
        if (Array.isArray(original)) {
            const part = original.find(c => c.type === 'text');
            if (part) part.text = applyTranslationMap(part.text || '', map);
        } else if (typeof original === 'string') {
            msg.content = applyTranslationMap(original, map);
        }
        msg.translated = true;
        msg._renderVersion = (msg._renderVersion || 0) + 1;
        saveState();
        if (chat.id === state.currentChatId) renderMessages();
        const replaced = Object.keys(map).filter(k => map[k]).length;
        if (!silent) showToast(`已替换 ${replaced} 处英文`);
        else if (replaced > 0) showToast(`自动修复：替换 ${replaced} 处英文`);
        return true;
    } catch (error) {
        if (!silent) showToast("翻译失败：" + (error.message || ''));
        return false;
    }
}

async function polishAssistantMessage(index, options = {}) {
    const silent = !!options.silent;
    const chat = options.chat || state.chats.find(c => c.id === state.currentChatId);
    if (!chat) return false;
    const msg = chat.messages[index];
    if (!msg || msg.role !== 'assistant') return false;
    if (!state.apiKey) {
        if (!silent) showToast("请先配置 API Key");
        return false;
    }

    const modelToUse = state.polishModel || state.selectedModel;
    if (!modelToUse) {
        if (!silent) showToast("请先配置润色模型");
        return false;
    }

    const plainText = getMessagePlainText(msg);
    if (!plainText || plainText.trim().length < 10) {
        if (!silent) showToast("消息内容过短，无需润色");
        return false;
    }

    if (!silent) showToast(`润色「${chat.title || '新对话'}」...`);
    try {
        const prompt = `你是一个文本润色助手。请润色以下文本，使其表达更流畅、更自然、更专业。保持原意不变，不要添加额外信息。只返回润色后的完整文本，不要任何解释。\n\n原始文本：\n${plainText}`;
        const body = {
            model: modelToUse,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            temperature: 0.3
        };
        if (chat.maxTokens) body.max_tokens = chat.maxTokens;
        const response = await fetch(`${API_BASE}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.apiKey}` },
            body: JSON.stringify(body)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        let polished = data.choices?.[0]?.message?.content?.trim() || '';
        if (!polished) throw new Error('润色结果为空');
        if (!state.chats.includes(chat) || chat.messages[index] !== msg) return false;

        // 如果差异太小（比如模型直接返回原文本），跳过替换
        if (polished === plainText) {
            msg.polished = true;
            msg._renderVersion = (msg._renderVersion || 0) + 1;
            saveState();
            if (chat.id === state.currentChatId) renderMessages();
            if (!silent) showToast(`「${chat.title || '新对话'}」润色完成（文本无需改动）`);
            return true;
        }

        // Backup original content before replacing
        if (!msg._prePolishContent) {
            msg._prePolishContent = JSON.parse(JSON.stringify(msg.content));
        }

        // Replace entire message content
        if (typeof msg.content === 'string') {
            msg.content = polished;
        } else if (Array.isArray(msg.content)) {
            const part = msg.content.find(c => c.type === 'text');
            if (part) part.text = polished;
        }
        msg.polished = true;
        msg._renderVersion = (msg._renderVersion || 0) + 1;
        saveState();
        if (chat.id === state.currentChatId) renderMessages();
        if (!silent) showToast(`「${chat.title || '新对话'}」润色完成`);
        return true;
    } catch (error) {
        if (!silent) showToast("润色失败：" + (error.message || ''));
        return false;
    }
}

function undoPolishMessage(index) {
    const chat = state.chats.find(c => c.id === state.currentChatId);
    if (!chat) return;
    const msg = chat.messages[index];
    if (!msg || !msg._prePolishContent) { showToast("没有可撤销的润色记录"); return; }

    msg.content = JSON.parse(JSON.stringify(msg._prePolishContent));
    delete msg._prePolishContent;
    msg.polished = false;
    msg._renderVersion = (msg._renderVersion || 0) + 1;
    saveState();
    renderMessages();
    showToast("已撤销润色");
}

async function autoPolishLastAssistantMessage(chat) {
    if (!chat || !chat.autoPolish) return;
    const lastIdx = chat.messages.length - 1;
    if (lastIdx < 0) return;
    const msg = chat.messages[lastIdx];
    if (!msg || msg.role !== 'assistant') return;
    if (msg.polished) return;
    const plain = getMessagePlainText(msg);
    if (!plain || plain.trim().length < 10) return;
    await polishAssistantMessage(lastIdx, { silent: true, chat });
}

async function polishAllAssistantMessages() {
    DOM.contextMenu.style.display = 'none';
    const chat = state.chats.find(c => c.id === (contextMenuChatId || state.currentChatId));
    if (!chat) return;
    if (!state.apiKey) { showToast("请先配置 API Key"); return; }
    if (!(state.polishModel || state.selectedModel)) { showToast("请先配置润色模型"); return; }

    const assistantIndices = [];
    chat.messages.forEach((m, i) => {
        if (m.role === 'assistant' && !m.polished) assistantIndices.push(i);
    });
    if (assistantIndices.length === 0) {
        showToast("没有需要润色的消息");
        return;
    }

    showToast(`「${chat.title || '新对话'}」开始润色 ${assistantIndices.length} 条消息...`);
    let done = 0;
    for (const idx of assistantIndices) {
        const polished = await polishAssistantMessage(idx, { silent: true, chat });
        if (polished) done++;
    }
    showToast(`「${chat.title || '新对话'}」润色完成：${done} 条消息`);
}

async function autoFixLastAssistantMessage(chat) {
    if (!chat || !chat.autoFixEnglish) return;
    const lastIdx = chat.messages.length - 1;
    if (lastIdx < 0) return;
    const msg = chat.messages[lastIdx];
    if (!msg || msg.role !== 'assistant') return;
    const plain = getMessagePlainText(msg);
    if (!plain) return;
    if (calcChineseRatio(plain) < 0.85) return;
    if (extractEnglishTokens(plain).length === 0) return;
    await translateAssistantEnglishTokens(lastIdx, { silent: true, chat });
}

function assistantNeedsTranslation(msg) {
    if (!msg || msg.role !== 'assistant') return false;
    const plain = getMessagePlainText(msg);
    if (!plain) return false;
    if (calcChineseRatio(plain) < 0.85) return false;
    return extractEnglishTokens(plain).length > 0;
}

async function ensureAutoChecksBeforeSend(chat) {
    if (!chat) return;
    if (!chat.autoFixEnglish && !chat.autoRetryOnRefuse && !chat.autoPolish) return;
    let lastIdx = -1;
    for (let i = chat.messages.length - 1; i >= 0; i--) {
        if (chat.messages[i].role === 'assistant') { lastIdx = i; break; }
    }
    if (lastIdx < 0) return;
    const msg = chat.messages[lastIdx];
    if (!msg) return;

    if (chat.autoFixEnglish && msg.translated !== true && assistantNeedsTranslation(msg)) {
        try { await translateAssistantEnglishTokens(lastIdx, { silent: true, chat }); } catch (e) {}
    }

    if (chat.autoRetryOnRefuse && msg.refuseChecked !== true) {
        if (typeof detectRefuse === 'function') {
            try {
                const refused = await detectRefuse(msg);
                if (refused === false) {
                    msg.refuseChecked = true;
                    msg._renderVersion = (msg._renderVersion || 0) + 1;
                    saveState();
                    if (chat.id === state.currentChatId) renderMessages();
                }
            } catch (e) {}
        }
    }

    if (chat.autoPolish && msg.polished !== true) {
        try { await polishAssistantMessage(lastIdx, { silent: true, chat }); } catch (e) {}
    }
}

function showMessageContextMenu(event, index) {
    event.preventDefault();
    event.stopPropagation();
    const chat = state.chats.find(c => c.id === state.currentChatId);
    if (!chat) return;
    const msg = chat.messages[index];
    if (!msg) return;

    const items = [
        { label: '复制', icon: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>', onClick: () => copyMessage(index) },
        { label: '修改', icon: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>', onClick: () => startEdit(index) },
        { label: '重试', icon: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>', onClick: () => retryMessage(index) },
        { label: '删除', icon: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>', onClick: () => deleteMessage(index) }
    ];

    if (msg.role === 'assistant') {
        const plain = getMessagePlainText(msg);
        if (plain && calcChineseRatio(plain) >= 0.85 && extractEnglishTokens(plain).length > 0) {
            items.push({ divider: true });
            items.push({
                label: '翻译错误英文',
                icon: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/></svg>',
                onClick: () => translateAssistantEnglishTokens(index)
            });
        }
    }

    const menu = Components.createContextMenu({ items, ariaLabel: '消息操作菜单' });
    menu.show(event.pageX, event.pageY);
}

function createMessageDOM(msg, index, isNew = false) {
    const wrapper = document.createElement('div');
    wrapper.className = `message-wrapper ${msg.role === 'user' ? 'user' : 'bot'}`;
    if (isNew) wrapper.classList.add('animate-enter');
    wrapper.addEventListener('contextmenu', (e) => {
        if (e.target.closest('a, button, input, textarea, select, pre code')) return;
        if (index === state.editingIndex) return;
        showMessageContextMenu(e, index);
    });

    if (index === state.editingIndex) {
        let textValue = msg.content;
        if(Array.isArray(textValue)) textValue = textValue.find(c=>c.type==='text')?.text || '';
        const editArea = document.createElement('textarea');
        editArea.className = 'edit-area'; editArea.value = textValue;
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'edit-actions';
        actionsDiv.innerHTML = `<button class="btn-outline" style="width: auto; padding: 8px 16px;" onclick="cancelEdit()">取消</button><button class="new-chat-btn" style="margin-bottom:0; padding:8px 16px;" onclick="saveEdit(${index}, this.parentElement.previousElementSibling.value)">保存</button>`;
        wrapper.appendChild(editArea); wrapper.appendChild(actionsDiv);
        return { wrapper, contentNode: editArea };
    }

    const contentNode = document.createElement('div');
    contentNode.className = `message ${msg.role === 'user' ? 'user' : 'bot'} markdown-body`;

    let displayContent = msg.content;
    if (Array.isArray(msg.content)) {
        const textPart = msg.content.find(c => c.type === 'text')?.text || '';
        const imgParts = msg.content.filter(c => c.type === 'image_url').map(c => c.image_url?.url).filter(Boolean);
        const imgMarkdown = imgParts.map(url => `![上传图片](${url})`).join('\n');
        displayContent = imgMarkdown ? `${imgMarkdown}\n\n${textPart}` : textPart;
    }

    if (displayContent && THINK_TAG_PATTERN.test(displayContent)) {
        contentNode.innerHTML = renderContentWithThink(displayContent, false);
        if (shouldProcessMath(displayContent)) renderMath(contentNode);
        highlightCodeBlocks(contentNode);
    } else {
        renderMarkdownIntoElement(contentNode, displayContent);
    }
    wrapper.appendChild(contentNode);

    const actions = document.createElement('div');
    actions.className = 'message-actions';
    actions.innerHTML = `
        <button class="action-icon" onclick="copyMessage(${index})" title="复制"><svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg></button>
        <button class="action-icon" onclick="startEdit(${index})" title="编辑"><svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg></button>
        <button class="action-icon" onclick="retryMessage(${index})" title="重试"><svg viewBox="0 0 24 24"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg></button>
        <button class="action-icon" onclick="deleteMessage(${index})" title="删除"><svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>
    `;
    if (msg.role === 'assistant') {
        const spacer = document.createElement('span');
        spacer.className = 'action-spacer';
        actions.appendChild(spacer);

        if (state.ttsEnabled) {
            const ttsBtn = document.createElement('button');
            ttsBtn.className = 'action-icon status-icon status-tts';
            const syncTtsBtn = () => {
                const speaking = typeof TTS !== 'undefined' && TTS.isSpeaking(index);
                ttsBtn.classList.toggle('speaking', speaking);
                ttsBtn.title = speaking ? '停止朗读' : '朗读';
                ttsBtn.innerHTML = speaking
                    ? '<svg viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>'
                    : '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>';
            };
            syncTtsBtn();
            if (typeof TTS !== 'undefined') {
                const unsub = TTS.onStateChange(() => {
                    if (!ttsBtn.isConnected) { unsub(); return; }
                    syncTtsBtn();
                });
            }
            ttsBtn.onclick = () => {
                if (typeof TTS === 'undefined') return;
                TTS.toggle(index, getMessagePlainText(msg), { voice: state.ttsVoice });
            };
            actions.appendChild(ttsBtn);
        }

        const needsTrans = assistantNeedsTranslation(msg);
        const isTranslated = msg.translated === true;
        const hasAnyEng = extractEnglishTokens(getMessagePlainText(msg)).length > 0;
        const transBtn = document.createElement('button');
        transBtn.className = 'action-icon status-icon status-translate';
        if (isTranslated) transBtn.classList.add('translated');
        if (!hasAnyEng && !isTranslated) transBtn.classList.add('no-need');
        transBtn.title = isTranslated ? '已翻译（点击重新翻译）' : (hasAnyEng ? '点击翻译错误英文' : '无需翻译');
        if (isTranslated) {
            transBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
        } else {
            transBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/></svg>';
        }
        transBtn.onclick = () => translateAssistantEnglishTokens(index);
        actions.appendChild(transBtn);

        const isPolished = msg.polished === true;
        const hasBackup = !!msg._prePolishContent;
        const polishBtn = document.createElement('button');
        polishBtn.className = 'action-icon status-icon status-polish';
        if (isPolished) polishBtn.classList.add('polished');
        polishBtn.title = isPolished ? '已润色（点击重新润色）' : '点击润色文本';
        if (isPolished) {
            polishBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
        } else {
            polishBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5z"/></svg>';
        }
        polishBtn.onclick = () => polishAssistantMessage(index);
        actions.appendChild(polishBtn);

        if (isPolished && hasBackup) {
            const undoBtn = document.createElement('button');
            undoBtn.className = 'action-icon status-icon status-undo-polish';
            undoBtn.title = '撤销润色';
            undoBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/></svg>';
            undoBtn.onclick = () => undoPolishMessage(index);
            actions.appendChild(undoBtn);
        }

        const refuseBtn = document.createElement('button');
        refuseBtn.className = 'action-icon status-icon status-refuse-check read-only';
        const checked = msg.refuseChecked === true;
        refuseBtn.classList.add(checked ? 'checked' : 'unchecked');
        refuseBtn.title = checked ? '拒绝重试检测：通过' : '拒绝重试检测：未检测/未通过';
        refuseBtn.innerHTML = checked
            ? '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>'
            : '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
        refuseBtn.onclick = (e) => e.preventDefault();
        actions.appendChild(refuseBtn);
    }
    wrapper.appendChild(actions);
    if (isNew) {
        requestAnimationFrame(() => {
            if (typeof TextAnim !== 'undefined') {
                TextAnim.staggerRevealChildren(contentNode, { variant: 'slideUp', staggerMs: 40, duration: 400, delay: 160 });
            }
        });
    }
    return { wrapper, contentNode };
}

let _lastRenderMsgCount = 0;
let _lastRenderEditIdx = -1;
let _lastRenderChatId = null;

const MESSAGE_PAGE_SIZE = 50;
const MESSAGE_PAGE_STEP = 50;
const _visibleCounts = new Map();

function getVisibleCount(chatId) {
    return _visibleCounts.get(chatId) || MESSAGE_PAGE_SIZE;
}

function setVisibleCount(chatId, count) {
    _visibleCounts.set(chatId, count);
}

function loadMoreHistory() {
    const chatId = state.currentChatId;
    const chat = state.chats.find(c => c.id === chatId);
    if (!chat) return;
    const total = chat.messages.filter(m => m.role !== 'system').length;
    const cur = getVisibleCount(chatId);
    setVisibleCount(chatId, Math.min(total, cur + MESSAGE_PAGE_STEP));

    const el = DOM.chatMessages;
    const prevHeight = el.scrollHeight;
    const prevTop = el.scrollTop;
    renderMessages();
    requestAnimationFrame(() => {
        const newHeight = el.scrollHeight;
        el.scrollTop = prevTop + (newHeight - prevHeight);
    });
}

function createLoadMoreButton(remaining) {
    const btn = document.createElement('button');
    btn.className = 'load-more-history-btn';
    btn.type = 'button';
    btn.textContent = `加载更早的消息（剩余 ${remaining} 条）`;
    btn.onclick = loadMoreHistory;
    return btn;
}

function renderMessages() {
    const currentChat = state.chats.find(c => c.id === state.currentChatId);
    if (!currentChat) return;
    DOM.chatHeaderTitle.textContent = currentChat.title || "新对话";

    const msgs = currentChat.messages.filter(m => m.role !== 'system');
    const visibleCount = Math.min(getVisibleCount(state.currentChatId), msgs.length);
    const startIdx = Math.max(0, msgs.length - visibleCount);
    const visibleMsgs = msgs.slice(startIdx);
    const hasMore = startIdx > 0;

    const existingWrappers = DOM.chatMessages.querySelectorAll(':scope > .message-wrapper');
    const existingLoadMore = DOM.chatMessages.querySelector(':scope > .load-more-history-btn');

    // 增量更新：仅当聊天未切换、只是末尾追加、未在编辑、可见区起始未变时才追加 DOM
    // 使用版本戳（_renderVersion）比对而非 JSON.stringify，避免大对话每次重渲染都序列化所有消息
    const sameChat = _lastRenderChatId === state.currentChatId;
    const isAppendOnly = sameChat
        && state.editingIndex === -1
        && _lastRenderEditIdx === -1
        && existingWrappers.length > 0
        && visibleMsgs.length > existingWrappers.length
        && !!existingLoadMore === hasMore
        && visibleMsgs.slice(0, existingWrappers.length).every((msg) => {
            return msg._renderVersion !== undefined && msg._renderVersion === msg._lastRenderedVersion;
        });

    if (isAppendOnly) {
        for (let i = existingWrappers.length; i < visibleMsgs.length; i++) {
            const realIdx = startIdx + i;
            const domObj = createMessageDOM(visibleMsgs[i], realIdx, true);
            DOM.chatMessages.appendChild(domObj.wrapper);
            if (visibleMsgs[i]._renderVersion === undefined) visibleMsgs[i]._renderVersion = 0;
            visibleMsgs[i]._lastRenderedVersion = visibleMsgs[i]._renderVersion;
        }
    } else {
        DOM.chatMessages.innerHTML = '';
        if (hasMore) {
            DOM.chatMessages.appendChild(createLoadMoreButton(startIdx));
        }
        const sameChatFull = _lastRenderChatId === state.currentChatId;
        const newCountThreshold = sameChatFull ? _lastRenderMsgCount : msgs.length;
        // 仅在切换会话 / 首次渲染当前会话时启用 stagger 入场（非编辑、非末尾追加）
        const useStagger = !sameChatFull && state.editingIndex === -1;
        const staggerContentNodes = [];
        visibleMsgs.forEach((msg, i) => {
            const realIdx = startIdx + i;
            const isNew = sameChatFull && realIdx >= newCountThreshold;
            const domObj = createMessageDOM(msg, realIdx, isNew);
            if (useStagger && !isNew) {
                staggerContentNodes.push(domObj.contentNode);
            }
            DOM.chatMessages.appendChild(domObj.wrapper);
            if (msg._renderVersion === undefined) msg._renderVersion = 0;
            msg._lastRenderedVersion = msg._renderVersion;
        });

        if (staggerContentNodes.length > 0) {
            requestAnimationFrame(() => {
                if (typeof TextAnim !== 'undefined') {
                    TextAnim.staggerMessageContents(staggerContentNodes, {
                        variant: 'slideUp',
                        duration: 450,
                        staggerMs: 38,
                        interMessageDelay: 20,
                    });
                }
            });
        }
    }

    _lastRenderMsgCount = msgs.length;
    _lastRenderEditIdx = state.editingIndex;
    _lastRenderChatId = state.currentChatId;

    updateTokenCounter();

    setTimeout(() => { if (autoScroll) scrollToBottom(); }, 50);
}

function buildContextWithTrim(chat, newUserContent = null) {
    const limit = chat && chat.contextLimit ? chat.contextLimit : 0;
    const chatSystemPrompt = chat && chat.systemPrompt ? chat.systemPrompt : '';
    const chatUserPrefix = chat && chat.userPrefix ? chat.userPrefix : '';
    const systemMsg = chatSystemPrompt ? { role: 'system', content: chatSystemPrompt } : null;
    const newMsg = newUserContent !== null ? { role: 'user', content: newUserContent } : null;

    let conversationMsgs = chat.messages
        .filter(m => !m.isError)
        .map(m => ({ role: m.role, content: m.content }));

    let dropped20 = 0;
    if (chat && chat.dropFront20 && conversationMsgs.length > 0) {
        dropped20 = Math.floor(conversationMsgs.length * 0.2);
        if (dropped20 > 0) conversationMsgs = conversationMsgs.slice(dropped20);
    }

    let messages = systemMsg ? [systemMsg] : [];
    messages.push(...conversationMsgs);
    if (newMsg) messages.push(newMsg);

    if (!limit) return { messages, trimmed: dropped20 > 0, skippedRounds: 0, dropped20 };

    const msgTokens = (msg) => {
        const content = msg.role === 'assistant' ? stripThinkBlocks(msg.content) : msg.content;
        const base = estimateTokens(content) + 4;
        return (msg.role === 'user' && chatUserPrefix) ? base + estimateTokens(chatUserPrefix) : base;
    };

    let total = messages.reduce((sum, m) => sum + msgTokens(m), 0);
    const trimThreshold = limit * 0.8;
    if (total <= trimThreshold) return { messages, trimmed: dropped20 > 0, skippedRounds: 0, dropped20 };

    let startIdx = systemMsg ? 1 : 0;
    let skippedRounds = 0;
    const minKeepEnd = newMsg ? 1 : 0;

    while (total > trimThreshold && startIdx < messages.length - minKeepEnd - 1) {
        if (messages[startIdx]?.role === 'user' && messages[startIdx + 1]?.role === 'assistant') {
            total -= msgTokens(messages[startIdx]);
            total -= msgTokens(messages[startIdx + 1]);
            startIdx += 2;
            skippedRounds++;
        } else {
            total -= msgTokens(messages[startIdx]);
            startIdx++;
        }
    }

    const trimmed = skippedRounds > 0 || startIdx > (systemMsg ? 1 : 0) || dropped20 > 0;
    const result = [];
    if (systemMsg) result.push(systemMsg);
    for (let i = startIdx; i < messages.length; i++) {
        if (!newMsg || messages[i] !== newMsg) result.push(messages[i]);
    }
    if (newMsg) result.push(newMsg);
    return { messages: result, trimmed, skippedRounds, dropped20 };
}

function formatTokenCount(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(n >= 10_000 ? 0 : 1) + 'K';
    return String(n);
}

function updateTokenCounter() {
    if (!DOM.chatTokenCounter || !state.currentChatId) return;
    const chat = state.chats.find(c => c.id === state.currentChatId);
    if (!chat) return;

    const text = DOM.userInput ? DOM.userInput.value.trim() : '';
    let newContent = null;
    if (text || state.attachments.length) {
        newContent = buildMessageContent(text);
    }
    const allMsgs = chat.messages.map(m => ({
        role: m.role,
        content: m.role === 'assistant' ? stripThinkBlocks(m.content) : m.content
    }));
    let fullTokens = estimateMessagesTokens(allMsgs) + (chat.systemPrompt ? estimateTokens(chat.systemPrompt) + 4 : 0);
    if (newContent) {
        fullTokens += estimateTokens(newContent) + 4;
        if (typeof newContent === 'string' && chat.userPrefix) fullTokens += estimateTokens(chat.userPrefix);
    }
    const limit = chat.contextLimit || 0;
    DOM.chatTokenCounter.textContent = limit
        ? `${formatTokenCount(fullTokens)}/${formatTokenCount(limit)}`
        : `${formatTokenCount(fullTokens)}`;
    DOM.chatTokenCounter.classList.toggle('over-limit', limit > 0 && fullTokens >= limit * 0.8);
}

function updateTrimIndicator() {
    if (!state.currentChatId) return;
    const chat = state.chats.find(c => c.id === state.currentChatId);
    if (!chat) return;

    if (DOM.trimBadge) {
        const text = DOM.userInput.value.trim();
        const hasContent = text || state.attachments.length;
        let newContent = null;
        if (hasContent) {
            newContent = buildMessageContent(text);
        }

        const { trimmed } = buildContextWithTrim(chat, newContent);
        DOM.trimBadge.classList.toggle('show', trimmed);
        if (!trimmed && chat.contextLimitWarned) {
            chat.contextLimitWarned = false;
        }
    }
    updateTokenCounter();
}

function toggleDropFront20() {
    DOM.contextMenu.style.display = 'none';
    const chat = state.chats.find(c => c.id === contextMenuChatId);
    if (!chat) return;
    chat.dropFront20 = !chat.dropFront20;
    chat.contextLimitWarned = false;
    saveState();
    updateTrimIndicator();
    showToast(chat.dropFront20 ? '已开启：固定丢弃前 20% 对话' : '已关闭：固定丢弃前 20% 对话');
}

function toggleAutoFix() {
    DOM.contextMenu.style.display = 'none';
    const chat = state.chats.find(c => c.id === contextMenuChatId);
    if (!chat) return;
    chat.autoFixEnglish = !chat.autoFixEnglish;
    saveState();
    showToast(chat.autoFixEnglish ? '已开启：本对话自动修复英文' : '已关闭：本对话自动修复英文');
}

function toggleAutoRetryRefuse() {
    DOM.contextMenu.style.display = 'none';
    const chat = state.chats.find(c => c.id === contextMenuChatId);
    if (!chat) return;
    chat.autoRetryOnRefuse = !chat.autoRetryOnRefuse;
    saveState();
    showToast(chat.autoRetryOnRefuse ? '已开启：本对话拒绝回答自动重试' : '已关闭：本对话拒绝回答自动重试');
}

function togglePolish() {
    DOM.contextMenu.style.display = 'none';
    const chat = state.chats.find(c => c.id === contextMenuChatId);
    if (!chat) return;
    chat.autoPolish = !chat.autoPolish;
    saveState();
    showToast(chat.autoPolish ? '已开启：本对话自动润色' : '已关闭：本对话自动润色');
}

function handleKeydown(e) {
    const isMobile = window.innerWidth <= 768;
    if (isMobile) {
        if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); sendMessage(); }
    } else {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        toggleSearch(true);
    }
    if (e.key === 'Escape' && DOM.searchBar && DOM.searchBar.classList.contains('active')) {
        clearSearch();
    }
}

let _searchActive = false;
function toggleSearch(forceOpen) {
    const bar = DOM.searchBar;
    if (!bar) return;
    if (forceOpen || !bar.classList.contains('active')) {
        bar.classList.add('active');
        _searchActive = true;
        const input = document.getElementById('searchInput');
        if (input) input.focus();
    } else {
        clearSearch();
    }
}

function clearSearch() {
    const bar = DOM.searchBar;
    const input = document.getElementById('searchInput');
    const count = document.getElementById('searchCount');
    if (bar) bar.classList.remove('active');
    if (input) input.value = '';
    if (count) count.textContent = '';
    _searchActive = false;
    DOM.chatMessages.querySelectorAll('.message-wrapper.search-hidden').forEach(el => el.classList.remove('search-hidden'));
    DOM.chatMessages.querySelectorAll('.message-wrapper.search-highlight').forEach(el => el.classList.remove('search-highlight'));
}

let _searchRaf = 0;
function handleSearch(query) {
    if (_searchRaf) cancelAnimationFrame(_searchRaf);
    _searchRaf = requestAnimationFrame(() => {
        _searchRaf = 0;
        const q = query.trim().toLowerCase();
        const wrappers = DOM.chatMessages.querySelectorAll(':scope > .message-wrapper');
        let matchCount = 0;
        wrappers.forEach(w => {
            w.classList.remove('search-hidden', 'search-highlight');
            if (!q) return;
            const text = w.textContent.toLowerCase();
            if (text.includes(q)) {
                matchCount++;
                w.classList.add('search-highlight');
            } else {
                w.classList.add('search-hidden');
            }
        });
        const count = document.getElementById('searchCount');
        if (count) count.textContent = q ? `${matchCount} 条结果` : '';
    });
}

async function sendMessage() {
    const text = DOM.userInput.value.trim();
    if ((!text && !state.attachments.length) || !state.apiKey || !state.selectedModel) {
        if (!state.apiKey) showToast("请先在左侧设置中填写 API Key");
        return false;
    }

    const chatId = state.currentChatId;
    const content = cloneMessageContent(buildMessageContent(text));
    DOM.userInput.value = '';
    DOM.userInput.style.height = '52px';
    state.attachments = [];
    renderAttachments();
    updateTrimIndicator();

    QueueStore.enqueue(chatId, content);
    renderQueue();
    if (QueueStore.isBusy(chatId) || QueueStore.isPaused(chatId)) {
        showToast(QueueStore.isPaused(chatId) ? "队列已暂停，消息已加入队列" : "已加入队列，等待当前回复完成");
        return true;
    }
    // 别的会话正在请求：入队等待，由 pump 在空闲后接手，不能算失败
    if (QueueStore.isAnyBusy() || abortController) showToast("已加入队列，等待当前请求完成");
    await QueueStore.pump();
    return true;
}

function forkChat() {
    DOM.contextMenu.style.display = 'none';
    const chatId = contextMenuChatId;
    const sourceIdx = state.chats.findIndex(c => c.id === chatId);
    if (sourceIdx === -1) return;
    const source = state.chats[sourceIdx];

    const baseTitle = (source.title || '新对话').replace(/\.\d+$/, '');
    const usedNumbers = new Set();
    state.chats.forEach(c => {
        if (!c.title) return;
        if (c.title === baseTitle) { usedNumbers.add(0); return; }
        const m = c.title.match(/^(.+)\.(\d+)$/);
        if (m && m[1] === baseTitle) usedNumbers.add(parseInt(m[2], 10));
    });
    let n = 1;
    while (usedNumbers.has(n)) n++;

    const cloned = JSON.parse(JSON.stringify({ ...source, messages: source.messages.map(m => {
        const { _lastRenderedContent, _lastRenderedVersion, _renderVersion, ...rest } = m;
        return rest;
    }) }));
    cloned.id = Date.now().toString();
    cloned.title = `${baseTitle}.${n}`;
    cloned.contextLimitWarned = false;

    state.chats.splice(sourceIdx + 1, 0, cloned);
    state.currentChatId = cloned.id;
    state.editingIndex = -1;
    setVisibleCount(cloned.id, MESSAGE_PAGE_SIZE);
    saveState();
    renderChatList();
    renderMessages();
    updateTrimIndicator();
    closeSidebar();
    showToast(`已 Fork 为「${cloned.title}」`);
}

function renameChat() {
    DOM.contextMenu.style.display = 'none';
    const chatId = contextMenuChatId;
    const chat = state.chats.find(c => c.id === chatId);
    if (!chat) return;

    // 判断是从标题还是列表触发
    const isFromHeader = chatId === state.currentChatId;
    const titleEl = isFromHeader ? DOM.chatHeaderTitle : null;
    const currentTitle = chat.title || '新对话';

    if (isFromHeader) {
        // 从标题触发：在标题位置编辑
        const input = document.createElement('input');
        input.type = 'text';
        input.value = currentTitle;
        input.className = 'rename-input';
        input.style.cssText = 'font-size:inherit;font-weight:inherit;width:200px;padding:4px 8px;border:1px solid #000;border-radius:4px;outline:none;';

        titleEl.textContent = '';
        titleEl.appendChild(input);
        input.focus();
        input.select();

        const save = () => {
            const newTitle = input.value.trim() || currentTitle;
            chat.title = newTitle;
            saveState();
            titleEl.textContent = newTitle;
            renderChatList();
        };

        input.addEventListener('blur', save);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
            if (e.key === 'Escape') { input.value = currentTitle; input.blur(); }
        });
    } else {
        // 从列表触发：使用prompt
        const newTitle = prompt("重命名对话", currentTitle);
        if (newTitle !== null && newTitle.trim()) {
            chat.title = newTitle.trim();
            saveState();
            renderChatList();
            if (chatId === state.currentChatId) {
                DOM.chatHeaderTitle.textContent = newTitle.trim();
            }
        }
    }
}

async function init() {
    initDOM();
    await loadSettingsFromDB();
    await loadChatsFromDB();
    await migratePromptsToChats();
    clearLegacyStorage();

    DOM.apiKeyInput.value = state.apiKey;
    DOM.htmlStyleSelect.value = state.htmlStyle;
    DOM.filterModeSelect.value = state.filterMode;
    DOM.exportRoleSelect.value = state.exportRole;
    if (DOM.maxAttachmentMBInput) DOM.maxAttachmentMBInput.value = state.maxAttachmentMB;
    if (DOM.ttsEnabledSelect) DOM.ttsEnabledSelect.value = state.ttsEnabled ? 'on' : 'off';
    if (DOM.ttsVoiceSelect) DOM.ttsVoiceSelect.value = state.ttsVoice;

    buildChatPresetOptions();
    initCustomSelects();

    if (state.chats.length === 0) createNewChat(false);
    else {
        if (!state.currentChatId || !state.chats.find(c => c.id === state.currentChatId)) state.currentChatId = state.chats[0].id;
        renderChatList(); renderMessages(); updateTrimIndicator();
    }
    QueueStore.purgeLegacyErrors();
    await QueueStore.restore();
    QueueStore.onChange(() => {
        renderQueue();
        updateSendButton(false);
    });
    renderQueue();
    updateSendButton(false);
    if (state.apiKey && state.selectedModel) {
        DOM.modelSelect.innerHTML = `<option value="${state.selectedModel}">${state.selectedModel}</option>`;
        DOM.titleModelSelect.innerHTML = `<option value="">跟随对话模型</option><option value="${state.titleModel}" selected>${state.titleModel}</option>`;
        DOM.refuseModelSelect.innerHTML = `<option value="">跟随对话模型</option>${state.refuseModel ? `<option value="${state.refuseModel}" selected>${state.refuseModel}</option>` : ''}`;
        DOM.polishModelSelect.innerHTML = `<option value="">跟随对话模型</option>${state.polishModel ? `<option value="${state.polishModel}" selected>${state.polishModel}</option>` : ''}`;
        refreshAllCustomSelects();
    }

    DOM.chatMessages.addEventListener('scroll', checkAutoScroll, { passive: true });
    DOM.chatMessages.addEventListener('pointerdown', keepMobileComposerVisible);
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', throttledKeepMobileVisible, { passive: true });
        window.visualViewport.addEventListener('scroll', throttledKeepMobileVisible, { passive: true });
        keepMobileComposerVisible();
    }

    updatePrefixBadge();

    initTheme();

    DOM.userInput.addEventListener('input', function() {
        this.style.height = '52px';
        this.style.height = (this.scrollHeight) + 'px';
        if (this.value === '') this.style.height = '52px';
        updateTrimIndicator();
    });

    // 粘贴：剪贴板含文件时作为附件处理，纯文本走默认行为
    // 监听 document 级别，确保不聚焦输入框时 Ctrl+V 也能粘贴附件
    document.addEventListener('paste', function(e) {
        // 在其他可编辑控件（如设置项输入框）中粘贴时不拦截
        const activeEl = document.activeElement;
        if (activeEl && activeEl !== DOM.userInput &&
            (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) {
            return;
        }
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        const files = [];
        for (const item of items) {
            if (item.kind === 'file') {
                const f = item.getAsFile();
                if (f) files.push(f);
            }
        }
        if (files.length) {
            e.preventDefault();
            addFiles(files);
        }
    });

    // 点击其他地方关闭右键菜单与聊天设置
    document.addEventListener('click', (e) => {
        if (DOM.contextMenu) DOM.contextMenu.style.display = 'none';
        closeCustomSelects();
        if (DOM.chatSettingsContainer && DOM.chatSettingsContainer.classList.contains('show') && !DOM.chatSettingsContainer.contains(e.target) && !e.target.closest('.context-menu-item')) {
            closeChatSettings();
        }
    });
}

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    // 新 Service Worker 接管后自动重载，确保 HTML 与其引用的 JS/CSS 版本一致。
    // 首次安装时（此前无 controller）claim 也会触发 controllerchange，此时不应重载。
    let refreshing = false;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing || !hadController) return;
        refreshing = true;
        window.location.reload();
    });

    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch((error) => {
            console.warn('Service worker registration failed:', error);
        });
    });
}

window.addEventListener('beforeunload', () => {
    flushPendingStateSave();
    flushPendingSettingsSave();
});

// 标签页切换恢复
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
        flushPendingStateSave();
        return;
    }
    keepMobileComposerVisible();
    const el = DOM.chatMessages;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 150) {
        autoScroll = true;
        scrollToBottom();
    }
    if (typeof window.__streamFlush === 'function') {
        window.__streamFlush();
    }
});

registerServiceWorker();
init().catch(e => console.error('Init failed:', e));
