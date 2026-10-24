async function fetchModels() {
    if (!DOM.apiKeyInput.value.trim()) return showToast("请先填写 API Key");
    const fetchBtn = DOM.settingsContainer.querySelector('.btn-outline');
    const origText = fetchBtn.textContent;
    fetchBtn.textContent = '加载中...';
    fetchBtn.style.opacity = '0.5';
    try {
        DOM.modelSelect.innerHTML = '<option value="">加载中...</option>';
        refreshCustomSelect(DOM.modelSelect);
        const res = await fetch(`${API_BASE}/models`, { headers: { 'Authorization': `Bearer ${DOM.apiKeyInput.value.trim()}` } });
        const data = await res.json();
        if (data && data.data) {
            DOM.modelSelect.innerHTML = ''; DOM.titleModelSelect.innerHTML = '<option value="">跟随对话模型</option>'; DOM.refuseModelSelect.innerHTML = '<option value="">跟随对话模型</option>'; DOM.polishModelSelect.innerHTML = '<option value="">跟随对话模型</option>';
            data.data.forEach(m => { DOM.modelSelect.add(new Option(m.id, m.id)); DOM.titleModelSelect.add(new Option(m.id, m.id)); DOM.refuseModelSelect.add(new Option(m.id, m.id)); DOM.polishModelSelect.add(new Option(m.id, m.id)); });
            if (state.selectedModel && data.data.find(m => m.id === state.selectedModel)) DOM.modelSelect.value = state.selectedModel;
            else { state.selectedModel = data.data[0].id; DOM.modelSelect.value = state.selectedModel; persistSettings(); }
            if (state.titleModel && data.data.find(m => m.id === state.titleModel)) DOM.titleModelSelect.value = state.titleModel;
            if (state.refuseModel && data.data.find(m => m.id === state.refuseModel)) DOM.refuseModelSelect.value = state.refuseModel;
            if (state.polishModel && data.data.find(m => m.id === state.polishModel)) DOM.polishModelSelect.value = state.polishModel;
            refreshAllCustomSelects();
            showToast("模型列表获取成功！");
        }
    } catch (error) {
        DOM.modelSelect.innerHTML = '<option value="">获取失败，点击重试</option>';
        refreshCustomSelect(DOM.modelSelect);
    } finally {
        fetchBtn.textContent = origText;
        fetchBtn.style.opacity = '1';
    }
}

// 全局单飞：同一时刻只允许一个 /chat/completions 在途。
// 队列发起请求前用 whenRequestIdle() 等待，把「忙」当成可等待状态，而不是失败。
let _requestIdleWaiters = [];
let _requestDepth = 0;
let _activeRequestChatId = null;

// 当前真正占用 abortController 的会话（用于「停止生成」与发送键定位）
function getActiveRequestChatId() { return _activeRequestChatId; }

function whenRequestIdle(timeoutMs = 120000) {
    if (!abortController) return Promise.resolve();
    return new Promise(resolve => {
        const waiter = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
            _requestIdleWaiters = _requestIdleWaiters.filter(w => w !== waiter);
            resolve();
        }, timeoutMs);
        _requestIdleWaiters.push(waiter);
    });
}

function notifyRequestIdle() {
    if (abortController) return;
    const waiters = _requestIdleWaiters;
    _requestIdleWaiters = [];
    waiters.forEach(fn => { try { fn(); } catch (e) {} });
}

