/**
 * CloudDrop - Main Application
 */

import { WebRTCManager } from './webrtc.js';
import { cryptoManager } from './crypto.js';
import * as ui from './ui.js';

class CloudDrop {
  constructor() {
    this.peerId = null;
    this.peers = new Map();
    this.ws = null;
    this.webrtc = null;
    this.selectedPeer = null;
    
    // Try to get saved name from localStorage, otherwise generate new one
    const savedName = localStorage.getItem('clouddrop_device_name');
    this.deviceName = savedName || ui.generateDisplayName();
    if (!savedName) {
      localStorage.setItem('clouddrop_device_name', this.deviceName);
    }
    
    this.deviceType = ui.detectDeviceType();
    this.roomCode = null;
    this.browserInfo = ui.getDetailedDeviceInfo();
    this.messageHistory = new Map(); // peerId -> messages array
    this.currentChatPeer = null; // Currently viewing chat history
    this.unreadMessages = new Map(); // peerId -> unread count
  }

  async init() {
    await cryptoManager.generateKeyPair();
    // Check URL for room code
    const params = new URLSearchParams(location.search);
    this.roomCode = params.get('room') || this.generateRoomCode();
    this.updateRoomDisplay();
    this.connectWebSocket();
    this.setupEventListeners();
    ui.setupModalCloseHandlers();
    ui.updateEmptyState();
    this.updateDeviceNameDisplay();
    this.setupKeyboardDetection();
    this.setupVisualViewport();
  }

  generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }

  updateRoomDisplay() {
    const el = document.getElementById('roomCode');
    if (el) el.textContent = this.roomCode;
  }

  connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws?room=${this.roomCode}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      ui.updateConnectionStatus('connected', '已连接');
      
      // Clear existing peers on reconnect to avoid duplicates
      this.peers.clear();
      ui.clearPeersGrid(document.getElementById('peersGrid'));
      this.webrtc?.closeAll(); // Also close stale WebRTC connections
      
      this.ws.send(JSON.stringify({
        type: 'join',
        data: {
          name: this.deviceName,
          deviceType: this.deviceType,
          browserInfo: this.browserInfo
        }
      }));
    };

    this.ws.onmessage = (e) => this.handleSignaling(JSON.parse(e.data));

    this.ws.onclose = () => {
      ui.updateConnectionStatus('disconnected', '已断开');
      setTimeout(() => this.connectWebSocket(), 3000);
    };

    this.ws.onerror = () => ui.updateConnectionStatus('disconnected', '连接错误');

    this.webrtc = new WebRTCManager({
      send: (msg) => this.ws.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify(msg))
    });

    this.webrtc.onProgress = (p) => ui.updateTransferProgress({
      fileName: p.fileName, fileSize: p.fileSize, percent: p.percent, speed: p.speed
    });

    this.webrtc.onFileReceived = (peerId, name, blob) => {
      ui.hideModal('transferModal');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; a.click();
      URL.revokeObjectURL(url);
      ui.showToast(`已接收: ${name}`, 'success');
    };

    this.webrtc.onFileRequest = (peerId, info) => {
      const peer = this.peers.get(peerId);
      document.getElementById('receivePrompt').textContent = 
        `${peer?.name || '未知设备'} 想发送 "${info.name}" (${ui.formatFileSize(info.size)})`;
      ui.showReceivingModal(info.name, info.size);
    };

    this.webrtc.onTextReceived = (peerId, text) => {
      this.saveMessage(peerId, { type: 'received', text, timestamp: Date.now() });
      
      // If chat panel is open for this peer, update UI immediately
      if (this.currentChatPeer && this.currentChatPeer.id === peerId) {
        this.renderChatHistory(peerId);
        // Play a subtle sound? (Optional)
        return; 
      }
      
      // Update unread count
      const currentUnread = this.unreadMessages.get(peerId) || 0;
      this.unreadMessages.set(peerId, currentUnread + 1);
      this.updateUnreadBadge(peerId);
      
      // Show toast notification
      const peer = this.peers.get(peerId);
      ui.showToast(`${peer?.name || '未知设备'}: ${text.substring(0, 30)}${text.length > 30 ? '...' : ''}`, 'info');
    };

    // Connection state change handler
    this.webrtc.onConnectionStateChange = ({ peerId, status, message }) => {
      const toastId = `connection-${peerId}`;
      
      switch (status) {
        case 'connecting':
          ui.showPersistentToast(toastId, message, 'loading');
          break;
        case 'slow':
          ui.updatePersistentToast(toastId, message, 'warning');
          break;
        case 'relay':
          ui.hidePersistentToast(toastId);
          ui.showToast(message, 'info');
          break;
        case 'connected':
          ui.hidePersistentToast(toastId);
          break;
      }
    };
  }

  handleSignaling(msg) {
    console.log('[Signaling] Received:', msg.type, msg);
    switch (msg.type) {
      case 'joined':
        this.peerId = msg.peerId;
        console.log('[Signaling] My peer ID:', this.peerId);
        // Set peer ID for Perfect Negotiation pattern
        this.webrtc.setMyPeerId(this.peerId);
        msg.peers?.forEach(p => this.addPeer(p));
        break;
      case 'peer-joined':
        this.addPeer(msg.data);
        ui.showToast(`${msg.data.name} 已加入`, 'info');
        break;
      case 'peer-left':
        this.removePeer(msg.data.id);
        break;
      case 'offer':
        this.webrtc.handleOffer(msg.from, msg.data);
        break;
      case 'answer':
        this.webrtc.handleAnswer(msg.from, msg.data);
        break;
      case 'ice-candidate':
        this.webrtc.handleIceCandidate(msg.from, msg.data);
        break;
      case 'relay-data':
        this.webrtc.handleRelayData(msg.from, msg.data);
        break;
      case 'name-changed':
        this.handleNameChanged(msg.from, msg.data.name);
        break;
    }
  }

  addPeer(peer) {
    this.peers.set(peer.id, peer);
    ui.addPeerToGrid(peer, document.getElementById('peersGrid'), (p, e) => this.onPeerClick(p, e));
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) ui.showToast(`${peer.name} 已离开`, 'info');
    this.peers.delete(peerId);
    ui.removePeerFromGrid(peerId, document.getElementById('peersGrid'));
    this.webrtc.closeConnection(peerId);
  }

  updateDeviceNameDisplay() {
    document.getElementById('deviceName').textContent = this.deviceName;
  }

  updateDeviceName(newName) {
    this.deviceName = newName;
    localStorage.setItem('clouddrop_device_name', newName);
    this.updateDeviceNameDisplay();
    
    // Broadcast name change to all peers
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'name-changed',
        data: { name: newName }
      }));
    }
    
    ui.showToast('设备名称已更新', 'success');
  }

  handleNameChanged(peerId, newName) {
    const peer = this.peers.get(peerId);
    if (peer) {
      const oldName = peer.name;
      peer.name = newName;
      
      // Update the peer card
      const card = document.querySelector(`[data-peer-id="${peerId}"]`);
      if (card) {
        const nameEl = card.querySelector('.peer-name');
        if (nameEl) nameEl.textContent = newName;
      }
      
      ui.showToast(`${oldName} 改名为 ${newName}`, 'info');
    }
  }

  onPeerClick(peer, e) {
    // If message button was clicked, open chat panel
    if (e && e.target.closest('[data-action="message"]')) {
      if (e.stopPropagation) e.stopPropagation();
      this.openChatPanel(peer);
      return;
    }

    // Default: select file
    this.selectedPeer = peer;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = () => this.sendFiles(peer.id, Array.from(input.files));
    input.click();
  }

  async sendFiles(peerId, files) {
    for (const file of files) {
      ui.showSendingModal(file.name, file.size);
      try {
        await this.webrtc.sendFile(peerId, file);
        ui.hideModal('transferModal');
        ui.showToast(`已发送: ${file.name}`, 'success');
      } catch (e) {
        ui.hideModal('transferModal');
        ui.showToast(`发送失败: ${e.message}`, 'error');
      }
    }
  }

  joinRoom(code) {
    if (!code || !/^[a-zA-Z0-9]{4,16}$/.test(code)) {
      ui.showToast('房间号格式无效 (4-16位字母数字)', 'error');
      return;
    }
    // Navigate to new room
    const url = new URL(location.href);
    url.searchParams.set('room', code.toUpperCase());
    location.href = url.toString();
  }

  saveMessage(peerId, message) {
    if (!this.messageHistory.has(peerId)) {
      this.messageHistory.set(peerId, []);
    }
    this.messageHistory.get(peerId).push(message);
  }

  getMessageHistory(peerId) {
    return this.messageHistory.get(peerId) || [];
  }

  async sendTextMessage(peerId, text) {
    if (!text.trim()) return;
    
    try {
      await this.webrtc.sendText(peerId, text);
      this.saveMessage(peerId, { type: 'sent', text, timestamp: Date.now() });
      return true;
    } catch (e) {
      ui.showToast(`发送失败: ${e.message}`, 'error');
      return false;
    }
  }

  openChatPanel(peer) {
    this.currentChatPeer = peer;
    document.getElementById('chatTitle').textContent = `与 ${peer.name} 的消息`;
    this.renderChatHistory(peer.id);
    document.getElementById('chatPanel').classList.add('active');
    document.getElementById('chatInput').focus();
    
    // Clear unread messages
    this.unreadMessages.set(peer.id, 0);
    this.updateUnreadBadge(peer.id);
  }

  closeChatPanel() {
    document.getElementById('chatPanel').classList.remove('active');
    this.currentChatPeer = null;
  }

  renderChatHistory(peerId) {
    const messages = this.getMessageHistory(peerId);
    const container = document.getElementById('chatMessages');
    container.innerHTML = '';
    
    if (messages.length === 0) {
      // Empty state
      const emptyEl = document.createElement('div');
      emptyEl.className = 'chat-empty-state';
      emptyEl.innerHTML = `
        <div class="chat-empty-icon">💬</div>
        <p class="chat-empty-text">还没有消息</p>
        <p class="chat-empty-hint">在下方输入框发送第一条消息吧</p>
      `;
      container.appendChild(emptyEl);
      return;
    }
    
    messages.forEach(msg => {
      const msgEl = document.createElement('div');
      let statusClass = msg.type;
      if (msg.sending) statusClass += ' sending';
      if (msg.failed) statusClass += ' failed';
      msgEl.className = `chat-message ${statusClass}`;
      
      let statusText = this.formatTime(msg.timestamp);
      if (msg.sending) statusText = '发送中...';
      if (msg.failed) statusText = '发送失败 · 点击重试';
      
      msgEl.innerHTML = `
        <div class="chat-bubble">${ui.escapeHtml(msg.text)}</div>
        <div class="chat-time">${statusText}</div>
      `;
      container.appendChild(msgEl);
    });
    
    // Scroll to bottom
    container.scrollTop = container.scrollHeight;
  }

  formatTime(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes}分钟前`;
    
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时前`;
    
    const date = new Date(timestamp);
    return `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

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
  }

  setupEventListeners() {
    const app = document.getElementById('app');
    let dragCounter = 0;

    app.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragCounter++;
      if (this.peers.size > 0) ui.showDropZone();
    });

    app.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter === 0) ui.hideDropZone();
    });

    app.addEventListener('dragover', (e) => e.preventDefault());

    app.addEventListener('drop', (e) => {
      e.preventDefault();
      dragCounter = 0;
      ui.hideDropZone();
      const files = Array.from(e.dataTransfer.files);
      if (files.length && this.peers.size === 1) {
        const [peerId] = this.peers.keys();
        this.sendFiles(peerId, files);
      } else if (files.length && this.peers.size > 1) {
        ui.showToast('请点击目标设备发送文件', 'warning');
      }
    });

    // Room code copy
    document.getElementById('copyRoomCode')?.addEventListener('click', () => {
      navigator.clipboard.writeText(this.roomCode);
      this.triggerHaptic('light');
      ui.showToast('房间号已复制', 'success');
    });

    // Mobile bottom navigation
    this.setupMobileNavigation();
    
    // Empty state actions
    this.setupEmptyStateActions();

    // Edit device name
    document.getElementById('editDeviceName')?.addEventListener('click', () => {
      document.getElementById('nameInput').value = this.deviceName;
      ui.showModal('editNameModal');
      document.getElementById('nameInput').focus();
    });

    document.getElementById('editNameConfirm')?.addEventListener('click', () => {
      const newName = document.getElementById('nameInput').value.trim();
      if (newName && newName !== this.deviceName) {
        this.updateDeviceName(newName);
      }
      ui.hideModal('editNameModal');
    });

    document.getElementById('editNameCancel')?.addEventListener('click', () => {
      ui.hideModal('editNameModal');
    });

    document.getElementById('editNameModalClose')?.addEventListener('click', () => {
      ui.hideModal('editNameModal');
    });

    // Join room button
    document.getElementById('joinRoomBtn')?.addEventListener('click', () => {
      document.getElementById('roomInput').value = '';
      ui.showModal('joinRoomModal');
    });

    // Join room modal
    document.getElementById('joinRoomModalClose')?.addEventListener('click', () => ui.hideModal('joinRoomModal'));
    document.getElementById('joinRoomCancel')?.addEventListener('click', () => ui.hideModal('joinRoomModal'));
    document.getElementById('joinRoomConfirm')?.addEventListener('click', () => {
      const code = document.getElementById('roomInput').value.trim();
      this.joinRoom(code);
    });
    document.getElementById('roomInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const code = document.getElementById('roomInput').value.trim();
        this.joinRoom(code);
      }
    });

    // Modal close buttons
    document.getElementById('modalClose')?.addEventListener('click', () => ui.hideModal('transferModal'));
    document.getElementById('receiveModalClose')?.addEventListener('click', () => ui.hideModal('receiveModal'));
    document.getElementById('receiveDecline')?.addEventListener('click', () => ui.hideModal('receiveModal'));
    document.getElementById('receiveAccept')?.addEventListener('click', () => ui.hideModal('receiveModal'));

    // Text modal
    document.getElementById('textModalClose')?.addEventListener('click', () => ui.hideModal('textModal'));
    document.getElementById('textCancel')?.addEventListener('click', () => ui.hideModal('textModal'));
    document.getElementById('textSend')?.addEventListener('click', async () => {
      const text = document.getElementById('textInput').value.trim();
      if (text && this.selectedPeer) {
        const success = await this.sendTextMessage(this.selectedPeer.id, text);
        if (success) {
          document.getElementById('textInput').value = '';
          ui.hideModal('textModal');
          ui.showToast('消息已发送', 'success');
        }
      }
    });

    // Received text modal
    document.getElementById('receivedTextModalClose')?.addEventListener('click', () => ui.hideModal('receivedTextModal'));
    document.getElementById('closeReceivedText')?.addEventListener('click', () => ui.hideModal('receivedTextModal'));
    document.getElementById('copyText')?.addEventListener('click', () => {
      const text = document.getElementById('receivedText').textContent;
      navigator.clipboard.writeText(text);
      ui.showToast('已复制到剪贴板', 'success');
    });

    // Chat panel events
    document.getElementById('closeChatPanel')?.addEventListener('click', () => this.closeChatPanel());
    
    document.getElementById('sendChatMessage')?.addEventListener('click', async () => {
      if (!this.currentChatPeer) return;
      const input = document.getElementById('chatInput');
      const btn = document.getElementById('sendChatMessage');
      const text = input.value.trim();
      if (!text) return;
      
      // Optimistic UI: show message immediately with sending state
      const tempMessage = { type: 'sent', text, timestamp: Date.now(), sending: true };
      this.saveMessage(this.currentChatPeer.id, tempMessage);
      this.renderChatHistory(this.currentChatPeer.id);
      
      // Disable input and show loading state
      input.value = '';
      input.disabled = true;
      btn.disabled = true;
      btn.classList.add('sending');
      
      try {
        await this.webrtc.sendText(this.currentChatPeer.id, text);
        // Mark message as sent
        tempMessage.sending = false;
        this.renderChatHistory(this.currentChatPeer.id);
      } catch (e) {
        // Mark message as failed
        tempMessage.failed = true;
        tempMessage.sending = false;
        this.renderChatHistory(this.currentChatPeer.id);
        ui.showToast(`发送失败: ${e.message}`, 'error');
      } finally {
        // Re-enable input
        input.disabled = false;
        btn.disabled = false;
        btn.classList.remove('sending');
        input.focus();
      }
    });
    
    document.getElementById('chatInput')?.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const btn = document.getElementById('sendChatMessage');
        if (btn) btn.click();
      }
    });
  }

  // Mobile navigation setup
  setupMobileNavigation() {
    // Bottom nav buttons
    document.getElementById('navDevices')?.addEventListener('click', () => {
      this.triggerHaptic('light');
      // Scroll to peers grid
      document.getElementById('peersGrid')?.scrollIntoView({ behavior: 'smooth' });
    });

    document.getElementById('navRoom')?.addEventListener('click', () => {
      this.triggerHaptic('light');
      this.showMobileShareModal();
    });

    document.getElementById('navSend')?.addEventListener('click', () => {
      this.triggerHaptic('medium');
      this.showQuickActions();
    });

    document.getElementById('navShare')?.addEventListener('click', () => {
      this.triggerHaptic('light');
      this.showMobileShareModal();
    });

    document.getElementById('navSettings')?.addEventListener('click', () => {
      this.triggerHaptic('light');
      this.showMobileSettings();
    });

    // Quick actions panel
    document.getElementById('quickActionClose')?.addEventListener('click', () => {
      this.hideQuickActions();
    });

    document.getElementById('quickSendFile')?.addEventListener('click', () => {
      this.triggerHaptic('light');
      this.hideQuickActions();
      this.selectFileToSend();
    });

    document.getElementById('quickSendText')?.addEventListener('click', () => {
      this.triggerHaptic('light');
      this.hideQuickActions();
      this.showTextInputForSend();
    });

    // Mobile settings panel
    document.getElementById('mobileSettingsClose')?.addEventListener('click', () => {
      ui.hideModal('mobileSettingsModal');
    });

    document.getElementById('settingsEditName')?.addEventListener('click', () => {
      ui.hideModal('mobileSettingsModal');
      document.getElementById('nameInput').value = this.deviceName;
      ui.showModal('editNameModal');
    });

    document.getElementById('settingsCopyRoom')?.addEventListener('click', () => {
      navigator.clipboard.writeText(this.roomCode);
      this.triggerHaptic('light');
      ui.showToast('房间号已复制', 'success');
    });

    // Mobile share panel
    document.getElementById('mobileShareClose')?.addEventListener('click', () => {
      ui.hideModal('mobileShareModal');
    });

    document.getElementById('shareCopyLink')?.addEventListener('click', () => {
      const url = new URL(location.href);
      url.searchParams.set('room', this.roomCode);
      navigator.clipboard.writeText(url.toString());
      this.triggerHaptic('light');
      ui.showToast('链接已复制', 'success');
    });

    document.getElementById('shareNative')?.addEventListener('click', async () => {
      if (navigator.share) {
        try {
          const url = new URL(location.href);
          url.searchParams.set('room', this.roomCode);
          await navigator.share({
            title: 'CloudDrop - 加入房间',
            text: `加入房间 ${this.roomCode} 来互传文件`,
            url: url.toString()
          });
          this.triggerHaptic('medium');
        } catch (e) {
          if (e.name !== 'AbortError') {
            ui.showToast('分享失败', 'error');
          }
        }
      } else {
        ui.showToast('您的浏览器不支持分享功能', 'warning');
      }
    });

    // Close quick actions when clicking outside
    document.getElementById('mobileQuickActions')?.addEventListener('click', (e) => {
      if (e.target.id === 'mobileQuickActions') {
        this.hideQuickActions();
      }
    });
  }

  // Empty state actions setup
  setupEmptyStateActions() {
    document.getElementById('emptyShareRoom')?.addEventListener('click', () => {
      this.triggerHaptic('light');
      this.showMobileShareModal();
    });

    document.getElementById('emptyJoinRoom')?.addEventListener('click', () => {
      this.triggerHaptic('light');
      document.getElementById('roomInput').value = '';
      ui.showModal('joinRoomModal');
    });
  }

  // Show quick actions panel
  showQuickActions() {
    if (this.peers.size === 0) {
      ui.showToast('没有可用的设备', 'warning');
      return;
    }
    
    const panel = document.getElementById('mobileQuickActions');
    if (panel) {
      panel.classList.add('active');
    }
  }

  // Hide quick actions panel
  hideQuickActions() {
    const panel = document.getElementById('mobileQuickActions');
    if (panel) {
      panel.classList.remove('active');
    }
  }

  // Show mobile settings
  showMobileSettings() {
    document.getElementById('settingsDeviceName').textContent = this.deviceName;
    document.getElementById('settingsRoomCode').textContent = this.roomCode;
    
    const statusEl = document.getElementById('settingsStatus');
    const statusTextEl = document.getElementById('settingsStatusText');
    const mainStatusEl = document.getElementById('connectionStatus');
    
    if (statusEl && mainStatusEl) {
      statusEl.className = 'settings-value';
      const dotEl = statusEl.querySelector('.status-dot');
      if (dotEl) {
        dotEl.style.background = mainStatusEl.classList.contains('connected') 
          ? 'var(--status-success)' 
          : mainStatusEl.classList.contains('disconnected')
            ? 'var(--status-error)'
            : 'var(--status-warning)';
      }
    }
    
    if (statusTextEl) {
      statusTextEl.textContent = mainStatusEl?.classList.contains('connected') 
        ? '已连接' 
        : mainStatusEl?.classList.contains('disconnected')
          ? '已断开'
          : '连接中...';
    }
    
    ui.showModal('mobileSettingsModal');
  }

  // Show mobile share modal
  showMobileShareModal() {
    document.getElementById('shareRoomCode').textContent = this.roomCode;
    ui.showModal('mobileShareModal');
  }

  // Select file to send (for mobile)
  selectFileToSend() {
    if (this.peers.size === 0) {
      ui.showToast('没有可用的设备', 'warning');
      return;
    }

    if (this.peers.size === 1) {
      // Single peer, directly select file
      const [peerId] = this.peers.keys();
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.onchange = () => this.sendFiles(peerId, Array.from(input.files));
      input.click();
    } else {
      // Multiple peers, show selection first
      ui.showToast('请点击目标设备来发送文件', 'info');
    }
  }

  // Show text input for sending
  showTextInputForSend() {
    if (this.peers.size === 0) {
      ui.showToast('没有可用的设备', 'warning');
      return;
    }

    if (this.peers.size === 1) {
      const [peerId, peer] = [...this.peers.entries()][0];
      this.selectedPeer = peer;
      document.getElementById('textInput').value = '';
      ui.showModal('textModal');
    } else {
      ui.showToast('请点击目标设备上的消息按钮来发送文字', 'info');
    }
  }

  // Haptic feedback
  triggerHaptic(intensity = 'light') {
    if ('vibrate' in navigator) {
      switch (intensity) {
        case 'light':
          navigator.vibrate(10);
          break;
        case 'medium':
          navigator.vibrate(25);
          break;
        case 'heavy':
          navigator.vibrate([30, 10, 30]);
          break;
      }
    }
  }

  // Setup keyboard detection for mobile
  setupKeyboardDetection() {
    // Use focus/blur events to detect keyboard
    const inputs = document.querySelectorAll('input, textarea');
    
    inputs.forEach(input => {
      input.addEventListener('focus', () => {
        // Small delay to let keyboard animate
        setTimeout(() => {
          document.documentElement.classList.add('keyboard-visible');
        }, 100);
      });
      
      input.addEventListener('blur', () => {
        setTimeout(() => {
          document.documentElement.classList.remove('keyboard-visible');
        }, 100);
      });
    });
  }

  // Setup visual viewport handling for iOS
  setupVisualViewport() {
    if (window.visualViewport) {
      const viewport = window.visualViewport;
      
      const handleViewportChange = () => {
        // Calculate keyboard height
        const keyboardHeight = window.innerHeight - viewport.height;
        
        if (keyboardHeight > 100) {
          // Keyboard is visible
          document.documentElement.style.setProperty('--keyboard-height', `${keyboardHeight}px`);
          document.documentElement.classList.add('keyboard-visible');
          
          // Scroll active element into view
          const activeElement = document.activeElement;
          if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')) {
            setTimeout(() => {
              activeElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 100);
          }
        } else {
          // Keyboard is hidden
          document.documentElement.style.setProperty('--keyboard-height', '0px');
          document.documentElement.classList.remove('keyboard-visible');
        }
      };
      
      viewport.addEventListener('resize', handleViewportChange);
      viewport.addEventListener('scroll', handleViewportChange);
    }
  }
}

// Initialize app
const app = new CloudDrop();
app.init().catch(console.error);

