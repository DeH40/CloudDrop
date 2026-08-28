/**
 * CloudDrop - SettingsMixin（mixin 方式挂载到 CloudDrop 类）
 */
import { i18n } from './i18n.js';
import * as ui from './ui.js';
import { debugLog } from './logger.js';
import { STORAGE_KEYS, DEFAULT_SETTINGS } from './config.js';
import { cryptoManager } from './crypto.js';

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

  async getDeviceFingerprint(peer) {
    // 仅认可持久设备公钥的 SHA-256 指纹（256 位）：无 deviceKey /
    // 身份未持久化时返回 null，不提供可伪造的名称指纹回退
    if (peer.deviceKey && cryptoManager.isIdentityPersistent()) {
      const hashBuffer = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`key:${peer.deviceKey}`)
      );
      return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0')).join('');
    }
    return null;
  },

  async isDeviceTrusted(peer) {
    // 仅认可密钥指纹：旧客户端（无 deviceKey）不自动接收，需人工确认
    const fingerprint = await this.getDeviceFingerprint(peer);
    return !!fingerprint && this.trustedDevices.has(fingerprint);
  },

  /**
   * 设备密钥变化检测：同名 + 同浏览器信息但公钥指纹与已信任记录不一致，
   * 提示用户重新验证。注意：不自动删除旧信任记录——名称/浏览器信息可被
   * 同房间攻击者伪造，自动撤销会变成信任 DoS；由用户在弹窗中人工处理。
   */
  async detectKeyChange(peer) {
    const fingerprint = await this.getDeviceFingerprint(peer);
    if (!fingerprint) return false;

    for (const [oldFp, info] of this.trustedDevices.entries()) {
      if (oldFp === fingerprint) continue;
      if (info.name === peer.name && info.browserInfo === (peer.browserInfo || '')) {
        return true;
      }
    }
    return false;
  },

  async trustDevice(peer) {
    const fingerprint = await this.getDeviceFingerprint(peer);
    if (!fingerprint) {
      // 无法证明设备身份（旧客户端/身份未持久化）：不建立信任
      ui.showToast(i18n.t('settings.trustRequiresDeviceKey') || '对方设备不支持身份验证，无法信任', 'warning');
      return;
    }
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

  async untrustDevice(peer) {
    const fingerprint = await this.getDeviceFingerprint(peer);
    if (!fingerprint) return;
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
      // CSS 悬浮提示原先把「取消信任」硬编码在 content 里，无法翻译
      badge.dataset.tooltip = i18n.t('settings.untrust');
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
          await this.untrustDevice(peer);
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

  async removeTrustedDevice(fingerprint) {
    const info = this.trustedDevices.get(fingerprint);
    this.trustedDevices.delete(fingerprint);
    this.saveTrustedDevices();

    // Update any matching peer cards
    for (const [peerId, peer] of this.peers.entries()) {
      if (await this.getDeviceFingerprint(peer) === fingerprint) {
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
            <div class="trusted-device-meta">${ui.escapeHtml(device.browserInfo || '') || i18n.t('settings.unknownBrowser')}</div>
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
          const info = await this.removeTrustedDevice(fingerprint);
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

    // 主题选择：两端面板共用绑定逻辑，变更即同步另一面板
    this._bindThemeControls('theme-modal', 'theme-popover');
    this._bindThemeControls('theme-popover', 'theme-modal');

    // 布尔开关：两端同键双向同步（声明式配置，替代逐开关重复样板）
    this._bindToggleSync('settingsRelayFallback', 'popoverRelayFallback', 'allowRelayFallback',
      ['relayTimeoutRow', 'popoverRelayTimeoutRow']);
    this._bindToggleSync('settingsPrewarm', 'popoverPrewarm', 'enablePrewarm');
    this._bindToggleSync('settingsNotifications', 'popoverNotifications', 'enableNotifications', null, true);

    // 降级超时：两端滑块+输入框四控件双向同步
    this._bindTimeoutSync('settingsRelayTimeoutSlider', 'settingsRelayTimeout',
      'popoverRelayTimeoutSlider', 'popoverRelayTimeout');
  },

  /**
   * 绑定主题单选框：本面板变更 -> 保存设置 + 同步另一面板
   */
  _bindThemeControls(groupName, otherGroupName) {
    const otherTarget = otherGroupName === 'theme-popover' ? 'popover' : 'modal';
    document.querySelectorAll(`input[name="${groupName}"]`).forEach((input) => {
      input.addEventListener('change', (e) => {
        if (!e.target.checked) return;
        this.updateSetting('theme', e.target.value);
        this.syncThemeToUI(otherTarget);
      });
    });
  },

  /**
   * 绑定一对布尔开关（移动端/桌面端）：变更 -> 保存 + 同步对端 + 联动行显隐
   * @param {string} idA - 面板 A 控件 id
   * @param {string} idB - 面板 B 控件 id
   * @param {string} settingKey - 设置键
   * @param {string[]|null} rowIds - [A 行 id, B 行 id]，联动显示/隐藏
   * @param {boolean} requestPermission - 开启前请求浏览器权限（通知）
   */
  _bindToggleSync(idA, idB, settingKey, rowIds = null, requestPermission = false) {
    const bind = (toggleId, otherId, ownRowId, otherRowId) => {
      const toggle = document.getElementById(toggleId);
      if (!toggle) return;

      toggle.addEventListener('change', async (e) => {
        const enabled = e.target.checked;

        if (requestPermission && enabled) {
          const granted = await ui.requestNotificationPermission();
          if (!granted) {
            e.target.checked = false;
            ui.showToast(i18n.t('toast.notificationPermissionDenied') || '浏览器通知权限被拒绝', 'warning');
            return;
          }
        }

        this.updateSetting(settingKey, enabled);

        if (ownRowId) {
          const row = document.getElementById(ownRowId);
          if (row) row.style.display = enabled ? 'flex' : 'none';
        }

        const other = document.getElementById(otherId);
        if (other) other.checked = enabled;

        if (otherRowId) {
          const otherRow = document.getElementById(otherRowId);
          if (otherRow) otherRow.style.display = enabled ? 'flex' : 'none';
        }
      });
    };

    bind(idA, idB, rowIds ? rowIds[0] : null, rowIds ? rowIds[1] : null);
    bind(idB, idA, rowIds ? rowIds[1] : null, rowIds ? rowIds[0] : null);
  },

  /**
   * 绑定降级超时滑块+输入框：两端四个控件双向同步
   */
  _bindTimeoutSync(sliderIdA, inputIdA, sliderIdB, inputIdB) {
    const sliders = [document.getElementById(sliderIdA), document.getElementById(sliderIdB)].filter(Boolean);
    const inputs = [document.getElementById(inputIdA), document.getElementById(inputIdB)].filter(Boolean);

    sliders.forEach((slider) => {
      slider.addEventListener('input', (e) => {
        const value = parseInt(e.target.value);
        inputs.forEach((i) => { i.value = value; });
        sliders.forEach((s) => { if (s !== e.target) s.value = value; });
      });
      slider.addEventListener('change', (e) => {
        this.updateSetting('relayFallbackTimeout', parseInt(e.target.value));
      });
    });

    inputs.forEach((input) => {
      input.addEventListener('change', (e) => {
        const value = this.clampTimeout(parseInt(e.target.value) || 5);
        e.target.value = value;
        inputs.forEach((i) => { if (i !== e.target) i.value = value; });
        sliders.forEach((s) => { s.value = value; });
        this.updateSetting('relayFallbackTimeout', value);
      });
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
          <span class="trusted-device-type">${ui.escapeHtml(device.browserInfo || '') || i18n.t('settings.unknownBrowser')}</span>
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
        const info = await this.removeTrustedDevice(fingerprint);
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