async function executeChatRequest(currentChat, preparedMessages, options = {}) {
    const failedResult = (error) => ({ ok: false, aborted: false, failed: true, error: error || null });
    // 已有请求在途：返回 busy（可重试），不是失败——不能落成对话里的错误消息
    if (abortController) return { ok: false, busy: true, skipped: true, aborted: false, failed: false, error: null };
    const requestController = new AbortController();
    abortController = requestController;
    _activeRequestChatId = currentChat ? currentChat.id : null;
    _requestDepth++;
    try {
    updateSendButton(true);
    updateTrimIndicator();
    if (autoScroll) scrollToBottom();

    let apiMessages;
    const chatUserPrefix = (currentChat && currentChat.userPrefix) ? currentChat.userPrefix : '';
    if (preparedMessages && preparedMessages.length > 0) {
        apiMessages = preparedMessages.map(m => {
            if (m.role === 'assistant') {
                let content = typeof m.content === 'string' ? m.content : '';
                content = content.replace(CLOSED_THINK_BLOCK_PATTERN_GLOBAL, '').trim();
                return { role: m.role, content };
            }
            if (m.role === 'user' && chatUserPrefix) {
                let contentCopy = JSON.parse(JSON.stringify(m.content));
                if (typeof contentCopy === 'string') {
                    contentCopy = chatUserPrefix + contentCopy;
                } else if (Array.isArray(contentCopy)) {
                    let textPart = contentCopy.find(c => c.type === 'text');
                    if (textPart) textPart.text = chatUserPrefix + textPart.text;
                }
                return { role: m.role, content: contentCopy };
            }
            return { role: m.role, content: m.content };
        });
    } else {
        apiMessages = buildContextWithTrim(currentChat).messages.map(m => {
            if (m.role === 'assistant') {
                let content = typeof m.content === 'string' ? m.content : '';
                content = content.replace(CLOSED_THINK_BLOCK_PATTERN_GLOBAL, '').trim();
                return { role: m.role, content };
            }
            if (m.role === 'user' && chatUserPrefix) {
                let contentCopy = JSON.parse(JSON.stringify(m.content));
                if (typeof contentCopy === 'string') {
                    contentCopy = chatUserPrefix + contentCopy;
                } else if (Array.isArray(contentCopy)) {
                    let textPart = contentCopy.find(c => c.type === 'text');
                    if (textPart) textPart.text = chatUserPrefix + textPart.text;
                }
                return { role: m.role, content: contentCopy };
            }
            return { role: m.role, content: m.content };
        });
    }

    const targetIndex = currentChat.messages.length;
    const isTargetVisible = () => currentChat.id === state.currentChatId;
    let botDomObj = null;
    const reuseWrapper = options && options.reuseWrapper;
    if (isTargetVisible() && reuseWrapper && reuseWrapper.isConnected) {
        botDomObj = {
            wrapper: reuseWrapper,
            contentNode: reuseWrapper.querySelector('.message.bot, .message')
        };
        botDomObj.wrapper.classList.remove('bubble-resetting');
        botDomObj.wrapper.classList.add('bubble-reenter');
        botDomObj.wrapper.querySelector('.message-actions').style.display = 'none';
        botDomObj.contentNode.innerHTML = '<div class="result-thinking"><span></span><span></span><span></span></div>';
    } else if (isTargetVisible()) {
        botDomObj = createMessageDOM({ role: 'assistant', content: '' }, targetIndex, true);
        botDomObj.wrapper.querySelector('.message-actions').style.display = 'none';
        botDomObj.contentNode.innerHTML = '<div class="result-thinking"><span></span><span></span><span></span></div>';
        DOM.chatMessages.appendChild(botDomObj.wrapper);
    }
    let streamThinkOpen = false;
    let streamThinkPointerHandled = false;
    function _toggleStreamThink(summary, event) {
        const thinkBlock = summary.closest('.think-block');
        const msgEl = botDomObj.wrapper.querySelector('.message.bot');
        const previousHeight = msgEl ? msgEl.getBoundingClientRect().height : 0;
        streamThinkOpen = thinkBlock ? !thinkBlock.open : !streamThinkOpen;
        if (thinkBlock) thinkBlock.open = streamThinkOpen;
        event.preventDefault();
        _animateBubbleHeight(previousHeight);
    }
    if (botDomObj) botDomObj.contentNode.addEventListener('pointerdown', (event) => {
        const summary = event.target.closest('.think-summary');
        if (!summary || !botDomObj.contentNode.contains(summary)) return;
        streamThinkPointerHandled = true;
        _toggleStreamThink(summary, event);
    });
    if (botDomObj) botDomObj.contentNode.addEventListener('click', (event) => {
        const summary = event.target.closest('.think-summary');
        if (!summary || !botDomObj.contentNode.contains(summary)) return;
        if (streamThinkPointerHandled) {
            streamThinkPointerHandled = false;
            event.preventDefault();
            return;
        }
        _toggleStreamThink(summary, event);
    });

    let _streamTimer = null;
    let _pendingStreamContent = '';
    let _thinkRenderedOnce = false;
    let _firstTokenArrived = false;
    let _bubbleGrowthAnimation = null;
    const _streamTextByTarget = new Map();
    function _ensureStreamingState() {
        if (_firstTokenArrived) return;
        _firstTokenArrived = true;
        if (!botDomObj || !isTargetVisible()) return;
        const thinkingDots = botDomObj.contentNode.querySelector('.result-thinking');
        if (thinkingDots) thinkingDots.remove();
        const msgEl = botDomObj.wrapper.querySelector('.message.bot');
        if (msgEl) msgEl.classList.add('result-streaming');
    }
    function _getStreamTarget() {
        const reply = botDomObj.contentNode.querySelector('.reply-content');
        if (reply) return { key: 'reply', element: reply };
        const thinkContent = botDomObj.contentNode.querySelector('.think-content');
        if (thinkContent) return { key: 'think', element: thinkContent };
        return { key: 'main', element: botDomObj.contentNode };
    }
    function _markNewStreamText(element, previousText) {
        const currentText = element.textContent || '';
        let start = 0;
        const maxStart = Math.min(previousText.length, currentText.length);
        while (start < maxStart && previousText[start] === currentText[start]) start++;
        if (start >= currentText.length) return currentText;
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
                if (node.parentElement && node.parentElement.closest('button, svg')) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        const textNodes = [];
        let node;
        while ((node = walker.nextNode())) textNodes.push(node);
        let offset = 0;
        textNodes.forEach(textNode => {
            const text = textNode.nodeValue;
            const nextOffset = offset + text.length;
            if (nextOffset <= start) {
                offset = nextOffset;
                return;
            }
            const localStart = Math.max(0, start - offset);
            const span = document.createElement('span');
            span.className = 'stream-new-chunk';
            span.textContent = text.slice(localStart);
            if (typeof TextAnim !== 'undefined') TextAnim.revealChunk(span);
            if (localStart === 0) {
                textNode.parentNode.replaceChild(span, textNode);
            } else {
                textNode.nodeValue = text.slice(0, localStart);
                textNode.parentNode.insertBefore(span, textNode.nextSibling);
            }
            offset = nextOffset;
        });
        return currentText;
    }
    function _triggerPopIn() {
        const target = _getStreamTarget();
        const previousText = _streamTextByTarget.get(target.key) || '';
        const currentText = _markNewStreamText(target.element, previousText);
        _streamTextByTarget.set(target.key, currentText);
    }
    function _updateStreamContent(c) {
        const hasClosedThink = c && CLOSED_THINK_BLOCK_PATTERN.test(c);
        const existingThink = botDomObj.contentNode.querySelector('.think-block');
        const existingReply = botDomObj.contentNode.querySelector('.reply-content');
        if (hasClosedThink && existingThink) {
            const thinkMatch = c.match(CLOSED_THINK_BLOCK_PATTERN);
            const replyContent = c.replace(CLOSED_THINK_BLOCK_PATTERN, '').trim();
            const thinkingNow = !replyContent;
            const summary = existingThink.querySelector('.think-summary');
            const thinkContent = existingThink.querySelector('.think-content');
            if (summary) summary.innerHTML = `${thinkingNow ? '' : '<svg class="think-icon" viewBox="0 0 24 24" width="16" height="16"><path d="M9.55 17.05 4.9 12.4l1.42-1.42 3.23 3.23 8.13-8.13 1.42 1.42-9.55 9.55Z"/></svg>'} ${thinkingNow ? '思考中...' : '思考过程'}`;
            if (thinkContent) thinkContent.innerHTML = renderMarkdownToHtml(thinkMatch[1]);
            existingThink.open = streamThinkOpen;
            if (replyContent) {
                if (existingReply) existingReply.innerHTML = renderMarkdownToHtml(replyContent);
                else botDomObj.contentNode.insertAdjacentHTML('beforeend', `<div class="reply-content">${renderMarkdownToHtml(replyContent)}</div>`);
            }
            if (shouldProcessMath(c)) renderMath(botDomObj.contentNode);
            if (c.includes('<pre') || c.includes('```')) highlightCodeBlocks(botDomObj.contentNode);
            _thinkRenderedOnce = true;
            return;
        }
        _thinkRenderedOnce = !!hasClosedThink;
        botDomObj.contentNode.innerHTML = renderContentWithThink(c, true);
        if (shouldProcessMath(c)) renderMath(botDomObj.contentNode);
        if (c && (c.includes('<pre') || c.includes('```'))) highlightCodeBlocks(botDomObj.contentNode);
        const nextThinkBlock = botDomObj.contentNode.querySelector('.think-block');
        if (nextThinkBlock) nextThinkBlock.open = streamThinkOpen;
    }
    function _animateBubbleHeight(previousHeight) {
        const msgEl = botDomObj.wrapper.querySelector('.message.bot');
        if (!msgEl || !previousHeight) return;
        const nextHeight = msgEl.getBoundingClientRect().height;
        if (Math.abs(nextHeight - previousHeight) < 0.5) return;
        if (_bubbleGrowthAnimation) _bubbleGrowthAnimation.cancel();
        msgEl.style.height = `${nextHeight}px`;
        msgEl.style.overflow = 'hidden';
        const animation = msgEl.animate([
            { height: `${previousHeight}px` },
            { height: `${nextHeight}px` }
        ], { duration: 1000, easing: 'linear' });
        _bubbleGrowthAnimation = animation;
        animation.onfinish = () => {
            if (_bubbleGrowthAnimation !== animation) return;
            msgEl.style.height = '';
            msgEl.style.overflow = '';
            _bubbleGrowthAnimation = null;
        };
        animation.oncancel = () => {
            if (_bubbleGrowthAnimation !== animation) return;
            _bubbleGrowthAnimation = null;
        };
    }
    function scheduleStreamRender(content) {
        if (!botDomObj || !isTargetVisible()) return;
        if (content === _pendingStreamContent) return;
        _pendingStreamContent = content;
        if (_streamTimer) return;
        if (document.visibilityState !== 'visible') {
            window.__streamFlush = () => {
                if (_pendingStreamContent && !_streamTimer) {
                    const content = _pendingStreamContent;
                    _pendingStreamContent = '';
                    scheduleStreamRender(content);
                }
            };
            return;
        }
        _streamTimer = setTimeout(() => {
            window.__streamFlush = null;
            _streamTimer = null;
            if (!botDomObj || !isTargetVisible()) {
                _pendingStreamContent = '';
                return;
            }
            const c = _pendingStreamContent;
            _pendingStreamContent = '';
            _ensureStreamingState();
            const msgEl = botDomObj && isTargetVisible() ? botDomObj.wrapper.querySelector('.message.bot') : null;
            if (_bubbleGrowthAnimation) {
                _bubbleGrowthAnimation.cancel();
                _bubbleGrowthAnimation = null;
                if (msgEl) {
                    msgEl.style.height = '';
                    msgEl.style.overflow = '';
                }
            }
            const previousHeight = msgEl ? msgEl.getBoundingClientRect().height : 0;
            _updateStreamContent(c);
            _triggerPopIn();
            _animateBubbleHeight(previousHeight);
            if (autoScroll) scrollToBottom();
        }, 1000);
    }

    let botReply = '';
    let reasoningBuffer = '';
    let requestFailed = false;
    let requestAborted = false;
    let requestError = null;
    let assistantCommitted = false;
    const maxRetries = 3;

    for (let retry = 0; retry <= maxRetries; retry++) {
        try {
            botReply = '';
            reasoningBuffer = '';

            const requestBody = { model: state.selectedModel, messages: apiMessages, stream: currentChat.stream !== false, temperature: currentChat.temperature !== undefined ? currentChat.temperature : 0.7 };
            if (currentChat.maxTokens) requestBody.max_tokens = currentChat.maxTokens;

            const response = await fetch(`${API_BASE}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.apiKey}` },
                body: JSON.stringify(requestBody),
                signal: requestController.signal
            });

            if (!response.ok) {
                let errDetail = `HTTP ${response.status}`;
                try { const errBody = await response.json(); errDetail += ': ' + (errBody.error?.message || errBody.message || JSON.stringify(errBody).slice(0, 200)); } catch(e) {}
                throw new Error(errDetail);
            }
            _ensureStreamingState();

            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let newlineIndex;
                while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, newlineIndex).trim();
                    buffer = buffer.slice(newlineIndex + 1);
                    if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                        try {
                            const dataObj = JSON.parse(line.slice(6));
                            const delta = dataObj.choices[0]?.delta;

                            // 处理推理内容 (reasoning_content)
                            if (delta?.reasoning_content) {
                                reasoningBuffer += delta.reasoning_content;
                            }

                            // 处理内容
                            if (delta?.content) {
                                botReply += delta.content;
                            }

                            if (delta?.reasoning_content || delta?.content) {
                                scheduleStreamRender(reasoningBuffer
                                    ? `<think>${reasoningBuffer}</think>\n\n${botReply}`
                                    : botReply);
                            }
                        } catch (e) {}
                    }
                }
            }
            // 流式渲染结束，清空定时器并进行最终渲染
            if (_streamTimer) {
                clearTimeout(_streamTimer);
                _streamTimer = null;
            }
            window.__streamFlush = null;
            if (botDomObj && isTargetVisible() && _pendingStreamContent) {
                const c = _pendingStreamContent;
                _pendingStreamContent = '';
                _updateStreamContent(c);
                if (autoScroll) scrollToBottom();
            }
            const msgEl = botDomObj && isTargetVisible() ? botDomObj.wrapper.querySelector('.message.bot') : null;
            if (_bubbleGrowthAnimation) _bubbleGrowthAnimation.cancel();
            if (msgEl) {
                msgEl.classList.remove('result-streaming');
                msgEl.style.height = '';
                msgEl.style.overflow = '';
            }
            break;
        } catch (error) {
            if (error.name === 'AbortError') {
                requestAborted = true;
                break;
            }
            if (retry < maxRetries) {
                await new Promise(r => setTimeout(r, retry * 3000));
            } else {
                requestFailed = true;
                requestError = error;
                const retryNote = botReply ? `已有部分回复，错误: ${error.message}` : `请求失败，已重试 ${maxRetries} 次。错误: ${error.message}`;
                if (botDomObj && isTargetVisible()) botDomObj.contentNode.innerHTML = `<div class="error-message"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" fill="currentColor"/></svg><span>${escapeHtml(retryNote)}</span></div>`;
                showToast("消息请求失败，请重试");
            }
        }
    }

    if (!requestFailed && (botReply || reasoningBuffer)) {
        const liveChat = state.chats.find(chat => chat.id === currentChat.id);
        if (liveChat !== currentChat) {
            requestFailed = true;
            requestError = new Error('目标对话已不存在，请求结果未保存');
            if (botDomObj && isTargetVisible()) {
                botDomObj.contentNode.innerHTML = `<div class="error-message"><span>${escapeHtml(requestError.message)}</span></div>`;
            }
        } else {
            // 中止时也保留已生成的部分回复（标记 aborted），避免整段内容凭空消失
            const assistantMsg = {
                role: 'assistant',
                content: reasoningBuffer ? `<think>${reasoningBuffer}</think>\n\n${botReply}` : botReply
            };
            if (requestAborted) assistantMsg.aborted = true;
            if (options.queueItemId) assistantMsg._queueItemId = options.queueItemId;
            currentChat.messages.push(assistantMsg);
            assistantCommitted = true;
            saveState();
        }
    }
    const msgEl = botDomObj && isTargetVisible() ? botDomObj.wrapper.querySelector('.message.bot') : null;
    if (_bubbleGrowthAnimation) _bubbleGrowthAnimation.cancel();
    if (msgEl) {
        msgEl.classList.remove('result-streaming');
        msgEl.style.height = '';
        msgEl.style.overflow = '';
    }
    if (botDomObj && isTargetVisible()) botDomObj.wrapper.classList.remove('bubble-reenter');

    const isReuse = !!(options && options.reuseWrapper);
    // 复用气泡重试时，流式渲染已直接更新 DOM，跳过 renderMessages 全量重建以保留原气泡
    if (!isReuse && !requestFailed) {
        if (currentChat.id === state.currentChatId) renderMessages();
    }

    if (abortController === requestController) {
        abortController = null;
        _activeRequestChatId = null;
    }
    updateSendButton(false);
    updateTrimIndicator();
    if (!isReuse && isTargetVisible()) DOM.userInput.focus();

    let refused = false;
    let nestedRetryResult = null;
    if (assistantCommitted && !requestFailed && !requestAborted && currentChat.autoRetryOnRefuse && botReply) {
        const refuseResult = await checkRefuseAndRetry(currentChat, botDomObj && botDomObj.wrapper, {
            suppressQueueAutoProcess: options.suppressQueueAutoProcess,
            refuseRetryDepth: options.refuseRetryDepth || 0,
            queueItemId: options.queueItemId
        }).catch(error => ({ refused: false, ok: false, result: failedResult(error) }));
        refused = !!refuseResult.refused;
        nestedRetryResult = refuseResult.refused ? refuseResult.result : null;
    }

    if (assistantCommitted && !requestFailed && !requestAborted && !refused && currentChat.autoFixEnglish && botReply) {
        await autoFixLastAssistantMessage(currentChat).catch(() => {});
    }

    if (assistantCommitted && !requestFailed && !requestAborted && !refused && currentChat.autoPolish && botReply) {
        await autoPolishLastAssistantMessage(currentChat).catch(() => {});
    }

    // 重试复用气泡：若未触发再次重试，则最终同步渲染以恢复操作按钮与版本戳
    if (isReuse && !refused && isTargetVisible()) {
        renderMessages();
        DOM.userInput.focus();
    }

