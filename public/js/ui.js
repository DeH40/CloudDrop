/**
 * CloudDrop - UI Utilities Module
 */

// Import i18n for dynamic content translation
import { i18n } from './i18n.js';
import { debugLog } from './logger.js';

// Export i18n for use in other modules
export { i18n };

/**
 * Generate QR code and draw to canvas using qrcode-generator library
 * @param {HTMLCanvasElement} canvas - Canvas element
 * @param {string} text - Text to encode
 * @param {Object} options - Options
 */
export function generateQRCode(canvas, text, options = {}) {
  const {
    size = 160,
    darkColor = '#000000',
    lightColor = '#ffffff'
  } = options;
  
  // Use qrcode-generator library (self-hosted at /vendor/qrcode.min.js)
  // Type 0 = auto-detect version, 'M' = medium error correction
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  
  const ctx = canvas.getContext('2d');
  canvas.width = size;
  canvas.height = size;
  
  const moduleCount = qr.getModuleCount();
  const cellSize = size / moduleCount;
  
  // Draw background
  ctx.fillStyle = lightColor;
  ctx.fillRect(0, 0, size, size);
  
  // Draw modules
  ctx.fillStyle = darkColor;
  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (qr.isDark(row, col)) {
        ctx.fillRect(
          col * cellSize,
          row * cellSize,
          cellSize + 0.5,
          cellSize + 0.5
        );
      }
    }
  }
}

// Device Icons
export const deviceIcons = {
  desktop: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`,
  mobile: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/></svg>`,
  tablet: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M12 18h.01"/></svg>`
};

// Escape HTML
export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Format file size
export function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

// Format speed
export function formatSpeed(bps) {
  if (bps === 0) return '0 B/s';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const k = 1024;
  const i = Math.floor(Math.log(bps) / Math.log(k));
  return `${(bps / Math.pow(k, i)).toFixed(1)} ${units[i]}`;
}

// Detect device type
export function detectDeviceType() {
  const ua = navigator.userAgent.toLowerCase();
  if (/(tablet|ipad|playbook|silk)|(android(?!.*mobi))/i.test(ua)) return 'tablet';
  if (/mobile|android|iphone|ipod|blackberry|opera mini|iemobile/i.test(ua)) return 'mobile';
  return 'desktop';
}

/**
 * Get detailed device and browser info from UserAgent
 */
export function getDetailedDeviceInfo() {
  const ua = navigator.userAgent;
  let browser = '未知浏览器';
  let os = '未知系统';

  // Detect OS
  if (ua.indexOf('Win') !== -1) os = 'Windows';
  else if (ua.indexOf('Mac') !== -1) os = 'macOS';
  else if (ua.indexOf('Linux') !== -1) os = 'Linux';
  else if (ua.indexOf('Android') !== -1) os = 'Android';
  else if (ua.indexOf('like Mac') !== -1) os = 'iOS';

  // Detect Browser
  if (ua.indexOf('Chrome') !== -1 && ua.indexOf('Edg') === -1) browser = 'Chrome';
  else if (ua.indexOf('Safari') !== -1 && ua.indexOf('Chrome') === -1) browser = 'Safari';
  else if (ua.indexOf('Firefox') !== -1) browser = 'Firefox';
  else if (ua.indexOf('Edg') !== -1) browser = 'Edge';
  else if (ua.indexOf('OPR') !== -1 || ua.indexOf('Opera') !== -1) browser = 'Opera';

  return `${browser} on ${os}`;
}

// Generate display name using i18n
export function generateDisplayName() {
  const adjectives = i18n.t('deviceNames.adjectives');
  const nouns = i18n.t('deviceNames.nouns');

  // Fallback if translations not loaded yet
  const defaultAdj = ['敏捷', '明亮', '酷炫', '迅速', '优雅', '飞速', '灵动', '沉稳'];
  const defaultNoun = ['凤凰', '麒麟', '玄武', '青龙', '朱雀', '天马', '神鹿', '白虎'];

  const adj = Array.isArray(adjectives) ? adjectives : defaultAdj;
  const noun = Array.isArray(nouns) ? nouns : defaultNoun;

  const randomAdj = adj[Math.floor(Math.random() * adj.length)];
  const randomNoun = noun[Math.floor(Math.random() * noun.length)];

  // For English, add space between words
  const locale = i18n.getCurrentLocale();
  return locale === 'en' ? `${randomAdj} ${randomNoun}` : `${randomAdj}${randomNoun}`;
}

