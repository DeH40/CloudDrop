/**
 * CloudDrop - ChatMixin（mixin 方式挂载到 CloudDrop 类）
 */
import { i18n } from './i18n.js';
import * as ui from './ui.js';
import { debugLog } from './logger.js';
import { ERROR_CODES } from './config.js';

export const ChatMixin = {
  saveMessage(peerId, message) {
    if (!this.messageHistory.has(peerId)) {
      this.messageHistory.set(peerId, []);
    }
    this.messageHistory.get(peerId).push(message);
  },

  getMessageHistory(peerId) {
    return this.messageHistory.get(peerId) || [];
  },

  async sendTextMessage(peerId, text) {
    if (!text.trim()) return;

    try {
      await this.webrtc.sendText(peerId, text);
      this.saveMessage(peerId, { type: 'sent', text, timestamp: Date.now() });
      return true;
    } catch (e) {
      if (e.message === ERROR_CODES.MESSAGE_TOO_LARGE) {
        ui.showToast(i18n.t('errors.messageTooLarge'), 'error');
      } else {
        ui.showToast(i18n.t('toast.sendFailed', { error: e.message }), 'error');
      }
      return false;
    }
  },

  async sendImageMessage(peerId, imageDataUrl) {
    if (!imageDataUrl) return false;

    // 预算预检：与 compressImage 的 IMAGE_BUDGET(100000) 自洽，超限直接失败
    if (imageDataUrl.length > 100000) {
      ui.showToast(i18n.t('errors.messageTooLarge'), 'error');
      return false;
    }

    try {
      // Create message payload
      const payload = JSON.stringify({
        type: 'image',
        data: imageDataUrl
      });

      await this.webrtc.sendText(peerId, payload);
      this.saveMessage(peerId, {
        type: 'sent',
        messageType: 'image',
        imageData: imageDataUrl,
        timestamp: Date.now()
      });
      return true;
    } catch (e) {
      if (e.message === ERROR_CODES.MESSAGE_TOO_LARGE) {
        ui.showToast(i18n.t('errors.messageTooLarge'), 'error');
      } else {
        ui.showToast(i18n.t('chat.imageSendFailed', { error: e.message }), 'error');
      }
      return false;
    }
  },

  async compressImage(file, maxWidth = 1200, quality = 0.8) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          try {
            // 预算阶梯：优先保质量，超预算则逐步降质量、降尺寸。
            // 预算与 sendImageMessage 预检/MAX_TEXT_PAYLOAD 自洽：
            // dataURL 100KB → 加密+base64+JSON 后 ≈ 185KB < 200KB 客户端上限
            const IMAGE_BUDGET = 100000;
            const qualityLadder = [0.8, 0.55, 0.35];
            const widthLadder = [1200, 1000, 800];

            let result = null;

            for (const width of widthLadder) {
              for (const q of qualityLadder) {
                const scale = Math.min(1, width / img.width);
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(img.width * scale));
                canvas.height = Math.max(1, Math.round(img.height * scale));
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

                const dataUrl = canvas.toDataURL('image/jpeg', q);
                if (dataUrl.length <= IMAGE_BUDGET) {
                  result = dataUrl;
                  break;
                }
                // Keep the smallest candidate in case no step fits the budget
                if (!result || dataUrl.length < result.length) {
                  result = dataUrl;
                }
              }
              if (result && result.length <= IMAGE_BUDGET) break;
            }

            resolve(result);
          } catch (err) {
            reject(new Error(i18n.t('errors.imageLoadFailed')));
          }
        };
        img.onerror = () => reject(new Error(i18n.t('errors.imageLoadFailed')));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error(i18n.t('errors.fileReadFailed')));
      reader.readAsDataURL(file);
    });
  },

  async showImagePreview(file) {
    try {
      const dataUrl = await this.compressImage(file);
      this.pendingImage = { dataUrl, file };

      const preview = document.getElementById('chatImagePreview');
      const previewImg = document.getElementById('previewImage');

      previewImg.src = dataUrl;
      preview.style.display = 'block';
    } catch (e) {
      ui.showToast(i18n.t('chat.imagePreviewFailed', { error: e.message }), 'error');
    }
  },

  clearImagePreview() {
    this.pendingImage = null;
    const preview = document.getElementById('chatImagePreview');
    const previewImg = document.getElementById('previewImage');

    preview.style.display = 'none';
    previewImg.src = '';
  },

  showImageFullscreen(imageUrl) {
    const modal = document.getElementById('imageFullscreenModal');
    const img = document.getElementById('fullscreenImage');

    img.src = imageUrl;
    modal.classList.add('active');
  },

  openChatPanel(peer) {
    this.currentChatPeer = peer;
    document.getElementById('chatTitle').textContent = i18n.t('chat.titleWithPeer', { name: peer.name });
    this.renderChatHistory(peer.id);
    document.getElementById('chatPanel').classList.add('active');

    // Focus input after a short delay to ensure panel is visible
    setTimeout(() => {
      document.getElementById('chatInput')?.focus();
    }, 100);

    // Clear unread messages
    this.unreadMessages.set(peer.id, 0);
    this.updateUnreadBadge(peer.id);
  },

  closeChatPanel() {
    document.getElementById('chatPanel').classList.remove('active');
    this.currentChatPeer = null;
  },

  renderChatHistory(peerId, forceRebuild = false) {
    const messages = this.getMessageHistory(peerId);
    const container = document.getElementById('chatMessages');
    const renderedCount = this.renderedChatCounts.get(peerId) || 0;
    // 会话切换检测：两个会话消息数相同时，旧逻辑不会清空共享容器
    const peerChanged = this.renderedChatPeer !== peerId;

    // 空历史：清空容器后渲染一次空状态
    if (messages.length === 0) {
      if (container.children.length !== 0) container.innerHTML = '';
      if (container.children.length === 0) {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'chat-empty-state';
        emptyEl.innerHTML = `
          <div class="chat-empty-icon">${i18n.t('chat.emptyState.icon')}</div>
          <p class="chat-empty-text">${i18n.t('chat.emptyState.text')}</p>
          <p class="chat-empty-hint">${i18n.t('chat.emptyState.hint')}</p>
        `;
        container.appendChild(emptyEl);
      }
      this.renderedChatCounts.set(peerId, 0);
      this.renderedChatPeer = peerId;
      return;
    }

    // 需要全量重建：强制标记、会话切换、历史缩短或容器与计数不一致
    if (forceRebuild || peerChanged || renderedCount > messages.length || container.children.length !== renderedCount) {
      container.innerHTML = '';
      this.renderedChatCounts.set(peerId, 0);
    }

    // 增量追加新消息
    let current = this.renderedChatCounts.get(peerId) || 0;
    for (let i = current; i < messages.length; i++) {
      container.appendChild(this.buildChatMessageElement(peerId, messages[i], i));
    }
    this.renderedChatCounts.set(peerId, messages.length);
    this.renderedChatPeer = peerId;

    // Use requestAnimationFrame to ensure DOM is fully updated before scrolling
    // This handles async image loading and prevents race conditions
    requestAnimationFrame(() => {
      this.scrollChatToBottom(container);
    });
  },

  buildChatMessageElement(peerId, msg, index) {
    const msgEl = document.createElement('div');
    let statusClass = msg.type;
    if (msg.sending) statusClass += ' sending';
    if (msg.failed) statusClass += ' failed';
    msgEl.className = `chat-message ${statusClass}`;

    let statusText = this.formatTime(msg.timestamp);
    if (msg.sending) statusText = i18n.t('chat.sending');
    if (msg.failed) statusText = i18n.t('chat.failed');

    // Check if it's an image message
    if (msg.messageType === 'image' && msg.imageData) {
      // 防注入：仅接受 data:image/ 前缀的字符串，且通过 DOM 属性赋值，
      // 绝不把对端数据拼进 innerHTML
      const safeSrc = (typeof msg.imageData === 'string' &&
        msg.imageData.startsWith('data:image/') &&
        msg.imageData.length < 300000) ? msg.imageData : null;

      if (safeSrc) {
        const imgEl = document.createElement('img');
        imgEl.src = safeSrc;
        imgEl.alt = i18n.t('fileTypes.image');
        imgEl.loading = 'lazy';

        const wrapper = document.createElement('div');
        wrapper.className = 'chat-bubble-wrapper';

        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble chat-bubble-image';
        bubble.appendChild(imgEl);
        wrapper.appendChild(bubble);
        msgEl.appendChild(wrapper);

        // Add click handler for fullscreen view
        imgEl.addEventListener('click', () => {
          this.showImageFullscreen(safeSrc);
        });

        // Copy button
        const copyBtn = document.createElement('button');
        copyBtn.className = 'chat-copy-btn';
        copyBtn.title = i18n.t('chat.copyImage');
        copyBtn.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2"/>
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
          </svg>
        `;
        copyBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.copyImageToClipboard(safeSrc, copyBtn);
        });
        msgEl.appendChild(copyBtn);

        const time = document.createElement('div');
        time.className = 'chat-time';
        time.textContent = statusText;
        msgEl.appendChild(time);
      } else {
        // 非法图片数据：渲染为提示文本
        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble';
        bubble.textContent = i18n.t('chat.invalidImage');
        msgEl.appendChild(bubble);
      }
    } else {
      // Text message
      msgEl.innerHTML = `
        <div class="chat-bubble-wrapper">
          <div class="chat-bubble">${ui.escapeHtml(msg.text)}</div>
          <button class="chat-copy-btn" title="${i18n.t('chat.copyMessage')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2"/>
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
            </svg>
          </button>
        </div>
        <div class="chat-time">${statusText}</div>
      `;

      // Add copy button functionality
      const copyBtn = msgEl.querySelector('.chat-copy-btn');
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.copyMessageText(msg.text, copyBtn);
      });
    }

    // Add click event for retry on failed messages
    if (msg.failed && !msg.messageType) {
      msgEl.style.cursor = 'pointer';
      msgEl.addEventListener('click', () => this.retryMessage(peerId, index));
    }

    return msgEl;
  },

  scrollChatToBottom(container) {
    if (!container) {
      container = document.getElementById('chatMessages');
    }
    if (!container) return;

    // Immediate scroll
    container.scrollTop = container.scrollHeight;

    // Delayed scroll to handle image loading
    // This ensures images are loaded and scrollHeight is accurate
    setTimeout(() => {
      container.scrollTop = container.scrollHeight;
    }, 50);
  },

  formatTime(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);

    if (minutes < 1) return i18n.t('chat.justNow');
    if (minutes < 60) return i18n.t('chat.minutesAgo', { minutes });

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return i18n.t('chat.hoursAgo', { hours });

    const date = new Date(timestamp);
    return `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
  },

  async copyMessageText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      // Show success feedback
      btn.classList.add('copied');
      const originalTitle = btn.title;
      btn.title = i18n.t('common.copied');
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.title = originalTitle;
      }, 1500);
    } catch (e) {
      ui.showToast(i18n.t('toast.copyFailed'), 'error');
    }
  },

  async copyImageToClipboard(dataUrl, btn) {
    try {
      // Check if browser supports clipboard write
      if (!navigator.clipboard || !navigator.clipboard.write || typeof ClipboardItem === 'undefined') {
        ui.showToast(i18n.t('chat.copyNotSupported'), 'warning');
        return;
      }

      // Convert data URL to Blob
      const response = await fetch(dataUrl);
      const blob = await response.blob();

      // Copy as image
      const item = new ClipboardItem({
        [blob.type]: blob
      });
      await navigator.clipboard.write([item]);

      // Show success feedback
      btn.classList.add('copied');
      const originalTitle = btn.title;
      btn.title = i18n.t('common.copied');
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.title = originalTitle;
      }, 1500);
      ui.showToast(i18n.t('chat.imageCopied'), 'success');
    } catch (e) {
      console.error('Copy image failed:', e);
      ui.showToast(i18n.t('toast.copyFailed'), 'error');
    }
  },

  async retryMessage(peerId, messageIndex) {
    const messages = this.getMessageHistory(peerId);
    const msg = messages[messageIndex];

    if (!msg || !msg.failed) return;

    // Reset status to sending
    msg.failed = false;
    msg.sending = true;
    msg.timestamp = Date.now();
    this.renderChatHistory(peerId, true);

    try {
      await this.webrtc.sendText(peerId, msg.text);
      // Mark as sent
      msg.sending = false;
      this.renderChatHistory(peerId, true);
    } catch (e) {
      // Mark as failed again
      msg.sending = false;
      msg.failed = true;
      this.renderChatHistory(peerId, true);
      ui.showToast(i18n.t('toast.retryFailed', { error: e.message }), 'error');
    }
  },

  updateUnreadBadge(peerId) {
    const count = this.unreadMessages.get(peerId) || 0;
    const card = document.querySelector(`[data-peer-id="${peerId}"]`);
    if (!card) return;

    const button = card.querySelector('[data-action="message"]');
    if (!button) return;

    // Remove existing badge
    const existingBadge = button.querySelector('.unread-badge');
    if (existingBadge) existingBadge.remove();

    // Add new badge if count > 0
    if (count > 0) {
      const badge = document.createElement('span');
      badge.className = 'unread-badge';
      badge.textContent = count > 99 ? '99+' : count;
      button.appendChild(badge);
      button.classList.add('has-unread');
    } else {
      button.classList.remove('has-unread');
    }
  },

  showTextInputForSend() {
    if (this.peers.size === 0) {
      ui.showToast(i18n.t('toast.noDevices'), 'warning');
      return;
    }

    if (this.peers.size === 1) {
      const [, peer] = [...this.peers.entries()][0];
      this.selectedPeer = peer;
      document.getElementById('textInput').value = '';
      ui.showModal('textModal');
    } else {
      ui.showToast(i18n.t('toast.selectDeviceForText'), 'info');
    }
  },
};