// 未重试时才检查队列（重试中由最内层非重试调用处理队列）
    // 请求失败或被中止时不自动继续队列；队列续跑统一由 QueueStore.pump 驱动

    return nestedRetryResult || {
        ok: !requestFailed && !requestAborted,
        aborted: requestAborted,
        failed: requestFailed,
        error: requestError
    };
    } catch (error) {
        console.error('Chat request setup failed:', error);
        showToast(`消息请求失败：${error.message || error}`);
        return failedResult(error);
    } finally {
        if (abortController === requestController) {
            abortController = null;
            _activeRequestChatId = null;
        }
        // 嵌套调用（拒答重试）退到最外层时才唤醒等待中的队列
        _requestDepth = Math.max(0, _requestDepth - 1);
        if (_requestDepth === 0) notifyRequestIdle();
        updateSendButton(false);
        updateTrimIndicator();
    }
}

function stopGeneration() {
    if (!abortController) return;
    // 中止的目标是"正在跑的那个 chat"，不一定是当前显示的会话
    const targetChatId = getActiveRequestChatId() || state.currentChatId;
    abortController.abort();
    if (targetChatId && QueueStore.hasPending(targetChatId)) {
        QueueStore.pause(targetChatId, 'user');
        showToast("已停止生成，队列已暂停");
    } else {
        showToast("已停止生成");
    }
    updateSendButton(false);
    renderQueue();
}

