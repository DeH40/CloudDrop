/**
 * CloudDrop - Modal manager 回归测试
 *
 * 关键不变量：遮罩点击 / Esc 必须与 X 按钮走同一条业务路径。
 * 回归会直接导致：接收方关掉弹窗但没发拒绝（发送方卡到超时）、
 * 传输弹窗消失但传输继续、下载弹窗关掉但 Blob 未释放且下载队列不推进。
 *
 * 用最小 DOM stub 跑，保持零依赖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- 最小 DOM stub（必须在 import ui.js 之前装好）----
class El {
  constructor(id = '', tag = 'div') {
    this.id = id;
    this.tagName = tag.toUpperCase();
    this._classes = new Set();
    this.children = [];
    this.style = {};
    this.textContent = '';
    this.innerHTML = '';
    this._listeners = new Map();
    this.classList = {
      add: (c) => this._classes.add(c),
      remove: (c) => this._classes.delete(c),
      contains: (c) => this._classes.has(c),
      toggle: (c, on) => (on ? this._classes.add(c) : this._classes.delete(c))
    };
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this._listeners.get(type);
    if (l) this._listeners.set(type, l.filter((f) => f !== fn));
  }
  dispatch(type, ev = {}) {
    for (const fn of this._listeners.get(type) || []) fn(ev);
  }
  click() { this.dispatch('click', {}); }
  closest(sel) { return sel === '.modal' ? this._modal : null; }
  querySelector() { return null; }
}

function buildDom(modalIds) {
  const byId = new Map();
  const backdrops = [];

  for (const id of modalIds) {
    const modal = new El(id);
    const backdrop = new El(`${id}-backdrop`);
    backdrop._modal = modal;
    modal.backdrop = backdrop;
    backdrops.push(backdrop);
    byId.set(id, modal);
  }
  // showConfirmDialog 需要的子元素
  for (const id of ['confirmIcon', 'confirmTitle', 'confirmMessage', 'confirmOk', 'confirmCancel']) {
    byId.set(id, new El(id, 'button'));
  }

  const docListeners = new Map();
  globalThis.document = {
    body: { style: {} },
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => new El('', tag),
    querySelectorAll: (sel) => (sel === '.modal-backdrop' ? backdrops : []),
    querySelector: () => null,
    addEventListener: (type, fn) => {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    dispatch: (type, ev) => { for (const fn of docListeners.get(type) || []) fn(ev); }
  };
  return byId;
}

const MODALS = ['receiveModal', 'transferModal', 'fileDownloadModal', 'confirmDialog'];
const byId = buildDom(MODALS);
const ui = await import('../public/js/ui.js');
ui.setupModalCloseHandlers();

const isOpen = (id) => byId.get(id).classList.contains('active');
const locked = () => document.body.style.overflow === 'hidden';
const pressEsc = () => document.dispatch('keydown', { key: 'Escape', preventDefault() {} });
const reset = () => { ui.hideAllModals(); for (const id of MODALS) ui.unregisterModal(id); };

test('body 滚动锁按打开栈计数，关上层不解底层的锁', () => {
  reset();
  ui.showModal('receiveModal');
  assert.equal(locked(), true);
  ui.showModal('confirmDialog');
  ui.hideModal('confirmDialog');
  assert.equal(locked(), true, '底层弹窗还开着，不能解锁滚动');
  ui.hideModal('receiveModal');
  assert.equal(locked(), false);
});

test('未注册的弹窗：遮罩/Esc 退化为直接隐藏（与旧行为一致）', () => {
  reset();
  ui.showModal('receiveModal');
  pressEsc();
  assert.equal(isOpen('receiveModal'), false);
});

test('接收弹窗：遮罩与 Esc 都必须触发拒绝语义', () => {
  reset();
  let declines = 0;
  ui.registerModal('receiveModal', {
    onDismiss: () => { declines++; ui.hideModal('receiveModal'); }
  });

  ui.showModal('receiveModal');
  byId.get('receiveModal').backdrop.click();
  assert.equal(declines, 1, '遮罩点击必须发拒绝');
  assert.equal(isOpen('receiveModal'), false);

  ui.showModal('receiveModal');
  pressEsc();
  assert.equal(declines, 2, 'Esc 必须发拒绝');
});

test('传输中 / 等待确认中：遮罩与 Esc 不得关闭弹窗', () => {
  reset();
  let cancels = 0;
  let busy = true;
  ui.registerModal('transferModal', {
    dismissible: () => !busy,
    onDismiss: () => { cancels++; ui.hideModal('transferModal'); }
  });

  ui.showModal('transferModal');
  assert.equal(ui.dismissModal('transferModal'), false);
  byId.get('transferModal').backdrop.click();
  pressEsc();
  assert.equal(cancels, 0, '忙碌时不能触发取消');
  assert.equal(isOpen('transferModal'), true, '忙碌时弹窗必须保持打开');

  busy = false;
  pressEsc();
  assert.equal(cancels, 1);
  assert.equal(isOpen('transferModal'), false);
  assert.equal(locked(), false);
});

test('Esc 只关最上层，不会连带关掉下层', () => {
  reset();
  ui.registerModal('transferModal', { dismissible: () => false });
  ui.showModal('transferModal');
  ui.showModal('confirmDialog');
  assert.equal(ui.getTopModal(), 'confirmDialog');

  pressEsc();
  assert.equal(isOpen('confirmDialog'), false, '顶层应关闭');
  assert.equal(isOpen('transferModal'), true, '下层不可关闭的弹窗不应被连带关掉');
  assert.equal(ui.getTopModal(), 'transferModal');
});

test('下载弹窗：关闭语义只走一次，可用于释放 Blob 并推进队列', () => {
  reset();
  let cleanups = 0;
  ui.registerModal('fileDownloadModal', {
    onDismiss: () => { cleanups++; ui.hideModal('fileDownloadModal'); }
  });
  ui.showModal('fileDownloadModal');
  byId.get('fileDownloadModal').backdrop.click();
  pressEsc(); // 已关闭，栈里没有它了，不应重复触发
  assert.equal(cleanups, 1);
});

test('showConfirmDialog：Esc 必须 resolve(false) 而不是悬挂', async () => {
  reset();
  const p = ui.showConfirmDialog({ title: 'T', message: 'M' });
  pressEsc();
  const settled = await Promise.race([
    p,
    new Promise((r) => setTimeout(() => r('HUNG'), 200))
  ]);
  assert.equal(settled, false, 'Promise 必须 settle 为 false');
  assert.equal(locked(), false);
});

test('showConfirmDialog：连续调用不残留监听器与 policy', async () => {
  reset();
  const ok = byId.get('confirmOk');
  const cancel = byId.get('confirmCancel');

  const p1 = ui.showConfirmDialog({ message: 'a' });
  ok.click();
  assert.equal(await p1, true);
  assert.equal(ok._listeners.get('click').length, 0, '确认按钮监听器应被移除');
  assert.equal(cancel._listeners.get('click').length, 0, '取消按钮监听器应被移除');

  // policy 已注销 → 退化为直接隐藏，不会调用上一次的 onCancel
  ui.showModal('confirmDialog');
  pressEsc();
  assert.equal(isOpen('confirmDialog'), false);

  const p2 = ui.showConfirmDialog({ message: 'b' });
  cancel.click();
  assert.equal(await p2, false);
});

// ---- 「等待对方确认」阶段的撤回 ----
const { WebRTCManager } = await import('../public/js/webrtc.js');
const { ERROR_CODES } = await import('../public/js/config.js');

function fakeSender(entries) {
  const sent = [];
  const map = new Map();
  const ctx = { pendingFileRequests: map, signaling: { send: (m) => sent.push(m) } };
  for (const [id, peerId] of entries) {
    map.set(id, {
      peerId,
      reject: (err) => { map.delete(id); ctx.rejections.push([id, err.message]); }
    });
  }
  ctx.rejections = [];
  ctx.sent = sent;
  return ctx;
}

test('撤回待确认请求：reject 为 FILE_CANCELLED 并通知对方关掉确认框', () => {
  const ctx = fakeSender([['file-1', 'peerA']]);
  const n = WebRTCManager.prototype.cancelPendingFileRequests.call(ctx, 'peerA');

  assert.equal(n, 1);
  assert.deepEqual(ctx.rejections, [['file-1', ERROR_CODES.FILE_CANCELLED]]);
  assert.deepEqual(ctx.sent, [{
    type: 'file-cancel',
    to: 'peerA',
    data: { fileId: 'file-1', reason: 'user' }
  }], '必须发 file-cancel，否则对方确认框会一直挂着');
  assert.equal(ctx.pendingFileRequests.size, 0);
});

test('撤回待确认请求：只影响指定 peer，且批量请求用 batchId', () => {
  const ctx = fakeSender([['file-1', 'peerA'], ['batch-9', 'peerA'], ['file-2', 'peerB']]);
  const n = WebRTCManager.prototype.cancelPendingFileRequests.call(ctx, 'peerA');

  assert.equal(n, 2);
  assert.deepEqual(ctx.sent.map((m) => m.data.fileId), ['file-1', 'batch-9']);
  assert.deepEqual([...ctx.pendingFileRequests.keys()], ['file-2'], '其他 peer 的请求不应被撤回');
});

test('撤回待确认请求：无待确认时返回 0 且不发消息', () => {
  const ctx = fakeSender([]);
  assert.equal(WebRTCManager.prototype.cancelPendingFileRequests.call(ctx, 'peerA'), 0);
  assert.deepEqual(ctx.sent, []);
});
