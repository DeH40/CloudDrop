/**
 * CloudDrop - UI Utilities Module
 */

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

// Generate display name
export function generateDisplayName() {
  const adj = ['敏捷', '明亮', '酷炫', '迅速', '优雅', '飞速', '灵动', '沉稳'];
  const noun = ['凤凰', '麒麟', '玄武', '青龙', '朱雀', '天马', '神鹿'];
  return adj[Math.floor(Math.random() * adj.length)] + noun[Math.floor(Math.random() * noun.length)];
}

// Create peer card
export function createPeerCard(peer) {
  const card = document.createElement('div');
  card.className = 'peer-card';
  card.dataset.peerId = peer.id;
  const icon = deviceIcons[peer.deviceType] || deviceIcons.desktop;
  const labels = { desktop: '桌面设备', mobile: '手机', tablet: '平板' };
  card.innerHTML = `
    <div class="peer-avatar ${peer.deviceType}">${icon}</div>
    <span class="peer-name">${escapeHtml(peer.name)}</span>
    <span class="peer-device">${labels[peer.deviceType] || '设备'}</span>
    <span class="peer-browser">${escapeHtml(peer.browserInfo || '')}</span>
    <button class="peer-action-btn" data-peer-id="${peer.id}" data-action="message" title="发送文字消息">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
    </button>
  `;
  return card;
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
export function updateTransferProgress({ fileName, fileSize, percent, speed }) {
  if (fileName !== undefined) document.getElementById('transferFileName').textContent = fileName;
  if (fileSize !== undefined) document.getElementById('transferFileSize').textContent = formatFileSize(fileSize);
  if (percent !== undefined) {
    document.getElementById('transferProgress').style.width = `${percent}%`;
    document.getElementById('transferPercent').textContent = `${Math.round(percent)}%`;
  }
  if (speed !== undefined) document.getElementById('transferSpeed').textContent = formatSpeed(speed);
}

export function showSendingModal(fileName, fileSize) {
  document.getElementById('modalTitle').textContent = '正在发送';
  updateTransferProgress({ fileName, fileSize, percent: 0, speed: 0 });
  showModal('transferModal');
}

export function showReceivingModal(fileName, fileSize) {
  document.getElementById('modalTitle').textContent = '正在接收';
  updateTransferProgress({ fileName, fileSize, percent: 0, speed: 0 });
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
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
  };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<div class="toast-icon">${icons[type] || icons.info}</div><span class="toast-message">${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => { toast.classList.add('hiding'); setTimeout(() => toast.remove(), 300); }, duration);
}

// Connection status
export function updateConnectionStatus(status, text) {
  const el = document.getElementById('connectionStatus');
  if (el) { el.className = `connection-status ${status}`; el.querySelector('.status-text').textContent = text; }
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
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
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
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
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