const SEND_BTN_TRIM_BADGE_HTML = '<span class="send-btn-trim-badge" id="trimBadge" title="将丢弃开头部分上下文以控制 Token 总量"><svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></span>';
const SEND_BTN_ICON = '<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"></path></svg>';
const STOP_BTN_ICON = '<svg class="stop-spinner" viewBox="0 0 24 24"><path d="M19.2 12a7.2 7.2 0 1 1-2.1-5.1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M17.1 3.8v3.1h3.1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const RETRY_BTN_ICON = '<svg viewBox="0 0 24 24"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>';
const QUEUE_ADD_ICON = '<svg viewBox="0 0 24 24"><path d="M4 7h16v2H4V7zm0 4h16v2H4v-2zm0 4h16v2H4v-2z"/></svg>';
const QUEUE_CONTINUE_ICON = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const QUEUE_CLEAR_ICON = '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';

// 替换发送按钮内容时重新挂载并缓存 trim 角标，避免引用失效
function _setSendBtnContent(iconHtml) {
    DOM.sendBtn.innerHTML = iconHtml + SEND_BTN_TRIM_BADGE_HTML;
    DOM.trimBadge = document.getElementById('trimBadge');
}

function updateSendButton(isGenerating) {
    const chatId = state.currentChatId;
    // 只有"当前会话自己"的请求才把发送键变成停止键；别的会话在跑不影响这里发送
    const activeChat = getActiveRequestChatId();
    const hasOwnActiveRequest = !!abortController && (!activeChat || activeChat === chatId);
    const snap = chatId ? QueueStore.getSnapshot(chatId) : null;
    const q = snap || { items: [], paused: false, pauseReason: null, failedItem: null, busy: false, sending: false };
    const chatBusy = !!q.busy || !!isGenerating;

    if (hasOwnActiveRequest) {
        _setSendBtnContent(STOP_BTN_ICON);
        DOM.sendBtn.onclick = stopGeneration;
        DOM.sendBtn.classList.add('stop-btn');
        DOM.sendBtn.classList.remove('retry-btn');
        DOM.sendBtn.title = '停止生成';
        DOM.queueBtn.classList.add('generating');
        DOM.queueBtn.classList.remove('paused');
        DOM.queueBtn.innerHTML = QUEUE_ADD_ICON;
        DOM.queueBtn.onclick = addToQueue;
        DOM.queueBtn.title = '加入队列';
    } else if (q.paused && q.failedItem) {
        // 失败/停止暂停：必须重试队头（不可跳过）
        _setSendBtnContent(RETRY_BTN_ICON);
        DOM.sendBtn.onclick = retryLastAndResume;
        DOM.sendBtn.classList.remove('stop-btn');
        DOM.sendBtn.classList.add('retry-btn');
        DOM.sendBtn.title = q.pauseReason === 'user' ? '重试已停止的消息' : '重试上一条失败消息';
        DOM.queueBtn.classList.remove('generating');
        DOM.queueBtn.classList.add('paused');
        DOM.queueBtn.innerHTML = QUEUE_CLEAR_ICON;
        DOM.queueBtn.onclick = clearQueueClick;
        DOM.queueBtn.title = '清空队列';
    } else if (q.paused && q.items.length) {
        // 用户暂停，队列仍有剩余：继续
        _setSendBtnContent(QUEUE_CONTINUE_ICON);
        DOM.sendBtn.onclick = () => QueueStore.resumeAndProcess(chatId);
        DOM.sendBtn.classList.remove('stop-btn', 'retry-btn');
        DOM.sendBtn.title = '继续队列';
        DOM.queueBtn.classList.remove('generating');
        DOM.queueBtn.classList.add('paused');
        DOM.queueBtn.innerHTML = QUEUE_CLEAR_ICON;
        DOM.queueBtn.onclick = clearQueueClick;
        DOM.queueBtn.title = '清空队列';
    } else if (chatBusy) {
        _setSendBtnContent(SEND_BTN_ICON);
        DOM.sendBtn.onclick = () => showToast('请求正在处理中，请稍候');
        DOM.sendBtn.classList.remove('stop-btn', 'retry-btn');
        DOM.sendBtn.title = '请求处理中';
        DOM.queueBtn.classList.add('generating');
        DOM.queueBtn.classList.remove('paused');
        DOM.queueBtn.innerHTML = QUEUE_ADD_ICON;
        DOM.queueBtn.onclick = addToQueue;
        DOM.queueBtn.title = '加入队列';
    } else {
        _setSendBtnContent(SEND_BTN_ICON);
        DOM.sendBtn.onclick = sendMessage;
        DOM.sendBtn.classList.remove('stop-btn');
        DOM.sendBtn.classList.remove('retry-btn');
        DOM.sendBtn.title = '发送';
        DOM.queueBtn.classList.remove('generating');
        DOM.queueBtn.classList.remove('paused');
        DOM.queueBtn.innerHTML = QUEUE_ADD_ICON;
        DOM.queueBtn.onclick = addToQueue;
        DOM.queueBtn.title = '加入队列';
    }
    updateTrimIndicator();
}