// Connection mode icons
export const connectionModeIcons = {
  p2p: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="12" r="3"/><circle cx="18" cy="12" r="3"/><path d="M9 12h6"/></svg>`,
  relay: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="5" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="12" cy="6" r="2"/><path d="M7 12h2M15 12h2M12 8v2"/></svg>`,
  connecting: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin"><circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="12"/></svg>`,
  waiting: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`
};

// File type icons
export const fileTypeIcons = {
  image: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`,
  video: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>`,
  audio: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
  document: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>`,
  archive: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 8v13H3V8"/><path d="M23 3H1v5h22V3z"/><path d="M10 12h4"/></svg>`,
  code: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
  default: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`
};

/**
 * Get file type category and label from filename
 * @param {string} filename - File name
 * @returns {{ type: string, label: string }} File type info
 */
export function getFileTypeInfo(filename) {
  const ext = filename.split('.').pop()?.toLowerCase() || '';

  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'heif'];
  const videoExts = ['mp4', 'webm', 'avi', 'mov', 'mkv', 'flv', 'wmv', 'm4v'];
  const audioExts = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma'];
  const documentExts = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'odt'];
  const archiveExts = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'];
  const codeExts = ['js', 'ts', 'py', 'java', 'cpp', 'c', 'h', 'css', 'html', 'json', 'xml', 'yml', 'yaml', 'sh', 'rb', 'go', 'rs', 'swift', 'kt'];

  if (imageExts.includes(ext)) return { type: 'image', label: i18n.t('fileTypes.image') };
  if (videoExts.includes(ext)) return { type: 'video', label: i18n.t('fileTypes.video') };
  if (audioExts.includes(ext)) return { type: 'audio', label: i18n.t('fileTypes.audio') };
  if (documentExts.includes(ext)) return { type: 'document', label: i18n.t('fileTypes.document') };
  if (archiveExts.includes(ext)) return { type: 'archive', label: i18n.t('fileTypes.archive') };
  if (codeExts.includes(ext)) return { type: 'code', label: i18n.t('fileTypes.code') };

  return { type: 'default', label: ext.toUpperCase() || i18n.t('fileTypes.file') };
}

/**
 * Update the receive confirmation modal with file and sender info
 * @param {Object} options - Options
 */
export function updateReceiveModal({ senderName, senderDeviceType, senderBrowserInfo, fileName, fileSize, mode }) {
  // Update sender info
  const senderNameEl = document.getElementById('senderName');
  const senderDeviceInfoEl = document.getElementById('senderDeviceInfo');
  const senderAvatarEl = document.getElementById('senderAvatar');

  if (senderNameEl) senderNameEl.textContent = senderName || i18n.t('deviceTypes.unknown');
  if (senderDeviceInfoEl) senderDeviceInfoEl.textContent = senderBrowserInfo || getDeviceLabel(senderDeviceType);

  if (senderAvatarEl) {
    senderAvatarEl.className = `sender-avatar ${senderDeviceType || 'desktop'}`;
    senderAvatarEl.innerHTML = deviceIcons[senderDeviceType] || deviceIcons.desktop;
  }

  // Update file info
  const fileNameEl = document.getElementById('receiveFileName');
  const fileSizeEl = document.getElementById('receiveFileSize');
  const fileTypeEl = document.getElementById('receiveFileType');
  const fileIconEl = document.getElementById('fileIconLarge');

  if (fileNameEl) fileNameEl.textContent = fileName || i18n.t('fileTypes.file');
  if (fileSizeEl) fileSizeEl.textContent = formatFileSize(fileSize || 0);

  const fileTypeInfo = getFileTypeInfo(fileName || '');
  if (fileTypeEl) fileTypeEl.textContent = fileTypeInfo.label;

  if (fileIconEl) {
    fileIconEl.className = `file-icon-large ${fileTypeInfo.type}`;
    fileIconEl.innerHTML = fileTypeIcons[fileTypeInfo.type] || fileTypeIcons.default;
  }

  // Update transfer mode badge
  const modeBadge = document.getElementById('receiveModeBadge');
  if (modeBadge) {
    modeBadge.dataset.mode = mode || 'p2p';
    const modeIcon = modeBadge.querySelector('.mode-icon');
    const modeText = modeBadge.querySelector('.mode-text');

    if (mode === 'relay') {
      if (modeIcon) modeIcon.innerHTML = connectionModeIcons.relay;
      if (modeText) modeText.textContent = i18n.t('transfer.modes.relay');
    } else {
      if (modeIcon) modeIcon.innerHTML = connectionModeIcons.p2p;
      if (modeText) modeText.textContent = i18n.t('transfer.modes.p2p');
    }
  }
}

/**
 * Get device label from device type
 */
function getDeviceLabel(deviceType) {
  const key = `deviceTypes.${deviceType}`;
  return i18n.t(key);
}

/**
 * Trigger notification (vibration and/or sound)
 * @param {'file' | 'message'} type - Notification type
 */
export function triggerNotification(type = 'file') {
  // Vibration
  if ('vibrate' in navigator) {
    if (type === 'file') {
      navigator.vibrate([100, 50, 100]); // Double pulse for file
    } else {
      navigator.vibrate(50); // Short pulse for message
    }
  }

  // Optional: Play sound (if we add audio assets later)
  // Could use Web Audio API or Audio element
}

/**
 * Request browser notification permission
 * @returns {Promise<boolean>} - Returns true if permission granted
 */
export async function requestNotificationPermission() {
  if (!('Notification' in window)) {
    debugLog('[UI] Browser does not support notifications');
    return false;
  }

  if (Notification.permission === 'granted') {
    return true;
  }

  if (Notification.permission !== 'denied') {
    const permission = await Notification.requestPermission();
    return permission === 'granted';
  }

  return false;
}

/**
 * Show browser notification for file or message
 * @param {Object} options - Notification options
 * @param {'file' | 'message'} options.type - Notification type
 * @param {string} options.title - Notification title
 * @param {string} options.body - Notification body
 * @param {string} options.senderName - Sender name (optional)
 * @param {string} options.fileName - File name (for file type, optional)
 */
export function showBrowserNotification(options = {}) {
  // Check if notifications are supported
  if (!('Notification' in window)) {
    debugLog('[UI] Browser does not support notifications');
    return;
  }

  // Check if permission is granted
  if (Notification.permission !== 'granted') {
    debugLog('[UI] Notification permission not granted');
    return;
  }

  const {
    type = 'file',
    title = 'CloudDrop',
    body = '',
    senderName = '',
    fileName = ''
  } = options;

  // Build notification title and body
  let notificationTitle = title;
  let notificationBody = body;

  if (type === 'file' && senderName && fileName) {
    notificationTitle = i18n.t('notification.fileReceived') || '收到新文件';
    notificationBody = i18n.t('notification.fileReceivedBody', { sender: senderName, file: fileName }) || `${senderName} 发送了文件：${fileName}`;
  } else if (type === 'message' && senderName) {
    notificationTitle = i18n.t('notification.messageReceived') || '收到新消息';
    notificationBody = i18n.t('notification.messageReceivedBody', { sender: senderName }) || `${senderName} 发送了一条消息`;
  }

  // Create notification
  try {
    const notification = new Notification(notificationTitle, {
      body: notificationBody,
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      tag: `clouddrop-${type}`,
      requireInteraction: false,
      silent: false,
    });

    // Auto close after 5 seconds
    setTimeout(() => {
      notification.close();
    }, 5000);

    // Click to focus window
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch (error) {
    console.error('[UI] Failed to show notification:', error);
  }
}

// Create peer card
export function createPeerCard(peer) {
  const card = document.createElement('div');
  card.className = 'peer-card';
  card.dataset.peerId = peer.id;
  const icon = deviceIcons[peer.deviceType] || deviceIcons.desktop;
  const deviceLabel = getDeviceLabel(peer.deviceType);
  card.innerHTML = `
    <div class="peer-avatar ${peer.deviceType}">${icon}</div>
    <div class="connection-mode-badge" data-mode="none" title="${i18n.t('transfer.modes.waiting')}">
      <span class="mode-icon"></span>
      <span class="mode-text"></span>
    </div>
    <span class="peer-name">${escapeHtml(peer.name)}</span>
    <span class="peer-device">${deviceLabel}</span>
    <span class="peer-browser">${escapeHtml(peer.browserInfo || '')}</span>
    <span class="peer-safety-code" data-role="safety-code"></span>
    <button class="peer-action-btn" data-peer-id="${peer.id}" data-action="message" title="${i18n.t('chat.placeholder')}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
    </button>
  `;
  return card;
}

/**
 * 更新设备卡片的短安全码（SAS）
 * @param {string} peerId - Peer ID
 * @param {string|null} code - 8 位十六进制安全码，null 时隐藏
 */
export function updatePeerSafetyCode(peerId, code) {
  const card = document.querySelector(`[data-peer-id="${peerId}"]`);
  if (!card) return;

  const el = card.querySelector('[data-role="safety-code"]');
  if (!el) return;

  if (!code) {
    el.classList.remove('visible');
    el.textContent = '';
    return;
  }

  el.textContent = `🔒 ${code}`;
  el.title = i18n.t('transfer.safetyCodeTitle');
  el.classList.add('visible');
}

/**
 * Update connection mode indicator on peer card
 * @param {string} peerId - Peer ID
 * @param {'p2p'|'relay'|'connecting'|'none'} mode - Connection mode
 */
export function updatePeerConnectionMode(peerId, mode) {
  const card = document.querySelector(`[data-peer-id="${peerId}"]`);
  if (!card) return;
  
  const badge = card.querySelector('.connection-mode-badge');
  if (!badge) return;
  
  badge.dataset.mode = mode;
  
  const modeConfig = {
    p2p: {
      icon: connectionModeIcons.p2p,
      title: i18n.t('transfer.modes.p2pTooltip')
    },
    relay: {
      icon: connectionModeIcons.relay,
      title: i18n.t('transfer.modes.relayTooltip')
    },
    connecting: {
      icon: connectionModeIcons.connecting,
      title: i18n.t('common.connecting')
    },
    none: {
      icon: '',
      title: i18n.t('transfer.modes.waiting')
    }
  };
  
  const config = modeConfig[mode] || modeConfig.none;
  badge.querySelector('.mode-icon').innerHTML = config.icon;
  badge.title = config.title;
}

// Add peer to grid
// Add peer to grid
export function addPeerToGrid(peer, grid, onClick) {
  // Check if peer already exists
  const existingCard = grid.querySelector(`[data-peer-id="${peer.id}"]`);
  
  const card = createPeerCard(peer);
  card.addEventListener('click', (e) => onClick(peer, e));

  if (existingCard) {
    grid.replaceChild(card, existingCard);
  } else {
    grid.appendChild(card);
  }
  
  updateEmptyState();
}

// Remove peer from grid
export function removePeerFromGrid(peerId, grid) {
  const card = grid.querySelector(`[data-peer-id="${peerId}"]`);
  if (card) {
    card.style.animation = 'scaleIn 0.3s ease reverse';
    setTimeout(() => { card.remove(); updateEmptyState(); }, 300);
  }
}

// Clear all peers from grid (used on reconnect)
export function clearPeersGrid(grid) {
  grid.innerHTML = '';
  updateEmptyState();
}

// Update empty state
export function updateEmptyState() {
  const grid = document.getElementById('peersGrid');
  const empty = document.getElementById('emptyState');
  if (grid && empty) empty.classList.toggle('hidden', grid.children.length > 0);
}

// Modal functions
export function showModal(id) {
  const m = document.getElementById(id);
  if (m) { m.classList.add('active'); document.body.style.overflow = 'hidden'; }
}

export function hideModal(id) {
  const m = document.getElementById(id);
  if (m) { m.classList.remove('active'); document.body.style.overflow = ''; }
}

/**
 * Show a styled confirm dialog
 * @param {Object} options - Dialog options
 * @param {string} options.title - Dialog title
 * @param {string} options.message - Dialog message
 * @param {string} options.confirmText - Confirm button text (default: '确定')
 * @param {string} options.cancelText - Cancel button text (default: '取消')
 * @param {string} options.type - Icon type: 'warning' | 'danger' | 'success' | 'info' (default: 'warning')
 * @param {string} options.icon - Custom SVG icon (optional)
 * @returns {Promise<boolean>} - Resolves true if confirmed, false if cancelled
 */
export function showConfirmDialog(options = {}) {
  const {
    title = '确认操作',
    message = '您确定要执行此操作吗？',
    confirmText = '确定',
    cancelText = '取消',
    type = 'warning',
    icon = null
  } = options;

  return new Promise((resolve) => {
    const dialog = document.getElementById('confirmDialog');
    const iconEl = document.getElementById('confirmIcon');
    const titleEl = document.getElementById('confirmTitle');
    const messageEl = document.getElementById('confirmMessage');
    const confirmBtn = document.getElementById('confirmOk');
    const cancelBtn = document.getElementById('confirmCancel');

    if (!dialog) {
      // Fallback to native confirm if dialog not found
      resolve(confirm(message));
      return;
    }

    // Set content
    titleEl.textContent = title;
    messageEl.innerHTML = message;
    confirmBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;

    // Set icon type
    iconEl.className = 'confirm-icon';
    if (type === 'danger') {
      iconEl.classList.add('danger');
      iconEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="12" cy="12" r="10"/>
        <path d="M15 9l-6 6M9 9l6 6"/>
      </svg>`;
    } else if (type === 'success') {
      iconEl.classList.add('success');
      iconEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        <path d="M9 12l2 2 4-4"/>
      </svg>`;
    } else if (type === 'info') {
      iconEl.classList.add('info');
      iconEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="12" cy="12" r="10"/>
        <path d="M12 16v-4M12 8h.01"/>
      </svg>`;
    } else {
      // warning (default)
      iconEl.innerHTML = icon || `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        <path d="M12 8v4M12 16h.01"/>
      </svg>`;
    }

    // Set button style based on type
    confirmBtn.className = 'btn';
    if (type === 'danger') {
      confirmBtn.classList.add('btn-danger');
    } else {
      confirmBtn.classList.add('btn-primary');
    }

    // Cleanup function
    const cleanup = () => {
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      backdrop?.removeEventListener('click', onCancel);
      hideModal('confirmDialog');
    };

    const onConfirm = () => {
      cleanup();
      resolve(true);
    };

    const onCancel = () => {
      cleanup();
      resolve(false);
    };

    // Attach event listeners
    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
    
    // Click backdrop to cancel
    const backdrop = dialog.querySelector('.modal-backdrop');
    backdrop?.addEventListener('click', onCancel);

    // Show dialog
    showModal('confirmDialog');
  });
}

