/**
 * CloudDrop - Main Application
 */

import { WebRTCManager } from './webrtc.js';
import { cryptoManager } from './crypto.js';
import * as ui from './ui.js';
import { STORAGE_KEYS, ROOM, DEFAULT_SETTINGS, ERROR_CODES } from './config.js';
import { i18n } from './i18n.js';
import { debugLog } from './logger.js';
import { ChatMixin } from './chat.js';
import { SettingsMixin } from './settings.js';

class CloudDrop {
  constructor() {
    this.peerId = null;
    this.peers = new Map();
    this.ws = null;
    this.webrtc = null;
    this.selectedPeer = null;

    // Try to get saved name from localStorage, otherwise generate new one
    const savedName = localStorage.getItem(STORAGE_KEYS.DEVICE_NAME);
    this.deviceName = savedName || ui.generateDisplayName();
    if (!savedName) {
      localStorage.setItem(STORAGE_KEYS.DEVICE_NAME, this.deviceName);
    }

    this.deviceType = ui.detectDeviceType();
    this.roomCode = null;
    this.browserInfo = ui.getDetailedDeviceInfo();
    this.messageHistory = new Map(); // peerId -> messages array
    this.renderedChatCounts = new Map(); // peerId -> 已渲染消息数（增量渲染）
    this.currentChatPeer = null; // Currently viewing chat history
    this.unreadMessages = new Map(); // peerId -> unread count
    this.pendingFileRequest = null; // Current pending file request waiting for user decision
    this.currentTransfer = null; // Current active transfer { peerId, fileId, fileName, direction }
    this.pendingImage = null; // Pending image to send { dataUrl, file }

    // Trusted devices - auto-accept files from these devices
    this.trustedDevices = this.loadTrustedDevices();

    // 设备身份验证（防伪造信任）
    this.identityChallenges = new Map(); // nonce -> { resolve, timeout, peerId }
    this.verifiedPeers = new Set(); // 本会话已通过身份验证的 peerId

    // App settings
    this.settings = this.loadSettings();

    // Theme handling
    this.themeMediaQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    this.handleSystemThemeChange = (e) => {
      if (this.settings.theme === 'system') {
        this.applyTheme(e.matches ? 'dark' : 'light');
      }
    };
    if (this.themeMediaQuery) {
      if (this.themeMediaQuery.addEventListener) {
        this.themeMediaQuery.addEventListener('change', this.handleSystemThemeChange);
      } else if (this.themeMediaQuery.addListener) {
        this.themeMediaQuery.addListener(this.handleSystemThemeChange);
      }
    }

    // Room password state
    this.roomPassword = null; // Room password (plaintext, only in memory)
    this.roomPasswordHash = null; // Password hash for server verification
    this.isSecureRoom = false; // Whether current room is password-protected

    // Reconnect state (exponential backoff, paused while page hidden)
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.reconnectPending = false;
  }

  /**
   * 加载应用设置
   */

  /**
   * 保存应用设置
   */

  /**
   * 更新单个设置项
   * @param {string} key - 设置键名
   * @param {*} value - 设置值
   */

  /**
   * 限制超时值在有效范围内
   * @param {number} value - 输入值
   * @returns {number} - 限制后的值（1-60秒）
   */

  /**
   * 将设置应用到 WebRTC 模块
   */

  /**
   * 应用所有设置到 WebRTC（初始化时调用）
   */

  /**
   * Apply theme setting to document
   */

  /**
   * Resolve theme to light/dark
   */

  /**
   * Apply the resolved theme
   */

  /**
   * Update browser theme-color meta
   */

  /**
   * Load trusted devices from localStorage
   * Stores device fingerprint (name + deviceType + browserInfo hash)
   */

  /**
   * Save trusted devices to localStorage
   */

  /**
   * 生成设备指纹（用于信任识别）
   * 优先用持久设备公钥（防伪造）；旧客户端无密钥时回退旧指纹
   */

  /**
   * 旧版指纹：名字+设备类型+浏览器信息（可伪造，仅用于向后兼容）
   */

  /**
   * 简单字符串哈希（指纹用，非安全用途）
   */

  /**
   * Check if a device is trusted
   * 密钥指纹不匹配时回退旧指纹（兼容升级前已信任的设备）
   */

  /**
   * Trust a device (auto-accept files from it)
   */

  /**
   * Untrust a device
   */