async function detectRefuse(msg) {
    if (!msg || msg.role !== 'assistant') return null;
    const modelToUse = state.refuseModel || state.selectedModel;
    if (!modelToUse || !state.apiKey) return null;
    const plain = getMessagePlainText(msg);
    if (!plain) return null;

    try {
        const prompt = `你是一个判断助手。请判断以下AI回复是否在拒绝回答用户的问题（例如：表示无法回答、不愿意回答、因安全策略拒绝、回避问题等）。\n\nAI回复内容：\n${plain}\n\n请以JSON格式回复，格式为：{"refused": true/false}`;
        const response = await fetch(`${API_BASE}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.apiKey}` },
            body: JSON.stringify({
                model: modelToUse,
                messages: [{ role: 'user', content: prompt }],
                stream: false,
                temperature: 0,
                response_format: { type: 'json_object' }
            })
        });
        if (!response.ok) return null;
        const data = await response.json();
        let text = data.choices?.[0]?.message?.content?.trim() || '';
        text = text.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) text = jsonMatch[0];
        let result;
        try { result = JSON.parse(text); } catch (e) { return null; }
        if (!result || typeof result.refused !== 'boolean') return null;
        return result.refused;
    } catch (error) {
        return null;
    }
}

async function checkRefuseAndRetry(chat, reuseWrapper, options = {}) {
    const depth = options.refuseRetryDepth || 0;
    const lastIdx = chat.messages.length - 1;
    if (lastIdx < 0) return { refused: false, ok: true };
    const msg = chat.messages[lastIdx];
    if (!msg || msg.role !== 'assistant') return { refused: false, ok: true };

    const refused = await detectRefuse(msg);
    if (refused !== true) {
        if (refused === false) {
            msg.refuseChecked = true;
            msg._renderVersion = (msg._renderVersion || 0) + 1;
            saveState();
            if (chat.id === state.currentChatId) renderMessages();
        }
        return { refused: false, ok: true };
    }
    if (depth >= 2) {
        chat.messages.splice(lastIdx, 1);
        saveState();
        if (chat.id === state.currentChatId) renderMessages();
        return { refused: true, ok: false, result: { ok: false, aborted: false, failed: true, error: new Error('自动拒答重试已达上限') } };
    }
    showToast('检测到拒绝回答，正在自动重试...');
    chat.messages.splice(lastIdx, 1);
    saveState();
    const visibleWrapper = chat.id === state.currentChatId && reuseWrapper && reuseWrapper.isConnected ? reuseWrapper : undefined;
    const result = await autoRetryRefuse(chat, visibleWrapper, { ...options, refuseRetryDepth: depth + 1 });
    return { refused: true, ok: result.ok, result };
}