export function hideAllModals() {
  document.querySelectorAll('.modal.active').forEach(m => m.classList.remove('active'));
  document.body.style.overflow = '';
}

export function setupModalCloseHandlers() {
  document.querySelectorAll('.modal-backdrop').forEach(b => {
    b.addEventListener('click', () => { b.closest('.modal')?.classList.remove('active'); document.body.style.overflow = ''; });
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hideAllModals(); });
}

// Transfer progress
export function updateTransferProgress({ fileName, fileSize, percent, speed, mode }) {
  // Remove waiting state classes when actual transfer starts
  document.querySelector('.transfer-info')?.classList.remove('waiting');
  document.querySelector('.progress-container')?.classList.remove('waiting');
  document.querySelector('.transfer-stats')?.classList.remove('waiting');

  if (fileName !== undefined) document.getElementById('transferFileName').textContent = fileName;
  if (fileSize !== undefined) document.getElementById('transferFileSize').textContent = formatFileSize(fileSize);
  if (percent !== undefined) {
    document.getElementById('transferProgress').style.width = `${percent}%`;
    document.getElementById('transferPercent').textContent = `${Math.round(percent)}%`;
  }
  if (speed !== undefined) document.getElementById('transferSpeed').textContent = formatSpeed(speed);

  // Update transfer mode indicator
  if (mode !== undefined) {
    updateTransferModeIndicator(mode);
  }
}