  /**
   * 验证对方确实持有其声明的设备私钥（挑战-签名）
   * @param {object} peer - 设备信息（需包含 deviceKey）
   * @returns {Promise<boolean>}
   */
  async verifyPeerIdentity(peer) {
    if (!peer.deviceKey) return true; // 旧客户端无密钥：按旧信任逻辑处理
    if (this.verifiedPeers.has(peer.id)) return true;

    const nonce = crypto.randomUUID();

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.identityChallenges.delete(nonce);
        console.warn(`[App] 身份验证超时: ${peer.name}`);
        resolve(false);
      }, 3000);

      this.identityChallenges.set(nonce, { resolve, timeout, peerId: peer.id });

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'identity-challenge',
          to: peer.id,
          data: { nonce }
        }));
      } else {
        clearTimeout(timeout);
        this.identityChallenges.delete(nonce);
        resolve(false);
      }
    });
  }

  /**
   * 收到身份挑战：用设备私钥对 (nonce + 挑战方公钥) 签名并回包
   */
  async handleIdentityChallenge(fromPeerId, data) {
    const { nonce } = data || {};
    if (!nonce) return;

    const peer = this.peers.get(fromPeerId);
    const payload = `${nonce}:${peer?.deviceKey || ''}`;

    try {
      const signature = await cryptoManager.signIdentityChallenge(payload);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'identity-response',
          to: fromPeerId,
          data: { nonce, signature }
        }));
      }
    } catch (e) {
      console.warn('[App] 身份签名失败:', e);
    }
  }

  /**
   * 收到身份响应：验证签名，完成信任检查
   */
  async handleIdentityResponse(fromPeerId, data) {
    const { nonce, signature } = data || {};
    const pending = this.identityChallenges.get(nonce);
    if (!pending) return;
    if (pending.peerId !== fromPeerId) return; // 响应必须来自被挑战方

    clearTimeout(pending.timeout);
    this.identityChallenges.delete(nonce);

    const peer = this.peers.get(fromPeerId);
    if (!peer?.deviceKey) {
      pending.resolve(false);
      return;
    }

    try {
      const myDeviceKey = await cryptoManager.getDevicePublicKey();
      const payload = `${nonce}:${myDeviceKey}`;
      const valid = await cryptoManager.verifyIdentityChallenge(peer.deviceKey, payload, signature);
      if (valid) this.verifiedPeers.add(fromPeerId);
      pending.resolve(valid);
    } catch (e) {
      console.warn('[App] 身份签名验证失败:', e);
      pending.resolve(false);
    }
  }

  /**
   * Update trusted badge on peer card
   */

  /**
   * Get list of all trusted devices
   */

  /**
   * Remove a trusted device by fingerprint
   */

  /**
   * Create a secure room with password
   * @param {string} roomCode - Room code
   * @param {string} password - Room password (min 6 characters)
   */
  async createSecureRoom(roomCode, password) {
    // Validate password
    if (!password || password.length < ROOM.PASSWORD_MIN_LENGTH) {
      ui.showToast(i18n.t('room.passwordMinLength'), 'error');
      return false;
    }

    // Validate room code
    if (!roomCode || !ROOM.CODE_PATTERN.test(roomCode)) {
      ui.showToast(i18n.t('room.invalidCode'), 'error');
      return false;
    }

    try {
      // Generate password hash for server
      const passwordHash = await cryptoManager.hashPasswordForServer(password, roomCode);

      // Set room password on server
      const response = await fetch(`/api/room/set-password?room=${roomCode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passwordHash })
      });

      const result = await response.json();

      if (!result.success) {
        ui.showToast(i18n.t('errors.connectionFailed'), 'error');
        return false;
      }

      // Set room password for client-side encryption
      await cryptoManager.setRoomPassword(password, roomCode);

      // Store password info locally
      this.roomPassword = password;
      this.roomPasswordHash = passwordHash;
      this.isSecureRoom = true;

      // Update security badge
      this.updateRoomSecurityBadge();

      debugLog('[App] Secure room created:', roomCode);
      return true;
    } catch (error) {
      console.error('[App] Failed to create secure room:', error);
      ui.showToast(i18n.t('errors.connectionFailed'), 'error');
      return false;
    }
  }

  /**
   * Check if a room requires password
   * @param {string} roomCode - Room code
   * @returns {Promise<boolean>} - true if password required
   */
  async checkRoomPassword(roomCode) {
    try {
      const response = await fetch(`/api/room/check-password?room=${roomCode}`);
      const result = await response.json();
      return result.hasPassword || false;
    } catch (error) {
      console.error('[App] Failed to check room password:', error);
      return false;
    }
  }

  /**
   * Join a secure room with password
   * @param {string} roomCode - Room code
   * @param {string} password - Room password
   */
  async joinSecureRoom(roomCode, password) {
    if (!password) {
      ui.showToast(i18n.t('room.passwordRequired'), 'error');
      return false;
    }

    // Normalize roomCode to uppercase (must match creation)
    const normalizedRoomCode = roomCode.toUpperCase();

    try {
      // Generate password hash (using normalized room code)
      const passwordHash = await cryptoManager.hashPasswordForServer(password, normalizedRoomCode);

      // Set room password for client-side encryption
      await cryptoManager.setRoomPassword(password, normalizedRoomCode);

      // Store password info
      this.roomPassword = password;
      this.roomPasswordHash = passwordHash;
      this.isSecureRoom = true;

      // Update security badge
      this.updateRoomSecurityBadge();

      debugLog('[App] Joining secure room:', normalizedRoomCode);
      return true;
    } catch (error) {
      console.error('[App] Failed to prepare for secure room:', error);
      ui.showToast(i18n.t('room.passwordError'), 'error');
      return false;
    }
  }

  /**
   * Clear room password (when leaving secure room)
   */
  clearRoomPassword() {
    this.roomPassword = null;
    this.roomPasswordHash = null;
    this.isSecureRoom = false;
    cryptoManager.clearRoomPassword();
    this.updateRoomSecurityBadge();
    debugLog('[App] Room password cleared');
  }

  async init() {
    // Apply theme as early as possible
    this.applyThemeSetting();

    // Initialize i18n first
    await i18n.init({ defaultLocale: 'zh' });

    // Setup language switcher early so it's available during connection
    this.setupLanguageSwitcher();

    await cryptoManager.generateKeyPair();
    // Check URL for room code - only use explicit room parameter
    // If no room param, let server assign room based on IP
    const params = new URLSearchParams(location.search);
    const roomParam = params.get('room');
    this.roomCode = roomParam ? roomParam.toUpperCase() : null; // Normalize to uppercase

    // If joining a specific room, check if it requires password
    if (this.roomCode) {
      const requiresPassword = await this.checkRoomPassword(this.roomCode);
      if (requiresPassword) {
        // Show password prompt before connecting
        ui.showJoinRoomModal(this.roomCode, true); // true = password required
        // Will connect after user enters password
        this.setupEventListeners(); // Setup listeners so modal works
        // 两条启动路径都需要完整的 UI 初始化（历史 bug：此处提前 return
        // 导致设备名显示 -、ESC 失效、移动端键盘适配失效）
        await this.bootstrapUI();
        return;
      }
    }

    this.updateRoomDisplay();
    this.connectWebSocket();
    this.setupEventListeners();
    await this.bootstrapUI();
  }

  /**
   * UI 初始化（普通房间与加密房间两条启动路径共用）
   */
  async bootstrapUI() {
    ui.setupModalCloseHandlers();
    ui.updateEmptyState();
    this.updateDeviceNameDisplay();
    this.setupKeyboardDetection();
    this.setupVisualViewport();

    // Check notification permission on startup
    await this.checkNotificationPermission();
  }

  /**
   * Check and sync notification permission with settings
   */
  async checkNotificationPermission() {
    // If notifications are enabled in settings
    if (this.settings.enableNotifications) {
      // Check if browser supports notifications
      if (!('Notification' in window)) {
        debugLog('[App] Browser does not support notifications, disabling setting');
        this.updateSetting('enableNotifications', false);
        return;
      }

      // If permission is not granted, try to request it
      if (Notification.permission !== 'granted') {
        debugLog('[App] Notification enabled but no permission, requesting...');
        const granted = await ui.requestNotificationPermission();

        // If permission denied, disable the setting
        if (!granted) {
          debugLog('[App] Notification permission denied, disabling setting');
          this.updateSetting('enableNotifications', false);
        } else {
          debugLog('[App] Notification permission granted');
        }
      }
    }
  }

  /**
   * Setup language switcher event listeners
   */
  setupLanguageSwitcher() {
    const languageBtn = document.getElementById('languageBtn');
    const languageMenu = document.getElementById('languageMenu');
    const languageCodeEl = document.getElementById('currentLanguageCode');
    const languageFlagEl = document.getElementById('currentLanguageFlag');

    if (!languageBtn || !languageMenu) return;

    // Rectangular flag SVG content for button display
    const flagSvgContent = {
      zh: `<rect width="36" height="24" fill="#DE2910"/>
           <polygon points="6,4 7.2,7.7 4,5.5 8,5.5 4.8,7.7" fill="#FFDE00"/>
           <polygon points="12,2 12.4,3.2 11.2,2.4 12.8,2.4 11.6,3.2" fill="#FFDE00"/>
           <polygon points="14,4 14.4,5.2 13.2,4.4 14.8,4.4 13.6,5.2" fill="#FFDE00"/>
           <polygon points="14,7 14.4,8.2 13.2,7.4 14.8,7.4 13.6,8.2" fill="#FFDE00"/>
           <polygon points="12,9 12.4,10.2 11.2,9.4 12.8,9.4 11.6,10.2" fill="#FFDE00"/>`,
      'zh-HK': `<rect width="36" height="24" fill="#DE2110"/>
           <g transform="translate(18,10) scale(0.75)">
             <g fill="white">
               <ellipse cx="0" cy="-5" rx="2" ry="4.5" transform="rotate(0)"/>
               <ellipse cx="0" cy="-5" rx="2" ry="4.5" transform="rotate(72)"/>
               <ellipse cx="0" cy="-5" rx="2" ry="4.5" transform="rotate(144)"/>
               <ellipse cx="0" cy="-5" rx="2" ry="4.5" transform="rotate(216)"/>
               <ellipse cx="0" cy="-5" rx="2" ry="4.5" transform="rotate(288)"/>
             </g>
             <g fill="#DE2110">
               <line x1="0" y1="0" x2="0" y2="-6" stroke="#DE2110" stroke-width="0.6" transform="rotate(0)"/>
               <line x1="0" y1="0" x2="0" y2="-6" stroke="#DE2110" stroke-width="0.6" transform="rotate(72)"/>
               <line x1="0" y1="0" x2="0" y2="-6" stroke="#DE2110" stroke-width="0.6" transform="rotate(144)"/>
               <line x1="0" y1="0" x2="0" y2="-6" stroke="#DE2110" stroke-width="0.6" transform="rotate(216)"/>
               <line x1="0" y1="0" x2="0" y2="-6" stroke="#DE2110" stroke-width="0.6" transform="rotate(288)"/>
               <circle cx="0" cy="-2.5" r="0.5" transform="rotate(36)"/>
               <circle cx="0" cy="-2.5" r="0.5" transform="rotate(108)"/>
               <circle cx="0" cy="-2.5" r="0.5" transform="rotate(180)"/>
               <circle cx="0" cy="-2.5" r="0.5" transform="rotate(252)"/>
               <circle cx="0" cy="-2.5" r="0.5" transform="rotate(324)"/>
             </g>
           </g>`,
      en: `<rect width="36" height="24" fill="#B22234"/>
           <rect y="1.85" width="36" height="1.85" fill="white"/>
           <rect y="5.54" width="36" height="1.85" fill="white"/>
           <rect y="9.23" width="36" height="1.85" fill="white"/>
           <rect y="12.92" width="36" height="1.85" fill="white"/>
           <rect y="16.62" width="36" height="1.85" fill="white"/>
           <rect y="20.31" width="36" height="1.85" fill="white"/>
           <rect width="14.4" height="13" fill="#3C3B6E"/>`,
      ja: `<rect width="36" height="24" fill="white"/>
           <circle cx="18" cy="12" r="7" fill="#BC002D"/>`,
      ko: `<rect width="36" height="24" fill="white"/>
           <g transform="translate(18,12)">
             <circle cx="0" cy="0" r="6" fill="#C60C30"/>
             <path d="M0,-6 A6,6 0 0,1 0,6 A3,3 0 0,1 0,0 A3,3 0 0,0 0,-6" fill="#003478"/>
             <circle cx="0" cy="-3" r="3" fill="#C60C30"/>
             <circle cx="0" cy="3" r="3" fill="#003478"/>
           </g>
           <g stroke="#000" stroke-width="1.2">
             <g transform="translate(5.5,5) rotate(-15)">
               <line x1="-3.5" y1="-2" x2="3.5" y2="-2"/>
               <line x1="-3.5" y1="0" x2="3.5" y2="0"/>
               <line x1="-3.5" y1="2" x2="3.5" y2="2"/>
             </g>
             <g transform="translate(30.5,19) rotate(-15)">
               <line x1="-3.5" y1="-2" x2="-0.5" y2="-2"/><line x1="0.5" y1="-2" x2="3.5" y2="-2"/>
               <line x1="-3.5" y1="0" x2="-0.5" y2="0"/><line x1="0.5" y1="0" x2="3.5" y2="0"/>
               <line x1="-3.5" y1="2" x2="-0.5" y2="2"/><line x1="0.5" y1="2" x2="3.5" y2="2"/>
             </g>
             <g transform="translate(30.5,5) rotate(15)">
               <line x1="-3.5" y1="-2" x2="-0.5" y2="-2"/><line x1="0.5" y1="-2" x2="3.5" y2="-2"/>
               <line x1="-3.5" y1="0" x2="3.5" y2="0"/>
               <line x1="-3.5" y1="2" x2="-0.5" y2="2"/><line x1="0.5" y1="2" x2="3.5" y2="2"/>
             </g>
             <g transform="translate(5.5,19) rotate(15)">
               <line x1="-3.5" y1="-2" x2="3.5" y2="-2"/>
               <line x1="-3.5" y1="0" x2="-0.5" y2="0"/><line x1="0.5" y1="0" x2="3.5" y2="0"/>
               <line x1="-3.5" y1="2" x2="3.5" y2="2"/>
             </g>
           </g>`,
      es: `<rect width="36" height="6" fill="#AA151B"/>
           <rect y="6" width="36" height="12" fill="#F1BF00"/>
           <rect y="18" width="36" height="6" fill="#AA151B"/>`,
      fr: `<rect width="12" height="24" fill="#002395"/>
           <rect x="12" width="12" height="24" fill="white"/>
           <rect x="24" width="12" height="24" fill="#ED2939"/>`,
      de: `<rect width="36" height="8" fill="#000"/>
           <rect y="8" width="36" height="8" fill="#DD0000"/>
           <rect y="16" width="36" height="8" fill="#FFCE00"/>`,
      ar: `<rect width="36" height="8" fill="#006C35"/>
           <rect y="8" width="36" height="8" fill="white"/>
           <rect y="16" width="36" height="8" fill="#000"/>`
    };

    // Update current language code display
    const updateLanguageDisplay = () => {
      const currentLocale = i18n.getCurrentLocale();
      if (languageCodeEl) {
        languageCodeEl.textContent = currentLocale.toUpperCase();
      }

      // Update flag SVG in button
      if (languageFlagEl && flagSvgContent[currentLocale]) {
        languageFlagEl.innerHTML = flagSvgContent[currentLocale];
      }

      // Update active state in menu
      languageMenu.querySelectorAll('.language-menu-item').forEach(item => {
        const lang = item.getAttribute('data-lang');
        item.classList.toggle('active', lang === currentLocale);
      });
    };

    // Initialize display
    updateLanguageDisplay();

    // Toggle menu on button click (for mobile touch devices)
    languageBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      languageMenu.classList.toggle('show');
    });

    // Close menu when clicking outside
    document.addEventListener('click', (e) => {
      if (!languageBtn.contains(e.target) && !languageMenu.contains(e.target)) {
        languageMenu.classList.remove('show');
      }
    });

    // Language menu item clicks
    languageMenu.querySelectorAll('.language-menu-item').forEach(item => {
      item.addEventListener('click', async () => {
        const lang = item.getAttribute('data-lang');
        if (lang && lang !== i18n.getCurrentLocale()) {
          await i18n.changeLocale(lang);
          updateLanguageDisplay();
        }
        // Close menu after selection
        languageMenu.classList.remove('show');
      });
    });

    // Listen to locale change events
    window.addEventListener('localeChanged', () => {
      updateLanguageDisplay();
      // 重新应用当前连接状态，确保状态文本使用新语言
      ui.updateConnectionStatus(ui.getCurrentConnectionStatus());
      // 更新房间安全徽章的 title
      this.updateRoomSecurityBadge();
      // 更新传输模式指示器（如果可见）
      const transferModal = document.getElementById('transferModal');
      if (transferModal && transferModal.classList.contains('active')) {
        const indicator = document.getElementById('transferModeIndicator');
        if (indicator) {
          ui.updateTransferModeIndicator(indicator.dataset.mode);
        }
      }
      // 更新所有 peer 卡片的连接模式徽章（包括 connecting 状态）
      document.querySelectorAll('.connection-mode-badge').forEach(badge => {
        const mode = badge.dataset.mode;
        const card = badge.closest('[data-peer-id]');
        if (card && mode) {
          ui.updatePeerConnectionMode(card.dataset.peerId, mode);
        }
      });
    });
  }

  // Generate room code is only used for creating shareable room codes
  generateRoomCode() {
    const chars = ROOM.CODE_CHARS;
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }

  updateRoomDisplay() {
    const el = document.getElementById('roomCode');
    if (el) {
      if (this.roomCode) {
        el.textContent = this.roomCode;
      } else {
        // Auto-assigned room, show placeholder until we get the room ID from server
        el.textContent = i18n.t('room.autoAssigning');
      }
    }
  }

  /**
   * Switch to a different room without page refresh
   * Used after creating a secure room to avoid re-entering password
   * @param {string} newRoomCode - The room code to switch to
   */
  switchRoom(newRoomCode) {
    // Close existing WebSocket connection
    if (this.ws) {
      this.ws.onclose = null; // Prevent auto-reconnect
      this.ws.close();
    }

    // Clear peers
    this.peers.clear();
    ui.clearPeersGrid(document.getElementById('peersGrid'));
    // 旧管理器由 connectWebSocket 内的 destroy() 完整清理

    // Update room code
    this.roomCode = newRoomCode;
    this.updateRoomDisplay();
    this.updateRoomSecurityBadge();

    // Update URL without refresh
    const url = new URL(location.href);
    url.searchParams.set('room', newRoomCode);
    history.pushState({}, '', url.toString());

    // Reconnect to new room
    this.connectWebSocket();
  }

  /**
   * 指数退避重连：3s 起步、30s 封顶、随机抖动；页面隐藏时暂停，
   * 恢复可见后立即重连（handleVisibilityChange）
   */
  scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    const delay = Math.min(3000 * Math.pow(2, this.reconnectAttempts), 30000) + Math.random() * 1000;
    this.reconnectAttempts++;

    if (document.hidden) {
      // 隐藏时暂停，恢复可见后再重连
      this.reconnectPending = true;
      return;
    }

    this.reconnectPending = false;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWebSocket();
    }, delay);
  }

  /**
   * 页面恢复可见：若有挂起的重连，立即执行
   */
  handleVisibilityChange() {
    if (document.hidden || !this.reconnectPending) return;
    this.reconnectPending = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWebSocket();
    }, 200);
  }

  connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // If roomCode is set, use it; otherwise let server assign based on IP
    const wsUrl = this.roomCode
      ? `${protocol}//${location.host}/ws?room=${this.roomCode}`
      : `${protocol}//${location.host}/ws`;

    // For WebSocket connections, we can't use custom headers directly,
    // but we can pass auth info via subprotocol or upgrade request modifications
    // Cloudflare Workers can access request headers during upgrade
    // We'll use a custom header through fetch API upgrade mechanism

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      ui.updateConnectionStatus('connected');

      // 连接成功，重置重连退避计数
      this.reconnectAttempts = 0;
      this.reconnectPending = false;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      // Clear existing peers on reconnect to avoid duplicates
      this.peers.clear();
      ui.clearPeersGrid(document.getElementById('peersGrid'));
      this.webrtc?.closeAll(); // Also close stale WebRTC connections

      // If NOT secure room, send join immediately
      // If secure room, we wait for 'challenge' message
      if (!this.isSecureRoom || !this.roomPasswordHash) {
        this.sendJoinMessage();
      } else {
        // Secure room: waiting for challenge - add timeout fallback so we never
        // get stuck forever (e.g. server dropped the password after TTL expiry)
        if (this._secureJoinTimeout) clearTimeout(this._secureJoinTimeout);
        this._secureJoinTimeout = setTimeout(() => {
          console.warn('[App] 等待挑战超时，房间密码可能已失效，重置后重连');
          ui.showToast(i18n.t('room.roomExpired'), 'error');
          this.clearRoomPassword();
          this.connectWebSocket();
        }, 8000);
      }
    };

    this.ws.onmessage = async (e) => {
      const message = JSON.parse(e.data);

      // Handle server error frames
      if (message.type === 'error') {
        switch (message.error) {
          case 'PASSWORD_REQUIRED':
          case 'PASSWORD_INCORRECT':
            ui.showToast(i18n.t('room.passwordError'), 'error');
            this.clearRoomPassword();
            // WebSocket will be closed by server, onclose handler will show join modal
            break;
          case 'MESSAGE_TOO_LARGE':
            ui.showToast(i18n.t('errors.messageTooLarge'), 'error');
            break;
          case 'RATE_LIMIT_EXCEEDED':
            ui.showToast(i18n.t('errors.rateLimited'), 'warning');
            break;
          default:
            ui.showToast(i18n.t('errors.serverError', { error: message.error || 'UNKNOWN' }), 'error');
        }
        return;
      }

      // Handle challenge for secure rooms
      if (message.type === 'challenge') {
        if (this.roomPasswordHash) {
          const nonce = message.data.nonce;
          const response = await cryptoManager.calculateChallengeResponse(this.roomPasswordHash, nonce);
          this.ws.send(JSON.stringify({
            type: 'auth',
            data: { response }
          }));
        }
        return;
      }

      this.handleSignaling(message);
    };

    this.ws.onclose = (event) => {
      // Clear any pending secure-join timeout
      if (this._secureJoinTimeout) {
        clearTimeout(this._secureJoinTimeout);
        this._secureJoinTimeout = null;
      }

      // Room destroyed by server (password TTL expired) - password is gone,
      // reset local password state and reconnect as a normal room
      if (event.code === 4000) {
        ui.updateConnectionStatus('disconnected');
        ui.showToast(i18n.t('room.roomExpired'), 'info');
        this.clearRoomPassword();
        setTimeout(() => this.connectWebSocket(), 500);
        return;
      }

      // Handle password authentication errors (custom close codes)
      if (event.code === 4001 || event.code === 4002) {
        // Password error - don't auto-reconnect
        ui.updateConnectionStatus('disconnected');
        ui.showToast(event.code === 4001 ? i18n.t('room.passwordRequired') : i18n.t('room.passwordError'), 'error');
        this.clearRoomPassword();
        // Show join room modal again with password input
        if (this.roomCode) {
          ui.showJoinRoomModal(this.roomCode);
        }
        return;
      }

      ui.updateConnectionStatus('disconnected');
      this.scheduleReconnect();
    };

    this.ws.onerror = (event) => {
      console.error('[WebSocket] Error:', event);
      ui.updateConnectionStatus('disconnected');
    };

    // 替换旧管理器前完整清理，避免旧定时器/回调泄漏到新实例
    if (this.webrtc) {
      this.webrtc.destroy();
    }

    this.webrtc = new WebRTCManager({
      send: (msg) => this.ws.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify(msg))
    });

    // 应用用户设置到 WebRTC
    this.applyAllSettingsToWebRTC();

    this.webrtc.onProgress = (p) => {
      const isRelayMode = this.webrtc.relayMode.get(p.peerId) || false;

      // Update modal title to show actual transfer (in case it was "waiting for confirmation")
      const modalTitle = document.getElementById('modalTitle');
      if (modalTitle && modalTitle.textContent === i18n.t('transfer.waitingConfirm')) {
        modalTitle.textContent = i18n.t('transfer.sending');
      }

      ui.updateTransferProgress({
        fileName: p.fileName,
        fileSize: p.fileSize,
        percent: p.percent,
        speed: p.speed,
        mode: isRelayMode ? 'relay' : 'p2p'
      });
    };

    this.webrtc.onFileReceived = (peerId, name, blob) => {
      ui.hideModal('transferModal');

      // Show download modal instead of auto-download (better mobile support)
      this.showFileDownloadModal(name, blob);
      this.currentTransfer = null;
    };

    // Note: onFileRequest is now handled via signaling (file-request message)
    // This callback is kept for legacy P2P direct messages
    this.webrtc.onFileRequest = (peerId, info) => {
      // For P2P data channel messages (file-start), if we haven't confirmed yet
      // This is for backward compatibility - normally requests go through signaling
      const transfer = this.webrtc.incomingTransfers.get(peerId);
      if (transfer && transfer.confirmed) {
        // Already confirmed via signaling, just update progress modal
        const isRelayMode = this.webrtc.relayMode.get(peerId) || false;
        ui.showReceivingModal(info.name, info.size, isRelayMode ? 'relay' : 'p2p');
      }
    };

    this.webrtc.onTextReceived = (peerId, text) => {
      // Check if it's an image message (JSON with type: 'image')
      let messageData;
      try {
        messageData = JSON.parse(text);
      } catch (e) {
        // Not JSON, treat as plain text
        messageData = { type: 'text', content: text };
      }

      if (messageData.type === 'image') {
        this.saveMessage(peerId, {
          type: 'received',
          messageType: 'image',
          imageData: messageData.data,
          timestamp: Date.now()
        });
      } else {
        const textContent = messageData.content || text;
        this.saveMessage(peerId, { type: 'received', text: textContent, timestamp: Date.now() });
      }

      // If chat panel is open for this peer, update UI immediately
      // Use requestAnimationFrame to ensure smooth update without blocking
      if (this.currentChatPeer && this.currentChatPeer.id === peerId) {
        requestAnimationFrame(() => {
          this.renderChatHistory(peerId);
        });
        return;
      }

      // Update unread count
      const currentUnread = this.unreadMessages.get(peerId) || 0;
      this.unreadMessages.set(peerId, currentUnread + 1);
      this.updateUnreadBadge(peerId);

      // Show toast notification
      const peer = this.peers.get(peerId);
      const peerName = peer?.name || i18n.t('deviceTypes.unknown');
      if (messageData.type === 'image') {
        ui.showToast(i18n.t('chat.receivedImage', { name: peerName }), 'info');
      } else {
        const displayText = messageData.content || text;
        ui.showToast(`${peerName}: ${displayText.substring(0, 30)}${displayText.length > 30 ? '...' : ''}`, 'info');
      }

      // Show browser notification if enabled
      if (this.settings.enableNotifications) {
        ui.showBrowserNotification({
          type: 'message',
          senderName: peerName
        });
      }
    };

    // Transfer start callback (for tracking fileId)
    this.webrtc.onTransferStart = ({ peerId, fileId, fileName, direction }) => {
      this.currentTransfer = { peerId, fileId, fileName, direction };
    };

    // Transfer cancelled callback
    this.webrtc.onTransferCancelled = (peerId, fileId, reason) => {
      const peer = this.peers.get(peerId);
      ui.hideModal('transferModal');

      if (reason === 'user') {
        ui.showToast(i18n.t('transfer.transferCancelled'), 'warning');
      } else {
        ui.showToast(i18n.t('transfer.transferCancelled'), 'info');
      }

      this.currentTransfer = null;
    };

    // Transfer failed callback (incomplete/corrupt data - never deliver silently)
    this.webrtc.onTransferFailed = (peerId, fileId, fileName, reason) => {
      ui.hideModal('transferModal');
      ui.showToast(i18n.t('transfer.transferIncomplete', { name: fileName }), 'error');
      this.currentTransfer = null;
    };

    // Peer ECDH key ready -> compute and show SAS safety code on the peer card
    this.webrtc.onPeerKeyReady = (peerId) => {
      this.updatePeerSafetyCode(peerId);
    };

    // Connection state change handler
    this.webrtc.onConnectionStateChange = ({ peerId, status, message }) => {
      const toastId = `connection-${peerId}`;

      switch (status) {
        case 'connecting':
          // Only show toast if message is provided (user-initiated action)
          // Otherwise just update the badge silently
          if (message) {
            ui.showPersistentToast(toastId, message, 'loading');
          }
          ui.updatePeerConnectionMode(peerId, 'connecting');
          break;
        case 'slow':
          if (message) {
            ui.updatePersistentToast(toastId, message, 'warning');
          }
          break;
        case 'relay':
          ui.hidePersistentToast(toastId);
          if (message) {
            ui.showToast(message, 'info');
          }
          ui.updatePeerConnectionMode(peerId, 'relay');
          break;
        case 'connected':
          ui.hidePersistentToast(toastId);
          ui.updatePeerConnectionMode(peerId, 'p2p');
          break;
      }
    };
  }

  sendJoinMessage() {
    // 携带持久设备身份公钥，供对方做防伪造信任验证
    cryptoManager.getDevicePublicKey().then(deviceKey => {
      this.ws.send(JSON.stringify({
        type: 'join',
        data: {
          name: this.deviceName,
          deviceType: this.deviceType,
          browserInfo: this.browserInfo,
          deviceKey
        }
      }));
    }).catch(() => {
      this.ws.send(JSON.stringify({
        type: 'join',
        data: {
          name: this.deviceName,
          deviceType: this.deviceType,
          browserInfo: this.browserInfo
        }
      }));
    });
  }

  handleSignaling(msg) {
    debugLog('[Signaling] Received:', msg.type, msg);
    switch (msg.type) {
      case 'auth-success':
        // Authentication successful, now join the room
        this.sendJoinMessage();
        break;
      case 'joined':
        this.peerId = msg.peerId;
        // Joined successfully - cancel any secure-join timeout
        if (this._secureJoinTimeout) {
          clearTimeout(this._secureJoinTimeout);
          this._secureJoinTimeout = null;
        }
        debugLog('[Signaling] My peer ID:', this.peerId);
        // Set peer ID for Perfect Negotiation pattern
        this.webrtc.setMyPeerId(this.peerId);
        // Update room code from server if auto-assigned
        if (msg.roomCode) {
          this.roomCode = msg.roomCode;
          this.updateRoomDisplay();
          debugLog('[Signaling] Room code:', this.roomCode);
        }
        msg.peers?.forEach(p => this.addPeer(p));

        // Show room info hint if no peers (help users understand they need to share room code)
        if (!msg.peers || msg.peers.length === 0) {
          // Check if this is an auto-assigned room (no explicit room in URL)
          const params = new URLSearchParams(location.search);
          const hasExplicitRoom = params.has('room');

          if (!hasExplicitRoom) {
            // Auto-assigned room - show a hint about sharing
            ui.showToast(i18n.t('room.autoAssigned', { room: this.roomCode }), 'info', 5000);
          }
        }
        break;
      case 'peer-joined':
        this.addPeer(msg.data);
        ui.showToast(i18n.t('toast.peerJoined', { name: msg.data.name }), 'info');
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
      case 'key-exchange':
        this.webrtc.handleKeyExchange(msg.from, msg.data);
        break;
      case 'name-changed':
        this.handleNameChanged(msg.from, msg.data.name);
        break;
      case 'identity-challenge':
        this.handleIdentityChallenge(msg.from, msg.data);
        break;
      case 'identity-response':
        this.handleIdentityResponse(msg.from, msg.data);
        break;
      case 'file-request':
        this.handleFileRequest(msg.from, msg.data);
        break;
      case 'file-response':
        this.webrtc.handleFileResponse(msg.from, msg.data);
        break;
      case 'file-cancel':
        this.webrtc.handleFileCancel(msg.from, msg.data);
        break;
    }
  }

  /**
   * Handle incoming file request - show confirmation dialog or auto-accept if trusted
   */
  async handleFileRequest(peerId, data) {
    const peer = this.peers.get(peerId);
    const isRelayMode = data.transferMode === 'relay';
    const isBatch = Array.isArray(data.files) && data.files.length > 1;

    // 展示信息（批量：文件数+总大小）
    const displayName = isBatch
      ? i18n.t('transfer.fileCount', { count: data.files.length })
      : data.name;
    const displaySize = isBatch
      ? data.files.reduce((sum, f) => sum + (f.size || 0), 0)
      : data.size;

    // Store pending request info（并发请求时用局部引用避免串号）
    const request = { peerId, fileId: isBatch ? data.batchId : data.fileId, data, isBatch };
    this.pendingFileRequest = request;

    // Check if this device is trusted - auto-accept if so
    if (peer && this.isDeviceTrusted(peer)) {
      // 密钥指纹信任：先验证对方确实持有设备私钥，防公钥抄袭伪造
      const verified = await this.verifyPeerIdentity(peer);
      if (verified) {
        debugLog(`[App] Auto-accepting file from trusted device: ${peer.name}`);
        ui.showToast(i18n.t('toast.autoAccepting', { name: peer.name, file: displayName }), 'info');
        this.acceptFileRequest(request);
        return;
      }
      // 验证失败/超时：降级为人工确认（安全兑底）
      console.warn(`[App] Trusted device identity verification failed for ${peer.name}, falling back to manual confirm`);
    }

    // Update the receive modal with detailed info
    ui.updateReceiveModal({
      senderName: peer?.name || i18n.t('deviceTypes.unknown'),
      senderDeviceType: peer?.deviceType || 'desktop',
      senderBrowserInfo: peer?.browserInfo,
      fileName: displayName,
      fileSize: displaySize,
      mode: isRelayMode ? 'relay' : 'p2p'
    });

    // Trigger notification (vibration)
    ui.triggerNotification('file');

    // Show browser notification if enabled
    if (this.settings.enableNotifications) {
      ui.showBrowserNotification({
        type: 'file',
        senderName: peer?.name || i18n.t('deviceTypes.unknown'),
        fileName: displayName
      });
    }

    // Show the confirmation modal
    ui.showModal('receiveModal');
  }

  /**
   * Accept the pending file request
   * @param {object} request - 可选，指定要接受的请求（并发安全）
   */
  acceptFileRequest(request = this.pendingFileRequest) {
    if (!request) return;

    const { peerId, fileId, data, isBatch } = request;

    // Send acceptance
    this.webrtc.respondToFileRequest(peerId, fileId, true);

    // Save current transfer state for cancellation
    this.currentTransfer = {
      peerId,
      fileId,
      fileName: isBatch ? i18n.t('transfer.fileCount', { count: data.files.length }) : data.name,
      direction: 'receive'
    };

    // Hide confirmation, show receiving progress
    ui.hideModal('receiveModal');
    const isRelayMode = data.transferMode === 'relay' || (isBatch && data.files[0]?.transferMode === 'relay');

    if (isBatch) {
      // 批量：后续每个文件的 file-start 会自行建立传输状态（confirmed 直接开始）
      const totalSize = data.files.reduce((sum, f) => sum + (f.size || 0), 0);
      ui.showReceivingModal(
        i18n.t('transfer.fileCount', { count: data.files.length }),
        totalSize,
        isRelayMode ? 'relay' : 'p2p'
      );
      this.pendingFileRequest = null;
      return;
    }

    ui.showReceivingModal(data.name, data.size, isRelayMode ? 'relay' : 'p2p');

    // Initialize transfer state for receiving
    this.webrtc.incomingTransfers.set(peerId, {
      fileId: fileId,
      name: data.name,
      size: data.size,
      mimeType: data.mimeType || 'application/octet-stream', // Save MIME type
      totalChunks: data.totalChunks,
      chunks: [],
      received: 0,
      startTime: Date.now(),
      confirmed: true
    });

    this.pendingFileRequest = null;
  }

  /**
   * Decline the pending file request
   */
  declineFileRequest() {
    if (!this.pendingFileRequest) return;

    const { peerId, fileId } = this.pendingFileRequest;

    // Send decline
    this.webrtc.respondToFileRequest(peerId, fileId, false);

    ui.hideModal('receiveModal');
    ui.showToast(i18n.t('common.decline'), 'info');

    this.pendingFileRequest = null;
  }

  /**
   * Accept file and trust the sending device for future transfers
   */
  acceptAndTrustDevice() {
    if (!this.pendingFileRequest) return;

    const { peerId } = this.pendingFileRequest;
    const peer = this.peers.get(peerId);

    // Trust the device first
    if (peer) {
      this.trustDevice(peer);
    }

    // Then accept the file
    this.acceptFileRequest();
  }

  /**
   * Cancel the current active transfer
   */
  cancelCurrentTransfer() {
    if (!this.currentTransfer) {
      ui.hideModal('transferModal');
      return;
    }

    const { peerId, fileId, fileName, direction } = this.currentTransfer;

    // Cancel the transfer via WebRTC
    this.webrtc.cancelTransfer(fileId, peerId, 'user');

    // Hide modal and show feedback
    ui.hideModal('transferModal');
    ui.showToast(i18n.t('transfer.transferCancelled'), 'info');

    this.currentTransfer = null;
  }

  addPeer(peer) {
    this.peers.set(peer.id, peer);
    ui.addPeerToGrid(peer, document.getElementById('peersGrid'), (p, e) => this.onPeerClick(p, e));

    // Check if this device is trusted and show badge
    if (this.isDeviceTrusted(peer)) {
      // Small delay to ensure DOM is ready
      setTimeout(() => this.updateTrustedBadge(peer.id, true), 50);
    }

    // 计算并展示短安全码（密钥未就绪时为 null，就绪后由 onPeerKeyReady 更新）
    this.updatePeerSafetyCode(peer.id);

    // Prewarm WebRTC connection for faster first transfer
    if (this.webrtc) {
      this.webrtc.prewarmConnection(peer.id);
    }
  }

  /**
   * 更新设备卡片上的短安全码（SAS）
   */
  async updatePeerSafetyCode(peerId) {
    try {
      const code = await cryptoManager.computeSafetyCode(peerId);
      if (code) ui.updatePeerSafetyCode(peerId, code);
    } catch (e) {
      console.warn('[App] 安全码计算失败:', e);
    }
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) ui.showToast(i18n.t('toast.peerLeft', { name: peer.name }), 'info');
    this.peers.delete(peerId);
    ui.removePeerFromGrid(peerId, document.getElementById('peersGrid'));
    this.webrtc.closeConnection(peerId);
  }

  updateDeviceNameDisplay() {
    document.getElementById('deviceName').textContent = this.deviceName;
  }

  updateDeviceName(newName) {
    this.deviceName = newName;
    localStorage.setItem(STORAGE_KEYS.DEVICE_NAME, newName);
    this.updateDeviceNameDisplay();

    // Broadcast name change to all peers
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'name-changed',
        data: { name: newName }
      }));
    }

    ui.showToast(i18n.t('deviceName.updated'), 'success');
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

      ui.showToast(i18n.t('toast.peerRenamed', { oldName, newName }), 'info');
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
    const peer = this.peers.get(peerId);
    const peerName = peer?.name || i18n.t('deviceTypes.unknown');

    if (!files || files.length === 0) return;

    if (files.length === 1) {
      await this.sendSingleFile(peerId, files[0], peerName);
      return;
    }

    // 多文件：一次确认框，确认后逐个传输
    this.showWaitingForConfirmation(peerName, i18n.t('transfer.fileCount', { count: files.length }));

    try {
      await this.webrtc.sendFiles(peerId, files);
      ui.hideModal('transferModal');
      ui.showToast(i18n.t('toast.filesSent', { count: files.length }), 'success');
    } catch (e) {
      this.handleSendError(e, peerName);
    } finally {
      this.currentTransfer = null;
    }
  }

  /**
   * 单文件发送（原有确认流程）
   */
  async sendSingleFile(peerId, file, peerName) {
    // Show waiting for confirmation
    this.showWaitingForConfirmation(peerName, file.name);

    try {
      // sendFile now handles the request/confirm flow internally
      // It will throw if declined, timeout, or cancelled
      // onTransferStart callback will set this.currentTransfer
      await this.webrtc.sendFile(peerId, file);

      ui.hideModal('transferModal');
      ui.showToast(i18n.t('toast.fileSent', { name: file.name }), 'success');
    } catch (e) {
      this.handleSendError(e, peerName);
    } finally {
      this.currentTransfer = null;
    }
  }

  /**
   * 发送失败的统一错误分发（按错误码，与 i18n 解耦）
   */
  handleSendError(e, peerName) {
    ui.hideModal('transferModal');
    switch (e.message) {
      case ERROR_CODES.FILE_DECLINED:
        ui.showToast(i18n.t('toast.fileDeclined', { name: peerName }), 'warning');
        break;
      case ERROR_CODES.FILE_TIMEOUT:
        ui.showToast(i18n.t('toast.fileTimeout'), 'warning');
        break;
      case ERROR_CODES.FILE_CANCELLED:
        ui.showToast(i18n.t('transfer.transferCancelled'), 'info');
        break;
      case ERROR_CODES.MESSAGE_TOO_LARGE:
        ui.showToast(i18n.t('errors.messageTooLarge'), 'error');
        break;
      default:
        ui.showToast(i18n.t('toast.sendFailed', { error: e.message }), 'error');
    }
  }

  /**
   * Show modal indicating waiting for recipient to accept
   */
  showWaitingForConfirmation(peerName, fileName) {
    document.getElementById('modalTitle').textContent = i18n.t('transfer.waitingConfirm');
    document.getElementById('transferFileName').textContent = fileName;
    document.getElementById('transferFileSize').textContent = i18n.t('transfer.waitingFor', { name: peerName });
    document.getElementById('transferProgress').style.width = '0%';
    document.getElementById('transferPercent').textContent = '';
    document.getElementById('transferSpeed').textContent = '';

    // Add waiting state classes for special styling
    document.querySelector('.transfer-info')?.classList.add('waiting');
    document.querySelector('.progress-container')?.classList.add('waiting');
    document.querySelector('.transfer-stats')?.classList.add('waiting');

    // Update mode indicator to show waiting (with icon)
    ui.updateTransferModeIndicator('waiting');

    ui.showModal('transferModal');
  }

  /**
   * Show file download modal (for mobile-friendly download)
   */
  showFileDownloadModal(fileName, blob) {
    // Store blob URL for cleanup
    if (this._pendingDownloadUrl) {
      URL.revokeObjectURL(this._pendingDownloadUrl);
    }
    this._pendingDownloadUrl = URL.createObjectURL(blob);
    this._pendingDownloadName = fileName;

    // Update modal content
    document.getElementById('downloadFileName').textContent = fileName;
    document.getElementById('downloadFileSize').textContent = ui.formatFileSize(blob.size);

    // Set download link
    const downloadBtn = document.getElementById('downloadFileBtn');
    downloadBtn.href = this._pendingDownloadUrl;
    downloadBtn.download = fileName;

    // Show modal
    ui.showModal('fileDownloadModal');

    // Trigger notification
    ui.triggerNotification('file');
  }

  /**
   * Clean up download modal resources
   */
  cleanupDownloadModal() {
    if (this._pendingDownloadUrl) {
      URL.revokeObjectURL(this._pendingDownloadUrl);
      this._pendingDownloadUrl = null;
    }
    this._pendingDownloadName = null;
    ui.hideModal('fileDownloadModal');
  }

  joinRoom(code) {
    if (!code || !ROOM.CODE_PATTERN.test(code)) {
      ui.showToast(i18n.t('room.invalidCode'), 'error');
      return;
    }
    // Navigate to new room
    const url = new URL(location.href);
    url.searchParams.set('room', code.toUpperCase());
    location.href = url.toString();
  }

  /**
   * Calculate password strength (0-3)
   * 0 = weak, 1 = fair, 2 = good, 3 = strong
   */
  calculatePasswordStrength(password) {
    let strength = 0;

    if (password.length >= ROOM.PASSWORD_MIN_LENGTH) strength++;
    if (password.length >= 10) strength++;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) strength++;
    if (/\d/.test(password)) strength++;
    if (/[^a-zA-Z0-9]/.test(password)) strength++;

    // Normalize to 0-3 scale
    return Math.min(Math.floor(strength / 1.5), 3);
  }

  /**
   * Update room lock icon display
   */
  updateRoomSecurityBadge() {
    const lockIcon = document.getElementById('roomLockIcon');
    if (lockIcon) {
      if (this.isSecureRoom) {
        lockIcon.classList.add('locked');
        lockIcon.title = i18n.t('room.secureRoomActive');
      } else {
        lockIcon.classList.remove('locked');
        lockIcon.title = i18n.t('room.clickToCreateSecure');
      }
    }
  }




  /**
   * Send an image message
   * @param {string} peerId - Target peer ID
   * @param {string} imageDataUrl - Base64 data URL of the image
   */

  /**
   * Compress and resize image for sending
   * Uses a quality/width ladder to fit the image within the relay message
   * budget (256KB server limit), so sending never fails silently.
   * @param {File} file - Image file
   * @param {number} maxWidth - Maximum width (default 1200)
   * @param {number} quality - Initial JPEG quality 0-1 (default 0.8)
   * @returns {Promise<string>} - Base64 data URL
   */

  /**
   * Show image preview before sending
   * @param {File} file - Image file
   */

  /**
   * Clear pending image preview
   */

  /**
   * Show image in fullscreen modal
   * @param {string} imageUrl - Image URL or data URL
   */

  /**
   * Hide fullscreen image modal
   */
  hideImageFullscreen() {
    const modal = document.getElementById('imageFullscreenModal');
    modal.classList.remove('active');
  }



  /**
   * 渲染聊天历史：新消息增量追加，状态变更/面板切换时全量重建
   * @param {string} peerId
   * @param {boolean} forceRebuild - 强制全量重建（如消息状态变更）
   */

  /**
   * 构建单条消息元素
   */

  /**
   * Scroll chat container to bottom
   * Uses delayed scroll to handle async image loading
   */



  /**
   * Copy image to clipboard
   * @param {string} dataUrl - Image data URL
   * @param {HTMLElement} btn - Copy button element for feedback
   */



  setupEventListeners() {
    const app = document.getElementById('app');
    let dragCounter = 0;

    // 页面恢复可见时重连（配合 scheduleReconnect 的退避暂停）
    document.addEventListener('visibilitychange', () => this.handleVisibilityChange());

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
        ui.showToast(i18n.t('toast.selectDevice'), 'warning');
      }
    });

    // Desktop share popover
    this.setupDesktopSharePopover();

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

    // Refresh room button - generate new room code
    document.getElementById('refreshRoomBtn')?.addEventListener('click', async () => {
      // Generate new room code
      const newRoomCode = this.generateRoomCode();

      // Clear room password since it's a new room
      this.clearRoomPassword();

      // Switch to new room
      this.switchRoom(newRoomCode);
      this.triggerHaptic('medium');
      ui.showToast(i18n.t('room.switchedToRoom', { room: newRoomCode }), 'success');
    });

    // Join room button
    document.getElementById('joinRoomBtn')?.addEventListener('click', () => {
      document.getElementById('roomInput').value = '';
      ui.showModal('joinRoomModal');
    });

    // Join room modal
    document.getElementById('joinRoomModalClose')?.addEventListener('click', () => ui.hideModal('joinRoomModal'));
    document.getElementById('joinRoomCancel')?.addEventListener('click', () => ui.hideModal('joinRoomModal'));
    document.getElementById('joinRoomConfirm')?.addEventListener('click', async () => {
      const code = document.getElementById('roomInput').value.trim();
      const password = document.getElementById('joinRoomPassword').value;

      if (!code) {
        ui.showToast(i18n.t('room.placeholder'), 'error');
        return;
      }

      // If password is provided, join secure room
      if (password) {
        const success = await this.joinSecureRoom(code, password);
        if (success) {
          ui.hideModal('joinRoomModal');
          // Use switchRoom to avoid page refresh (preserves password in memory)
          this.switchRoom(code.toUpperCase());
        }
      } else {
        // Check if room requires password
        const requiresPassword = await this.checkRoomPassword(code);
        if (requiresPassword) {
          // Show password input
          ui.showJoinRoomPasswordSection();
          ui.showToast(i18n.t('room.passwordRequired'), 'warning');
        } else {
          // Regular room join (no password needed, can use page refresh)
          this.joinRoom(code);
        }
      }
    });
    document.getElementById('roomInput')?.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        const code = document.getElementById('roomInput').value.trim();
        const password = document.getElementById('joinRoomPassword').value;

        if (password) {
          const success = await this.joinSecureRoom(code, password);
          if (success) {
            ui.hideModal('joinRoomModal');
            // Use switchRoom to avoid page refresh (preserves password in memory)
            this.switchRoom(code.toUpperCase());
          }
        } else {
          const requiresPassword = await this.checkRoomPassword(code);
          if (requiresPassword) {
            ui.showJoinRoomPasswordSection();
            ui.showToast(i18n.t('room.passwordRequired'), 'warning');
          } else {
            this.joinRoom(code);
          }
        }
      }
    });

    // Password toggle for join room modal
    document.getElementById('joinPasswordToggle')?.addEventListener('click', () => {
      const passwordInput = document.getElementById('joinRoomPassword');
      const isPassword = passwordInput.type === 'password';
      passwordInput.type = isPassword ? 'text' : 'password';
    });

    // Room lock icon click - create secure room or show info
    document.getElementById('roomLockIcon')?.addEventListener('click', () => {
      if (this.isSecureRoom) {
        // Already in a secure room, show info toast
        ui.showToast(i18n.t('room.alreadySecure'), 'info');
        return;
      }
      // Generate a random room code for new secure room
      const randomCode = this.generateRoomCode();
      document.getElementById('secureRoomCode').value = randomCode;
      document.getElementById('secureRoomPassword').value = '';
      ui.hidePasswordStrength(); // Reset password strength indicator
      ui.showModal('createSecureRoomModal');
      document.getElementById('secureRoomPassword').focus();
    });

    // Create secure room modal
    document.getElementById('createSecureRoomClose')?.addEventListener('click', () => ui.hideModal('createSecureRoomModal'));
    document.getElementById('createSecureRoomCancel')?.addEventListener('click', () => ui.hideModal('createSecureRoomModal'));
    document.getElementById('createSecureRoomConfirm')?.addEventListener('click', async () => {
      const roomCode = document.getElementById('secureRoomCode').value.trim().toUpperCase();
      const password = document.getElementById('secureRoomPassword').value;

      if (!roomCode) {
        ui.showToast(i18n.t('room.roomCodePlaceholder'), 'error');
        return;
      }

      if (!password || password.length < 6) {
        ui.showToast(i18n.t('room.passwordMinLength'), 'error');
        return;
      }

      const success = await this.createSecureRoom(roomCode, password);
      if (success) {
        ui.hideModal('createSecureRoomModal');
        ui.showToast(i18n.t('room.createSuccess'), 'success');
        // Switch to the new secure room without page refresh
        // This preserves the password in memory so creator doesn't need to re-enter
        this.switchRoom(roomCode);
      }
    });

    // Password toggle for create secure room modal
    document.getElementById('createPasswordToggle')?.addEventListener('click', () => {
      const passwordInput = document.getElementById('secureRoomPassword');
      const isPassword = passwordInput.type === 'password';
      passwordInput.type = isPassword ? 'text' : 'password';
    });

    // Password strength indicator
    document.getElementById('secureRoomPassword')?.addEventListener('input', (e) => {
      const password = e.target.value;
      if (password.length > 0) {
        const strength = this.calculatePasswordStrength(password);
        ui.showPasswordStrength(strength);
      } else {
        ui.hidePasswordStrength();
      }
    });

    // Modal close buttons
    document.getElementById('modalClose')?.addEventListener('click', () => {
      // If there's an active transfer, ask for confirmation
      if (this.currentTransfer) {
        this.cancelCurrentTransfer();
      } else {
        ui.hideModal('transferModal');
      }
    });

    // Cancel transfer button
    document.getElementById('cancelTransfer')?.addEventListener('click', () => {
      this.triggerHaptic('medium');
      this.cancelCurrentTransfer();
    });
    document.getElementById('receiveModalClose')?.addEventListener('click', () => {
      this.declineFileRequest();
    });
    document.getElementById('receiveDecline')?.addEventListener('click', () => {
      this.triggerHaptic('light');
      this.declineFileRequest();
    });
    document.getElementById('receiveAccept')?.addEventListener('click', () => {
      this.triggerHaptic('medium');
      this.acceptFileRequest();
    });
    document.getElementById('receiveAlwaysAccept')?.addEventListener('click', () => {
      this.triggerHaptic('medium');
      this.acceptAndTrustDevice();
    });

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
          ui.showToast(i18n.t('toast.messageSent'), 'success');
        }
      }
    });

    // Received text modal
    document.getElementById('receivedTextModalClose')?.addEventListener('click', () => ui.hideModal('receivedTextModal'));
    document.getElementById('closeReceivedText')?.addEventListener('click', () => ui.hideModal('receivedTextModal'));
    document.getElementById('copyText')?.addEventListener('click', () => {
      const text = document.getElementById('receivedText').textContent;
      navigator.clipboard.writeText(text);
      ui.showToast(i18n.t('common.copied'), 'success');
    });

    // File download modal
    document.getElementById('fileDownloadModalClose')?.addEventListener('click', () => this.cleanupDownloadModal());
    document.getElementById('downloadFileClose')?.addEventListener('click', () => this.cleanupDownloadModal());
    document.getElementById('downloadFileBtn')?.addEventListener('click', () => {
      // Show success toast after user clicks download
      ui.showToast(i18n.t('download.saved', { name: this._pendingDownloadName }), 'success');
      // Delay cleanup to allow download to start
      setTimeout(() => this.cleanupDownloadModal(), 500);
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
        ui.showToast(i18n.t('toast.sendFailed', { error: e.message }), 'error');
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
        // If there's a pending image, send it
        if (this.pendingImage) {
          await this.handleSendImageMessage();
        } else {
          const btn = document.getElementById('sendChatMessage');
          if (btn) btn.click();
        }
      }
    });

    // Image attachment button
    document.getElementById('attachImageBtn')?.addEventListener('click', () => {
      const imageInput = document.getElementById('chatImageInput');
      if (imageInput) imageInput.click();
    });

    // Image file input change
    document.getElementById('chatImageInput')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (file) {
        await this.showImagePreview(file);
      }
      // Reset input so same file can be selected again
      e.target.value = '';
    });

    // Paste image from clipboard
    document.getElementById('chatInput')?.addEventListener('paste', async (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) {
            await this.showImagePreview(file);
          }
          return;
        }
      }
    });

    // Also support paste on the chat panel container
    document.getElementById('chatPanel')?.addEventListener('paste', async (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) {
            await this.showImagePreview(file);
          }
          return;
        }
      }
    });

    // Remove preview image button
    document.getElementById('removePreviewImage')?.addEventListener('click', () => {
      this.clearImagePreview();
    });

    // Close fullscreen image modal
    document.getElementById('closeFullscreenImage')?.addEventListener('click', () => {
      this.hideImageFullscreen();
    });

    document.getElementById('imageFullscreenModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'imageFullscreenModal') {
        this.hideImageFullscreen();
      }
    });

    // Modify send button to handle both text and image
    const originalSendHandler = document.getElementById('sendChatMessage');
    if (originalSendHandler) {
      originalSendHandler.addEventListener('click', async () => {
        // If there's a pending image, send it instead
        if (this.pendingImage && this.currentChatPeer) {
          await this.handleSendImageMessage();
        }
      }, true); // Use capture phase to run before the original handler
    }
  }

  /**
   * Handle sending image message from chat panel
   */
  async handleSendImageMessage() {
    if (!this.pendingImage || !this.currentChatPeer) return;

    const { dataUrl } = this.pendingImage;
    const btn = document.getElementById('sendChatMessage');

    // Clear preview first
    this.clearImagePreview();

    // Disable button during send
    if (btn) {
      btn.disabled = true;
      btn.classList.add('sending');
    }

    try {
      const success = await this.sendImageMessage(this.currentChatPeer.id, dataUrl);
      if (success) {
        this.renderChatHistory(this.currentChatPeer.id);
        ui.showToast(i18n.t('chat.imageSent'), 'success');
      }
    } catch (e) {
      ui.showToast(i18n.t('chat.imageSendFailed', { error: e.message }), 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.classList.remove('sending');
      }
    }
  }

  // Desktop share popover setup
  setupDesktopSharePopover() {
    const shareBtn = document.getElementById('shareRoomBtn');
    const roomCodeEl = document.getElementById('roomCode');
    const popover = document.getElementById('sharePopover');
    const closeBtn = document.getElementById('sharePopoverClose');
    const copyCodeBtn = document.getElementById('sharePopoverCopyCode');
    const copyLinkBtn = document.getElementById('sharePopoverCopyLink');

    if (!shareBtn || !popover) return;

    // Create overlay for click-outside-to-close
    let overlay = document.querySelector('.share-popover-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'share-popover-overlay';
      document.body.appendChild(overlay);
    }

    const showPopover = () => {
      // Update room code display
      document.getElementById('sharePopoverRoomCode').textContent = this.roomCode || '-';

      // Generate QR code
      const canvas = document.getElementById('shareQRCode');
      if (canvas && this.roomCode) {
        const url = new URL(location.href);
        url.searchParams.set('room', this.roomCode);
        ui.generateQRCode(canvas, url.toString(), { size: 160 });
      }

      popover.classList.add('active');
      overlay.classList.add('active');
    };

    const hidePopover = () => {
      popover.classList.remove('active');
      overlay.classList.remove('active');
    };

    // Toggle popover on share button click
    shareBtn.addEventListener('click', (e) => {
      e.stopPropagation();

      // On mobile, show mobile share modal instead of popover
      if (ui.isMobile()) {
        this.showMobileShareModal();
        return;
      }

      if (popover.classList.contains('active')) {
        hidePopover();
      } else {
        showPopover();
      }
    });

    // Click room code to copy
    roomCodeEl?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.roomCode) {
        navigator.clipboard.writeText(this.roomCode);
        ui.showToast(i18n.t('share.roomCodeCopied'), 'success');
        this.triggerHaptic('light');
      }
    });

    // Close button
    closeBtn?.addEventListener('click', hidePopover);

    // Click outside to close
    overlay.addEventListener('click', hidePopover);

    // Copy room code
    copyCodeBtn?.addEventListener('click', () => {
      navigator.clipboard.writeText(this.roomCode);
      ui.showToast(i18n.t('share.roomCodeCopied'), 'success');

      // Visual feedback
      copyCodeBtn.classList.add('copied');
      setTimeout(() => copyCodeBtn.classList.remove('copied'), 1000);
    });

    // Copy link
    copyLinkBtn?.addEventListener('click', () => {
      const url = new URL(location.href);
      url.searchParams.set('room', this.roomCode);
      navigator.clipboard.writeText(url.toString());
      ui.showToast(i18n.t('share.linkCopied'), 'success');

      // Visual feedback
      copyLinkBtn.classList.add('copied');
      setTimeout(() => copyLinkBtn.classList.remove('copied'), 1000);
    });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && popover.classList.contains('active')) {
        hidePopover();
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
      ui.showModal('joinRoomModal');
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
      ui.showToast(i18n.t('share.roomCodeCopied'), 'success');
    });

    // 设置 Popover (桌面端)
    this.setupSettingsPopover();

    // 设置控件事件监听 (移动端和桌面端)
    this.setupSettingsControls();

    // Mobile share panel
    document.getElementById('mobileShareClose')?.addEventListener('click', () => {
      ui.hideModal('mobileShareModal');
    });

    document.getElementById('shareCopyLink')?.addEventListener('click', () => {
      const url = new URL(location.href);
      url.searchParams.set('room', this.roomCode);
      navigator.clipboard.writeText(url.toString());
      this.triggerHaptic('light');
      ui.showToast(i18n.t('share.linkCopied'), 'success');
    });

    document.getElementById('shareNative')?.addEventListener('click', async () => {
      if (navigator.share) {
        try {
          const url = new URL(location.href);
          url.searchParams.set('room', this.roomCode);
          await navigator.share({
            title: i18n.t('share.nativeShareTitle'),
            text: i18n.t('share.nativeShareText', { room: this.roomCode }),
            url: url.toString()
          });
          this.triggerHaptic('medium');
        } catch (e) {
          if (e.name !== 'AbortError') {
            ui.showToast(i18n.t('toast.shareFailed'), 'error');
          }
        }
      } else {
        ui.showToast(i18n.t('toast.shareNotSupported'), 'warning');
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

    // Quick join 6-digit input handling
    this.setupQuickJoinInputs();
  }

  // Setup 6-digit code input interactions
  setupQuickJoinInputs() {
    const container = document.getElementById('quickJoinInputs');
    if (!container) return;

    const inputs = container.querySelectorAll('.code-digit');

    inputs.forEach((input, index) => {
      // Handle input
      input.addEventListener('input', (e) => {
        let value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');

        // Take only the last character if multiple were entered
        if (value.length > 1) {
          value = value.slice(-1);
        }

        e.target.value = value;

        // Update filled state
        e.target.classList.toggle('filled', value.length > 0);

        // Auto-advance to next input
        if (value && index < inputs.length - 1) {
          inputs[index + 1].focus();
        }

        // Auto-submit when all 6 digits are filled
        if (this.getQuickJoinCode().length === 6) {
          this.handleQuickJoin();
        }
      });

      // Handle keydown for navigation
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace') {
          if (!e.target.value && index > 0) {
            // Move to previous input on backspace if current is empty
            inputs[index - 1].focus();
            inputs[index - 1].value = '';
            inputs[index - 1].classList.remove('filled');
          } else {
            e.target.classList.remove('filled');
          }
        } else if (e.key === 'ArrowLeft' && index > 0) {
          e.preventDefault();
          inputs[index - 1].focus();
        } else if (e.key === 'ArrowRight' && index < inputs.length - 1) {
          e.preventDefault();
          inputs[index + 1].focus();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          this.handleQuickJoin();
        }
      });

      // Handle paste
      input.addEventListener('paste', (e) => {
        e.preventDefault();
        const pasteData = e.clipboardData.getData('text').toUpperCase().replace(/[^A-Z0-9]/g, '');

        // Distribute pasted characters across inputs
        for (let i = 0; i < Math.min(pasteData.length, inputs.length - index); i++) {
          inputs[index + i].value = pasteData[i];
          inputs[index + i].classList.toggle('filled', pasteData[i].length > 0);
        }

        // Focus the next empty input or the last one
        const nextEmptyIndex = Math.min(index + pasteData.length, inputs.length - 1);
        inputs[nextEmptyIndex].focus();

        // Auto-submit if 6 digits filled
        if (this.getQuickJoinCode().length === 6) {
          this.handleQuickJoin();
        }
      });

      // Handle focus - select content
      input.addEventListener('focus', () => {
        input.select();
      });
    });
  }

  // Get the combined code from all 6 inputs
  getQuickJoinCode() {
    const container = document.getElementById('quickJoinInputs');
    if (!container) return '';

    const inputs = container.querySelectorAll('.code-digit');
    return Array.from(inputs).map(input => input.value).join('');
  }

  // Handle quick join room action
  async handleQuickJoin() {
    const code = this.getQuickJoinCode();

    if (!code || code.length !== 6) {
      ui.showToast(i18n.t('toast.invalidRoomCode'), 'error');
      const container = document.getElementById('quickJoinInputs');
      container?.querySelector('.code-digit')?.focus();
      return;
    }

    if (!ROOM.CODE_PATTERN.test(code)) {
      ui.showToast(i18n.t('room.invalidCode'), 'error');
      return;
    }

    this.triggerHaptic('light');

    // Check if room needs password
    const needsPassword = await this.checkRoomPassword(code);
    if (needsPassword) {
      // Room needs password, show modal with password input
      document.getElementById('roomInput').value = code;
      ui.showJoinRoomPasswordSection();
      ui.showModal('joinRoomModal');
      ui.showToast(i18n.t('room.passwordRequired'), 'warning');
    } else {
      // Regular room, join directly
      this.joinRoom(code);
    }
  }

  // Show quick actions panel
  showQuickActions() {
    if (this.peers.size === 0) {
      ui.showToast(i18n.t('toast.noDevices'), 'warning');
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

    // 获取当前连接状态
    const currentStatus = ui.getCurrentConnectionStatus();

    if (statusEl && mainStatusEl) {
      statusEl.className = 'settings-value';
      const dotEl = statusEl.querySelector('.status-dot');
      if (dotEl) {
        dotEl.style.background = currentStatus === 'connected'
          ? 'var(--status-success)'
          : currentStatus === 'disconnected'
            ? 'var(--status-error)'
            : 'var(--status-warning)';
      }
    }

    if (statusTextEl) {
      statusTextEl.textContent = i18n.t(`common.${currentStatus}`);
    }

    // Render trusted devices list
    this.renderTrustedDevicesList();

    ui.showModal('mobileSettingsModal');
  }

  /**
   * Render trusted devices list in settings
   */

  // Show mobile share modal
  showMobileShareModal() {
    const shareRoomCodeEl = document.getElementById('shareRoomCode');
    if (shareRoomCodeEl) {
      shareRoomCodeEl.textContent = this.roomCode;
    }

    // Generate QR code for mobile share modal
    const canvas = document.getElementById('mobileShareQRCode');
    if (canvas && this.roomCode) {
      const url = new URL(location.href);
      url.searchParams.set('room', this.roomCode);
      ui.generateQRCode(canvas, url.toString(), { size: 160 });
    }

    ui.showModal('mobileShareModal');
  }

  // Select file to send (for mobile)
  selectFileToSend() {
    if (this.peers.size === 0) {
      ui.showToast(i18n.t('toast.noDevices'), 'warning');
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
      ui.showToast(i18n.t('toast.selectDevice'), 'info');
    }
  }

  // Show text input for sending

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

  /**
   * 设置 Popover (桌面端) 
   */

  /**
   * 设置控件事件监听 (移动端和桌面端)
   */

  /**
   * 同步设置值到 UI 控件
   * @param {'popover'|'modal'} target - 目标 UI
   */

  /**
   * 同步主题选择到 UI
   * @param {'popover'|'modal'} target - 目标 UI
   */

  /**
   * 同步信任设备列表到 UI
   * @param {'popover'|'modal'} target - 目标 UI
   */
}

// 拆分出的模块以 mixin 方式挂载（chat.js / settings.js）
Object.assign(CloudDrop.prototype, ChatMixin);
Object.assign(CloudDrop.prototype, SettingsMixin);

// Initialize app
const app = new CloudDrop();
app.init().catch(console.error);