async function autoRetryRefuse(chat, wrapper, options = {}) {
    if (wrapper && wrapper.isConnected) {
        wrapper.classList.remove('bubble-reenter');
        wrapper.classList.add('bubble-resetting');
        await new Promise(resolve => {
            let done = false;
            const onEnd = () => {
                if (done) return;
                done = true;
                wrapper.removeEventListener('animationend', onEnd);
                resolve();
            };
            wrapper.addEventListener('animationend', onEnd);
            setTimeout(onEnd, 400);
        });
    }
    return await executeChatRequest(chat, null, {
        reuseWrapper: wrapper,
        suppressQueueAutoProcess: options.suppressQueueAutoProcess,
        refuseRetryDepth: options.refuseRetryDepth || 0,
        queueItemId: options.queueItemId
    });
}

async function generateTitle(chatId, text) {
    const modelToUse = state.titleModel || state.selectedModel;
    if (!modelToUse || !state.apiKey) return;
    try {
        const response = await fetch(`${API_BASE}/chat/completions`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.apiKey}` },
            body: JSON.stringify({ model: modelToUse, messages: [{ role: 'user', content: `生成简短标题（不超过10字！！不得超过10字！！），直接输出文本：\n${text}` }], stream: false })
        });
        if (response.ok) {
            const data = await response.json();
            let title = data.choices[0].message.content.trim().replace(/^['""'+]+|['"''']+$/g, '').replace(/[。，！.!,]+$/, '');
            if (title.length > 10) title = title.substring(0, 10);
            const chat = state.chats.find(c => c.id === chatId);
            if (chat && title) { chat.title = title; saveState(); renderChatList(); if(chat.id === state.currentChatId) DOM.chatHeaderTitle.textContent = title; }
        }
    } catch (error) {}
}