/**
 * Update transfer mode indicator in transfer modal
 * @param {'p2p'|'relay'|'waiting'} mode - Transfer mode
 */
export function updateTransferModeIndicator(mode) {
  const indicator = document.getElementById('transferModeIndicator');
  if (!indicator) return;

  indicator.dataset.mode = mode;
  const modeIcon = indicator.querySelector('.transfer-mode-icon');
  const modeText = indicator.querySelector('.transfer-mode-text');

  if (mode === 'p2p') {
    modeIcon.innerHTML = connectionModeIcons.p2p;
    modeText.textContent = i18n.t('transfer.modes.p2p');
    indicator.title = i18n.t('transfer.modes.p2pTooltip');
  } else if (mode === 'waiting') {
    modeIcon.innerHTML = connectionModeIcons.waiting;
    modeText.textContent = i18n.t('transfer.modes.waiting');
    indicator.title = i18n.t('transfer.modes.waiting');
  } else {
    modeIcon.innerHTML = connectionModeIcons.relay;
    modeText.textContent = i18n.t('transfer.modes.relay');
    indicator.title = i18n.t('transfer.modes.relayTooltip');
  }
}

export function showSendingModal(fileName, fileSize, mode = 'p2p') {
  document.getElementById('modalTitle').textContent = i18n.t('transfer.sending');
  updateTransferProgress({ fileName, fileSize, percent: 0, speed: 0, mode });
  showModal('transferModal');
}

