/**
 * CloudDrop - SettingsMixin（mixin 方式挂载到 CloudDrop 类）
 */
import { i18n } from './i18n.js';
import * as ui from './ui.js';
import { debugLog } from './logger.js';
import { STORAGE_KEYS, DEFAULT_SETTINGS } from './config.js';

export const SettingsMixin = {
  loadSettings() {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.SETTINGS);
      return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : { ...DEFAULT_SETTINGS };
    } catch (e) {
      console.warn('Failed to load settings:', e);
      return { ...DEFAULT_SETTINGS };
    }
  },

  saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(this.settings));
    } catch (e) {
      console.warn('Failed to save settings:', e);
    }
  },

  updateSetting(key, value) {
    this.settings[key] = value;
    this.saveSettings();
    if (key === 'theme') {
      this.applyThemeSetting();
      this.syncThemeToUI('modal');
      this.syncThemeToUI('popover');
      return;
    }
    this.applySettingToWebRTC(key, value);
  },

  clampTimeout(value) {
    return Math.max(1, Math.min(60, value));
  },

  applySettingToWebRTC(key, value) {
    if (!this.webrtc) return;
    switch (key) {
      case 'allowRelayFallback':
        this.webrtc.setRelayFallbackEnabled(value);
        break;
      case 'relayFallbackTimeout':
        this.webrtc.setRelayFallbackTimeout(value);
        break;
      case 'enablePrewarm':
        this.webrtc.setPrewarmEnabled(value);
        break;
    }
  },

  applyAllSettingsToWebRTC() {
    if (!this.webrtc) return;
    this.applySettingToWebRTC('allowRelayFallback', this.settings.allowRelayFallback);
    this.applySettingToWebRTC('relayFallbackTimeout', this.settings.relayFallbackTimeout);
    this.applySettingToWebRTC('enablePrewarm', this.settings.enablePrewarm);
  },

  applyThemeSetting() {
    const theme = this.settings.theme || 'system';
    const resolvedTheme = this.resolveTheme(theme);
    this.applyTheme(resolvedTheme);
  },

  resolveTheme(theme) {
    if (theme === 'system') {
      if (this.themeMediaQuery) {
        return this.themeMediaQuery.matches ? 'dark' : 'light';
      }
      return 'dark';
    }
    return theme === 'light' ? 'light' : 'dark';
  },

  applyTheme(theme) {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
    root.style.colorScheme = theme;
    this.updateThemeMetaColor(theme);
  },

  updateThemeMetaColor(theme) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    meta.setAttribute('content', theme === 'dark' ? '#0f0f23' : '#f4f6f8');
  },

  loadTrustedDevices() {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.TRUSTED_DEVICES);
      return saved ? new Map(JSON.parse(saved)) : new Map();
    } catch (e) {
      console.warn('Failed to load trusted devices:', e);
      return new Map();
    }
  },

  saveTrustedDevices() {
    try {
      localStorage.setItem(STORAGE_KEYS.TRUSTED_DEVICES,
        JSON.stringify(Array.from(this.trustedDevices.entries())));
    } catch (e) {
      console.warn('Failed to save trusted devices:', e);
    }
  },

  getDeviceFingerprint(peer) {
    if (peer.deviceKey && cryptoManager.isIdentityPersistent()) {
      return this.hashFingerprint(`key:${peer.deviceKey}`);
    }
    return this.getLegacyDeviceFingerprint(peer);
  },

  getLegacyDeviceFingerprint(peer) {
    return this.hashFingerprint(`${peer.name}|${peer.deviceType}|${peer.browserInfo || ''}`);
  },

  hashFingerprint(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(16);
  },

  isDeviceTrusted(peer) {
    const fingerprint = this.getDeviceFingerprint(peer);
    if (this.trustedDevices.has(fingerprint)) return true;
    const legacyFingerprint = this.getLegacyDeviceFingerprint(peer);
    return legacyFingerprint !== fingerprint && this.trustedDevices.has(legacyFingerprint);
  },

  trustDevice(peer) {
    const fingerprint = this.getDeviceFingerprint(peer);
    this.trustedDevices.set(fingerprint, {
      name: peer.name,
      deviceType: peer.deviceType,
      browserInfo: peer.browserInfo,
      trustedAt: Date.now()
    });
    this.saveTrustedDevices();
    this.updateTrustedBadge(peer.id, true);
    ui.showToast(i18n.t('toast.trusted', { name: peer.name }), 'success');
  },

  untrustDevice(peer) {
    const fingerprint = this.getDeviceFingerprint(peer);
    this.trustedDevices.delete(fingerprint);
    this.saveTrustedDevices();
    this.updateTrustedBadge(peer.id, false);
  },

  updateTrustedBadge(peerId, trusted) {
    const card = document.querySelector(`[data-peer-id="${peerId}"]`);
    if (!card) return;

    const existingBadge = card.querySelector('.peer-trusted-badge');

    if (trusted && !existingBadge) {
      const badge = document.createElement('div');
      badge.className = 'peer-trusted-badge';
      badge.title = i18n.t('settings.clickToUntrust');
      badge.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>`;

      // Click to untrust
      badge.addEventListener('click', async (e) => {
        e.stopPropagation();
        const peer = this.peers.get(peerId);
        if (!peer) return;

        const confirmed = await ui.showConfirmDialog({
          title: i18n.t('settings.untrust'),
          message: i18n.t('settings.confirmUntrust', { name: ui.escapeHtml(peer.name) }),
          confirmText: i18n.t('settings.untrust'),
          cancelText: i18n.t('settings.keepTrust'),
          type: 'warning'
        });

        if (confirmed) {
          this.untrustDevice(peer);
          ui.showToast(i18n.t('toast.untrusted', { name: peer.name }), 'info');
        }
      });

      card.appendChild(badge);
    } else if (!trusted && existingBadge) {
      existingBadge.remove();
    }
  },

  getTrustedDevicesList() {
    return Array.from(this.trustedDevices.entries()).map(([fingerprint, info]) => ({
      fingerprint,
      ...info
    }));
  },

  removeTrustedDevice(fingerprint) {
    const info = this.trustedDevices.get(fingerprint);
    this.trustedDevices.delete(fingerprint);
    this.saveTrustedDevices();

    // Update any matching peer cards
    for (const [peerId, peer] of this.peers.entries()) {
      if (this.getDeviceFingerprint(peer) === fingerprint) {
        this.updateTrustedBadge(peerId, false);
      }
    }

    return info;
  },

  renderTrustedDevicesList() {
    const container = document.getElementById('trustedDevicesList');
    if (!container) return;

    const devices = this.getTrustedDevicesList();

    if (devices.length === 0) {
      container.innerHTML = `<p class="trusted-empty">${i18n.t('settings.noTrustedDevices')}</p>`;
      return;
    }

    const deviceTypeIcons = {
      desktop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
      mobile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/></svg>',
      tablet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M12 18h.01"/></svg>'
    };

    container.innerHTML = devices.map(device => `
      <div class="trusted-device-item" data-fingerprint="${device.fingerprint}">
        <div class="trusted-device-info">
          <div class="trusted-device-icon">
            ${deviceTypeIcons[device.deviceType] || deviceTypeIcons.desktop}
          </div>
          <div class="trusted-device-details">
            <div class="trusted-device-name">${ui.escapeHtml(device.name)}</div>
            <div class="trusted-device-meta">${device.browserInfo || i18n.t('settings.unknownBrowser')}</div>
          </div>
        </div>
        <button class="btn-untrust" title="${i18n.t('settings.untrust')}" data-fingerprint="${device.fingerprint}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>
    `).join('');

    // Add click handlers for untrust buttons
    container.querySelectorAll('.btn-untrust').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const fingerprint = e.currentTarget.dataset.fingerprint;
        const deviceInfo = this.trustedDevices.get(fingerprint);

        if (!deviceInfo) return;

        const confirmed = await ui.showConfirmDialog({
          title: i18n.t('settings.untrust'),
          message: i18n.t('settings.confirmUntrust', { name: ui.escapeHtml(deviceInfo.name) }),
          confirmText: i18n.t('settings.untrust'),
          cancelText: i18n.t('settings.keepTrust'),
          type: 'warning'
        });

        if (confirmed) {
          const info = this.removeTrustedDevice(fingerprint);
          if (info) {
            ui.showToast(i18n.t('toast.untrusted', { name: info.name }), 'info');
          }
          this.renderTrustedDevicesList();
        }
      });
    });
  },

  setupSettingsPopover() {
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsPopover = document.getElementById('settingsPopover');
    const settingsPopoverClose = document.getElementById('settingsPopoverClose');

    if (!settingsBtn || !settingsPopover) return;

    // 打开设置 Popover
    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // 先同步设置值到桌面端 Popover 控件
      this.syncSettingsToUI('popover');
      this.syncTrustedDevicesToUI('popover');
      settingsPopover.classList.toggle('active');
    });

    // 关闭按钮
    settingsPopoverClose?.addEventListener('click', () => {
      settingsPopover.classList.remove('active');
    });

    // 点击外部关闭
    document.addEventListener('click', (e) => {
      if (!settingsPopover.contains(e.target) && !settingsBtn.contains(e.target)) {
        settingsPopover.classList.remove('active');
      }
    });
  },

  setupSettingsControls() {
    // 移动端设置模态框打开时同步设置值
    document.getElementById('navSettings')?.addEventListener('click', () => {
      this.syncSettingsToUI('modal');
      this.syncTrustedDevicesToUI('modal');
    });

    // Theme controls - mobile
    const themeInputsModal = document.querySelectorAll('input[name="theme-modal"]');
    themeInputsModal.forEach((input) => {
      input.addEventListener('change', (e) => {
        if (!e.target.checked) return;
        this.updateSetting('theme', e.target.value);
        this.syncThemeToUI('popover');
      });
    });

    // Theme controls - desktop popover
    const themeInputsPopover = document.querySelectorAll('input[name="theme-popover"]');
    themeInputsPopover.forEach((input) => {
      input.addEventListener('change', (e) => {
        if (!e.target.checked) return;
        this.updateSetting('theme', e.target.value);
        this.syncThemeToUI('modal');
      });
    });

    // 中继降级开关 - 移动端
    const relayFallbackToggle = document.getElementById('settingsRelayFallback');
    const relayTimeoutRow = document.getElementById('relayTimeoutRow');
    relayFallbackToggle?.addEventListener('change', (e) => {
      this.updateSetting('allowRelayFallback', e.target.checked);
      if (relayTimeoutRow) {
        relayTimeoutRow.style.display = e.target.checked ? 'flex' : 'none';
      }
      // 同步到桌面端
      const popoverToggle = document.getElementById('popoverRelayFallback');
      if (popoverToggle) popoverToggle.checked = e.target.checked;
    });

    // 中继降级开关 - 桌面端
    const popoverRelayFallbackToggle = document.getElementById('popoverRelayFallback');
    const popoverRelayTimeoutRow = document.getElementById('popoverRelayTimeoutRow');
    popoverRelayFallbackToggle?.addEventListener('change', (e) => {
      this.updateSetting('allowRelayFallback', e.target.checked);
      if (popoverRelayTimeoutRow) {
        popoverRelayTimeoutRow.style.display = e.target.checked ? 'flex' : 'none';
      }
      // 同步到移动端
      if (relayFallbackToggle) relayFallbackToggle.checked = e.target.checked;
    });

    // 降级超时控件 - 移动端
    const relayTimeoutSlider = document.getElementById('settingsRelayTimeoutSlider');
    const relayTimeoutInput = document.getElementById('settingsRelayTimeout');

    // 滑块拖动时同步输入框
    relayTimeoutSlider?.addEventListener('input', (e) => {
      const value = parseInt(e.target.value);
      if (relayTimeoutInput) relayTimeoutInput.value = value;
      // 同步到桌面端
      const popoverSlider = document.getElementById('popoverRelayTimeoutSlider');
      const popoverInput = document.getElementById('popoverRelayTimeout');
      if (popoverSlider) popoverSlider.value = value;
      if (popoverInput) popoverInput.value = value;
    });
    relayTimeoutSlider?.addEventListener('change', (e) => {
      this.updateSetting('relayFallbackTimeout', parseInt(e.target.value));
    });

    // 输入框修改时同步滑块
    relayTimeoutInput?.addEventListener('change', (e) => {
      const value = this.clampTimeout(parseInt(e.target.value) || 5);
      e.target.value = value;
      if (relayTimeoutSlider) relayTimeoutSlider.value = value;
      this.updateSetting('relayFallbackTimeout', value);
      // 同步到桌面端
      const popoverSlider = document.getElementById('popoverRelayTimeoutSlider');
      const popoverInput = document.getElementById('popoverRelayTimeout');
      if (popoverSlider) popoverSlider.value = value;
      if (popoverInput) popoverInput.value = value;
    });

    // 降级超时控件 - 桌面端
    const popoverRelayTimeoutSlider = document.getElementById('popoverRelayTimeoutSlider');
    const popoverRelayTimeoutInput = document.getElementById('popoverRelayTimeout');

    // 滑块拖动时同步输入框
    popoverRelayTimeoutSlider?.addEventListener('input', (e) => {
      const value = parseInt(e.target.value);
      if (popoverRelayTimeoutInput) popoverRelayTimeoutInput.value = value;
      // 同步到移动端
      if (relayTimeoutSlider) relayTimeoutSlider.value = value;
      if (relayTimeoutInput) relayTimeoutInput.value = value;
    });
    popoverRelayTimeoutSlider?.addEventListener('change', (e) => {
      this.updateSetting('relayFallbackTimeout', parseInt(e.target.value));
    });

    // 输入框修改时同步滑块
    popoverRelayTimeoutInput?.addEventListener('change', (e) => {
      const value = this.clampTimeout(parseInt(e.target.value) || 5);
      e.target.value = value;
      if (popoverRelayTimeoutSlider) popoverRelayTimeoutSlider.value = value;
      this.updateSetting('relayFallbackTimeout', value);
      // 同步到移动端
      if (relayTimeoutSlider) relayTimeoutSlider.value = value;
      if (relayTimeoutInput) relayTimeoutInput.value = value;
    });

    // 连接预热开关 - 移动端
    const prewarmToggle = document.getElementById('settingsPrewarm');
    prewarmToggle?.addEventListener('change', (e) => {
      this.updateSetting('enablePrewarm', e.target.checked);
      // 同步到桌面端
      const popoverToggle = document.getElementById('popoverPrewarm');
      if (popoverToggle) popoverToggle.checked = e.target.checked;
    });

    // 连接预热开关 - 桌面端
    const popoverPrewarmToggle = document.getElementById('popoverPrewarm');
    popoverPrewarmToggle?.addEventListener('change', (e) => {
      this.updateSetting('enablePrewarm', e.target.checked);
      // 同步到移动端
      if (prewarmToggle) prewarmToggle.checked = e.target.checked;
    });

    // 浏览器通知开关 - 移动端
    const notificationsToggle = document.getElementById('settingsNotifications');
    notificationsToggle?.addEventListener('change', async (e) => {
      const enabled = e.target.checked;

      // 如果启用，请求通知权限
      if (enabled) {
        const granted = await ui.requestNotificationPermission();
        if (!granted) {
          // 权限被拒绝，取消选中
          e.target.checked = false;
          ui.showToast(i18n.t('toast.notificationPermissionDenied') || '浏览器通知权限被拒绝', 'warning');
          return;
        }
      }

      this.updateSetting('enableNotifications', enabled);
      // 同步到桌面端
      const popoverToggle = document.getElementById('popoverNotifications');
      if (popoverToggle) popoverToggle.checked = enabled;
    });

    // 浏览器通知开关 - 桌面端
    const popoverNotificationsToggle = document.getElementById('popoverNotifications');
    popoverNotificationsToggle?.addEventListener('change', async (e) => {
      const enabled = e.target.checked;

      // 如果启用，请求通知权限
      if (enabled) {
        const granted = await ui.requestNotificationPermission();
        if (!granted) {
          // 权限被拒绝，取消选中
          e.target.checked = false;
          ui.showToast(i18n.t('toast.notificationPermissionDenied') || '浏览器通知权限被拒绝', 'warning');
          return;
        }
      }

      this.updateSetting('enableNotifications', enabled);
      // 同步到移动端
      if (notificationsToggle) notificationsToggle.checked = enabled;
    });
  },

  syncSettingsToUI(target) {
    // 中继降级开关
    const relayToggle = document.getElementById(target === 'popover' ? 'popoverRelayFallback' : 'settingsRelayFallback');
    if (relayToggle) relayToggle.checked = this.settings.allowRelayFallback;

    // 超时控件行的显示/隐藏
    const timeoutRow = document.getElementById(target === 'popover' ? 'popoverRelayTimeoutRow' : 'relayTimeoutRow');
    if (timeoutRow) timeoutRow.style.display = this.settings.allowRelayFallback ? 'flex' : 'none';

    // 超时滑块和输入框值
    const timeoutSlider = document.getElementById(target === 'popover' ? 'popoverRelayTimeoutSlider' : 'settingsRelayTimeoutSlider');
    const timeoutInput = document.getElementById(target === 'popover' ? 'popoverRelayTimeout' : 'settingsRelayTimeout');
    if (timeoutSlider) timeoutSlider.value = this.settings.relayFallbackTimeout;
    if (timeoutInput) timeoutInput.value = this.settings.relayFallbackTimeout;

    // 预热开关
    const prewarmToggle = document.getElementById(target === 'popover' ? 'popoverPrewarm' : 'settingsPrewarm');
    if (prewarmToggle) prewarmToggle.checked = this.settings.enablePrewarm;

    // 通知开关
    const notificationsToggle = document.getElementById(target === 'popover' ? 'popoverNotifications' : 'settingsNotifications');
    if (notificationsToggle) notificationsToggle.checked = this.settings.enableNotifications;

    // 主题切换
    this.syncThemeToUI(target);
  },

  syncThemeToUI(target) {
    const groupName = target === 'popover' ? 'theme-popover' : 'theme-modal';
    const theme = this.settings.theme || 'system';
    const input = document.querySelector(`input[name="${groupName}"][value="${theme}"]`);
    if (input) input.checked = true;
  },

  syncTrustedDevicesToUI(target) {
    const containerId = target === 'popover' ? 'popoverTrustedDevicesList' : 'trustedDevicesList';
    const container = document.getElementById(containerId);
    if (!container) return;

    const devices = this.getTrustedDevicesList();

    if (devices.length === 0) {
      container.innerHTML = `<p class="${target === 'popover' ? 'settings-popover-empty' : 'trusted-empty'}" data-i18n="settings.noTrustedDevices">${i18n.t('settings.noTrustedDevices')}</p>`;
      return;
    }

    container.innerHTML = devices.map(device => `
      <div class="trusted-device-item" data-fingerprint="${device.fingerprint}">
        <div class="trusted-device-info">
          <span class="trusted-device-name">${ui.escapeHtml(device.name)}</span>
          <span class="trusted-device-type">${device.browserInfo || i18n.t('settings.unknownBrowser')}</span>
        </div>
        <button class="btn-untrust" data-fingerprint="${device.fingerprint}" title="${i18n.t('settings.untrust')}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>
    `).join('');

    // 添加取消信任按钮事件
    container.querySelectorAll('.btn-untrust').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const fingerprint = btn.dataset.fingerprint;
        const info = this.removeTrustedDevice(fingerprint);
        if (info) {
          ui.showToast(i18n.t('toast.untrusted', { name: info.name }), 'info');
        }
        // 刷新两个列表
        this.syncTrustedDevicesToUI('popover');
        this.syncTrustedDevicesToUI('modal');
      });
    });
  },
};
