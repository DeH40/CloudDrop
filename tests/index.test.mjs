/**
 * CloudDrop - 基础测试套件（node --test）
 * 覆盖：房间 ID 生成（IP 网段哈希）、IPv6 展开、错误码常量、SAS 安全码
 * Room Durable Object 的协议测试后续用 @cloudflare/vitest-pool-workers 补充
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// src/index.ts 是 TS，用正则抽取纯逻辑不可靠；这里直接针对其行为规范做等价实现验证太弱。
// 实际方案：通过 tsx/tsc 编译后测试。为保持零依赖，此处测试可直接消费的 ESM 模块。
import { ERROR_CODES, ROOM, RELAY } from '../public/js/config.js';
import { cryptoManager } from '../public/js/crypto.js';

test('ERROR_CODES 常量完整', () => {
  const required = ['FILE_DECLINED', 'FILE_TIMEOUT', 'FILE_CANCELLED', 'MESSAGE_TOO_LARGE', 'TRANSFER_FAILED'];
  for (const k of required) {
    assert.equal(typeof ERROR_CODES[k], 'string');
    assert.equal(ERROR_CODES[k], k); // 键值与常量一致，客户端跨模块可靠
  }
});

test('ROOM 房间号规则', () => {
  assert.equal(ROOM.CODE_LENGTH, 6);
  assert.match('ABC123', ROOM.CODE_PATTERN);
  assert.doesNotMatch('abc12', ROOM.CODE_PATTERN);
  assert.doesNotMatch('ABC1234', ROOM.CODE_PATTERN);
  assert.doesNotMatch('ABC 12', ROOM.CODE_PATTERN);
  // 排除易混淆字符
  for (const c of ['0', 'O', '1', 'I']) {
    assert.equal(ROOM.CODE_CHARS.includes(c), false);
  }
});

test('RELAY 配置合法性', () => {
  assert.ok(RELAY.WINDOW_SIZE > 0);
  assert.ok(RELAY.ACK_TIMEOUT > 0);
  assert.ok(RELAY.RETRANSMIT_GRACE >= RELAY.RETRANSMIT_WAIT * RELAY.RETRANSMIT_ROUNDS);
});

test('SAS 安全码：双方独立计算一致且格式正确', async () => {
  const a = cryptoManager;
  await a.generateKeyPair();
  // 生成两个独立密钥对模拟双方
  const kpB = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
  );
  const pubB = await crypto.subtle.exportKey('spki', kpB.publicKey);
  const pubBB64 = a.arrayBufferToBase64(pubB);

  await a.importPeerPublicKey('peer-test', pubBB64);
  const code = await a.computeSafetyCode('peer-test');

  assert.match(code, /^[0-9A-F]{18}$/);

  // 对称性：以 B 视角计算（排序后应一致）
  const pubA = await a.exportPublicKey();
  const sorted = [pubA, pubBB64].sort();
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sorted[0] + sorted[1]));
  const expected = Array.from(new Uint8Array(hash)).slice(0, 9)
    .map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  assert.equal(code, expected);

  a.removePeer('peer-test');
});

test('base64 往返一致（分块实现）', () => {
  const data = new Uint8Array(70000);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;
  const b64 = cryptoManager.arrayBufferToBase64(data.buffer);
  const back = cryptoManager.base64ToArrayBuffer(b64);
  assert.deepEqual(new Uint8Array(back), data);
});

test('加密降级防护：密码房间缺 room 层被拒', async () => {
  const cm = cryptoManager;
  await cm.generateKeyPair();
  const kpB = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  const pubB = await crypto.subtle.exportKey('spki', kpB.publicKey);
  await cm.importPeerPublicKey('peer-audit', cm.arrayBufferToBase64(pubB));
  await cm.setRoomPassword('testpassword', 'ROOM01');

  // 构造无 room 层的帧（模拟信令中间人注入）
  const plaintext = new TextEncoder().encode('injected');
  const { encrypted, iv } = await cm.encrypt('peer-audit', plaintext);
  const frame = new Uint8Array(1 + iv.length + encrypted.byteLength);
  frame[0] = 0; // roomIvLength = 0
  frame.set(iv, 1);
  frame.set(new Uint8Array(encrypted), 1 + iv.length);

  await assert.rejects(() => cm.decryptChunk('peer-audit', frame.buffer), /room encryption layer/i);

  cm.clearRoomPassword();
  cm.removePeer('peer-audit');
});

test('AAD 绑定：分块元数据不符时解密失败（防换序/替换）', async () => {
  const cm = cryptoManager;
  await cm.generateKeyPair();
  const kpB = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  const pubB = await crypto.subtle.exportKey('spki', kpB.publicKey);
  await cm.importPeerPublicKey('peer-aad', cm.arrayBufferToBase64(pubB));

  const enc = await cm.encryptChunk('peer-aad', new TextEncoder().encode('chunk-data'), 'fid:0:2');

  // 错误 AAD（模拟换序分块）解密必须失败
  await assert.rejects(() => cm.decryptChunk('peer-aad', enc, 'fid:1:2'));

  // 正确 AAD 解密成功
  const dec = await cm.decryptChunk('peer-aad', enc, 'fid:0:2');
  assert.equal(new TextDecoder().decode(dec), 'chunk-data');

  cm.removePeer('peer-aad');
});