export function showReceivingModal(fileName, fileSize, mode = 'p2p') {
  document.getElementById('modalTitle').textContent = i18n.t('transfer.receiving');
  updateTransferProgress({ fileName, fileSize, percent: 0, speed: 0, mode });
  showModal('transferModal');
}

// Toast notifications
export function showToast(message, type = 'info', duration = 3000) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const icons = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><circle cx="12" cy="8" r="1" fill="currentColor"/></svg>'
  };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<div class="toast-icon">${icons[type] || icons.info}</div><span class="toast-message">${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => { toast.classList.add('hiding'); setTimeout(() => toast.remove(), 300); }, duration);
}

// Connection status
// 存储当前连接状态，用于语言切换时重新应用
let currentConnectionStatus = 'connecting';

export function updateConnectionStatus(status) {
  currentConnectionStatus = status;
  const el = document.getElementById('connectionStatus');
  if (el) {
    el.className = `connection-status ${status}`;

    // 使用 i18n 获取翻译文本
    const statusTextKey = `common.${status}`;
    el.querySelector('.status-text').textContent = i18n.t(statusTextKey);

    // 设置 hover 提示，说明是否已连接到主服务器
    el.title = i18n.t(`header.connectionStatus.${status}`);
  }
}

// 获取当前连接状态（用于语言切换时重新应用）
export function getCurrentConnectionStatus() {
  return currentConnectionStatus;
}

// Drop zone
export function showDropZone() { document.getElementById('dropZone')?.classList.add('active'); }
export function hideDropZone() { document.getElementById('dropZone')?.classList.remove('active'); }

// Check if mobile device
export function isMobile() {
  return window.innerWidth <= 640 || /mobile|android|iphone|ipad/i.test(navigator.userAgent.toLowerCase());
}

// Check if touch device
export function isTouchDevice() {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

// Scroll to element smoothly
export function scrollToElement(elementId, offset = 0) {
  const element = document.getElementById(elementId);
  if (element) {
    const y = element.getBoundingClientRect().top + window.pageYOffset - offset;
    window.scrollTo({ top: y, behavior: 'smooth' });
  }
}

// Lock body scroll (useful for modals)
export function lockBodyScroll() {
  document.body.style.overflow = 'hidden';
  document.body.style.position = 'fixed';
  document.body.style.width = '100%';
}

// Unlock body scroll
export function unlockBodyScroll() {
  document.body.style.overflow = '';
  document.body.style.position = '';
  document.body.style.width = '';
}

// Persistent Toast (can be updated/removed manually)
const persistentToasts = new Map();

export function showPersistentToast(id, message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  
  // If already exists, update it
  if (persistentToasts.has(id)) {
    updatePersistentToast(id, message, type);
    return;
  }
  
  const icons = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><circle cx="12" cy="8" r="1" fill="currentColor"/></svg>',
    loading: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin"><circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="12"/></svg>'
  };
  
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.dataset.persistentId = id;
  toast.innerHTML = `<div class="toast-icon">${icons[type] || icons.info}</div><span class="toast-message">${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  persistentToasts.set(id, toast);
}

export function updatePersistentToast(id, message, type) {
  const toast = persistentToasts.get(id);
  if (!toast) return;
  
  const icons = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><circle cx="12" cy="8" r="1" fill="currentColor"/></svg>',
    loading: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin"><circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="12"/></svg>'
  };
  
  if (type) {
    toast.className = `toast ${type}`;
    toast.querySelector('.toast-icon').innerHTML = icons[type] || icons.info;
  }
  toast.querySelector('.toast-message').textContent = message;
}

export function hidePersistentToast(id) {
  const toast = persistentToasts.get(id);
  if (!toast) return;

  toast.classList.add('hiding');
  setTimeout(() => {
    toast.remove();
    persistentToasts.delete(id);
  }, 300);
}

// ============================================
// Secure Room UI Functions
// ============================================

/**
 * Show password strength indicator
 * @param {number} strength - Strength level (0-3): 0=weak, 1=fair, 2=good, 3=strong
 */
export function showPasswordStrength(strength) {
  const container = document.getElementById('passwordStrength');
  const fill = document.getElementById('passwordStrengthFill');
  const text = document.getElementById('passwordStrengthText');

  if (!container || !fill || !text) return;

  container.style.display = 'flex';

  const strengthConfig = {
    0: { width: '25%', color: '#f87171', text: '弱' },
    1: { width: '50%', color: '#fbbf24', text: '一般' },
    2: { width: '75%', color: '#34d399', text: '良好' },
    3: { width: '100%', color: '#10b981', text: '强' }
  };

  const config = strengthConfig[strength] || strengthConfig[0];

  fill.style.width = config.width;
  fill.style.background = config.color;
  text.textContent = config.text;
  text.style.color = config.color;
}

/**
 * Hide password strength indicator
 */
export function hidePasswordStrength() {
  const container = document.getElementById('passwordStrength');
  if (container) {
    container.style.display = 'none';
  }
}

/**
 * Show join room modal with optional pre-filled room code
 * @param {string} roomCode - Optional room code to pre-fill
 * @param {boolean} passwordRequired - Whether password input should be shown
 */
export function showJoinRoomModal(roomCode = '', passwordRequired = false) {
  const roomInput = document.getElementById('roomInput');
  const passwordSection = document.getElementById('joinRoomPasswordSection');
  const passwordInput = document.getElementById('joinRoomPassword');

  // Pre-fill room code if provided
  if (roomInput && roomCode) {
    roomInput.value = roomCode;
    roomInput.readOnly = true; // Make it read-only since we know the room
  } else if (roomInput) {
    roomInput.value = '';
    roomInput.readOnly = false;
  }

  // Show/hide password section
  if (passwordSection) {
    passwordSection.style.display = passwordRequired ? 'block' : 'none';
  }

  // Clear password input
  if (passwordInput) {
    passwordInput.value = '';
  }

  showModal('joinRoomModal');

  // Focus appropriate input
  if (passwordRequired && passwordInput) {
    passwordInput.focus();
  } else if (roomInput && !roomCode) {
    roomInput.focus();
  }
}

/**
 * Show password input section in join room modal
 */
export function showJoinRoomPasswordSection() {
  const passwordSection = document.getElementById('joinRoomPasswordSection');
  const passwordInput = document.getElementById('joinRoomPassword');

  if (passwordSection) {
    passwordSection.style.display = 'block';
    // Add animation
    passwordSection.style.animation = 'fadeSlideDown 0.3s ease';
  }

  if (passwordInput) {
    passwordInput.focus();
  }
}

/**
 * Hide password input section in join room modal
 */
export function hideJoinRoomPasswordSection() {
  const passwordSection = document.getElementById('joinRoomPasswordSection');
  if (passwordSection) {
    passwordSection.style.display = 'none';
  }
}

/**
 * Update room lock icon display
 * @param {boolean} isSecure - Whether the room is password-protected
 */
export function updateRoomSecurityBadge(isSecure) {
  const lockIcon = document.getElementById('roomLockIcon');
  if (lockIcon) {
    if (isSecure) {
      lockIcon.classList.add('locked');
      lockIcon.title = '加密房间 - 已启用密码保护';
    } else {
      lockIcon.classList.remove('locked');
      lockIcon.title = '点击创建加密房间';
    }
  }
}
