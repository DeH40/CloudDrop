/**
 * CloudDrop - End-to-End Encryption Module
 * Implements ECDH key exchange + AES-256-GCM encryption
 */

// =============================================================================
// 设备身份 IndexedDB 存储（CryptoKey 可结构化克隆且保持不可导出）
// =============================================================================
const IDENTITY_DB_NAME = 'clouddrop-identity';
const IDENTITY_DB_VERSION = 1;
let identityDbPromise = null;

function openIdentityDb() {
  if (identityDbPromise) return identityDbPromise;
  identityDbPromise = new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(IDENTITY_DB_NAME, IDENTITY_DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('keys')) {
          req.result.createObjectStore('keys');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('identity db open failed'));
    } catch (e) {
      reject(e);
    }
  });
  return identityDbPromise;
}

async function idbGet(key) {
  const db = await openIdentityDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('keys', 'readonly');
    const req = tx.objectStore('keys').get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await openIdentityDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('keys', 'readwrite');
    tx.objectStore('keys').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export class CryptoManager {
  constructor() {
    this.keyPair = null;
    this.sharedSecrets = new Map(); // peerId -> CryptoKey
    this.roomKey = null; // Room-level encryption key (derived from password)
    this.roomPasswordSet = false; // Flag to track if room password is set
    this.identityKeyPair = null; // 持久设备身份密钥（ECDSA，防伪造信任）
    this.identityPersistent = false; // 身份密钥是否成功持久化到 IndexedDB
    this.peerPublicKeys = new Map(); // peerId -> base64 SPKI（安全码计算）
  }

  /**
   * Generate ECDH key pair for this session
   */
  async generateKeyPair() {
    this.keyPair = await crypto.subtle.generateKey(
      {
        name: 'ECDH',
        namedCurve: 'P-256'
      },
      true, // extractable
      ['deriveKey', 'deriveBits']
    );
    return this.keyPair;
  }

  /**
   * Export public key for sharing with peers
   * @returns {Promise<string>} Base64-encoded public key
   */
  async exportPublicKey() {
    if (!this.keyPair) {
      await this.generateKeyPair();
    }
    const exported = await crypto.subtle.exportKey('spki', this.keyPair.publicKey);
    return this.arrayBufferToBase64(exported);
  }

  /**
   * Import peer's public key and derive shared secret
   * @param {string} peerId - Peer identifier
   * @param {string} publicKeyBase64 - Base64-encoded public key
   */
  async importPeerPublicKey(peerId, publicKeyBase64) {
    const publicKeyBuffer = this.base64ToArrayBuffer(publicKeyBase64);

    this.peerPublicKeys.set(peerId, publicKeyBase64);
    
    const peerPublicKey = await crypto.subtle.importKey(
      'spki',
      publicKeyBuffer,
      {
        name: 'ECDH',
        namedCurve: 'P-256'
      },
      false,
      []
    );

    // Derive shared secret using ECDH
    const sharedSecret = await crypto.subtle.deriveKey(
      {
        name: 'ECDH',
        public: peerPublicKey
      },
      this.keyPair.privateKey,
      {
        name: 'AES-GCM',
        length: 256
      },
      false,
      ['encrypt', 'decrypt']
    );

    this.sharedSecrets.set(peerId, sharedSecret);
    return sharedSecret;
  }

  /**
   * 获取对端 ECDH 公钥（原始 base64，用于安全码计算）
   */
  getPeerPublicKey(peerId) {
    return this.peerPublicKeys.get(peerId) || null;
  }

  /**
   * 计算双方一致的短安全码（SAS）
   * = SHA-256(排序后的双方公钥) 前 8 位十六进制
   * 双方独立计算得到相同结果；信令被中间人篡改时两码不一致
   */
  async computeSafetyCode(peerId) {
    const peerKey = this.peerPublicKeys.get(peerId);
    if (!peerKey) return null;

    const myKey = await this.exportPublicKey();
    const [a, b] = [myKey, peerKey].sort();
    const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(a + b));
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.slice(0, 4).map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  /**
   * Encrypt data for a specific peer
   * @param {string} peerId - Target peer ID
   * @param {ArrayBuffer} data - Data to encrypt
   * @returns {Promise<{encrypted: ArrayBuffer, iv: Uint8Array}>}
   */
  async encrypt(peerId, data) {
    const sharedKey = this.sharedSecrets.get(peerId);
    if (!sharedKey) {
      throw new Error(`No shared key for peer: ${peerId}`);
    }

    // Generate random IV for each encryption
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const encrypted = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv
      },
      sharedKey,
      data
    );

    return { encrypted, iv };
  }

  /**
   * Decrypt data from a specific peer
   * @param {string} peerId - Source peer ID
   * @param {ArrayBuffer} encryptedData - Encrypted data
   * @param {Uint8Array} iv - Initialization vector
   * @returns {Promise<ArrayBuffer>}
   */
  async decrypt(peerId, encryptedData, iv) {
    const sharedKey = this.sharedSecrets.get(peerId);
    if (!sharedKey) {
      throw new Error(`No shared key for peer: ${peerId}`);
    }

    const decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv
      },
      sharedKey,
      encryptedData
    );

    return decrypted;
  }

  /**
   * Encrypt a file chunk with metadata (dual-layer encryption)
   * Layer 1: Room key encryption (if password is set)
   * Layer 2: Peer-to-peer ECDH encryption
   * @param {string} peerId - Target peer ID
   * @param {ArrayBuffer} chunk - File chunk data
   * @returns {Promise<ArrayBuffer>} Encrypted chunk with IVs prepended
   */
  async encryptChunk(peerId, chunk) {
    let data = chunk;
    let roomIv = null;

    // Layer 1: Room-level encryption (if password is set)
    if (this.hasRoomPassword()) {
      const roomEncrypted = await this.encryptWithRoomKey(data);
      data = roomEncrypted.encrypted;
      roomIv = roomEncrypted.iv;
    }

    // Layer 2: Peer-to-peer encryption
    const { encrypted, iv: peerIv } = await this.encrypt(peerId, data);

    // Format: [room_iv_length (1 byte)][room_iv (0 or 12 bytes)][peer_iv (12 bytes)][encrypted_data]
    const roomIvLength = roomIv ? roomIv.length : 0;
    const result = new Uint8Array(1 + roomIvLength + peerIv.length + encrypted.byteLength);

    result[0] = roomIvLength; // Store room IV length
    let offset = 1;

    if (roomIv) {
      result.set(roomIv, offset);
      offset += roomIv.length;
    }

    result.set(peerIv, offset);
    offset += peerIv.length;

    result.set(new Uint8Array(encrypted), offset);

    return result.buffer;
  }

  /**
   * Encrypt text message (E2EE)
   * @param {string} peerId - Target peer ID
   * @param {string} text - Text to encrypt
   * @returns {Promise<string>} Base64-encoded encrypted package
   */
  async encryptText(peerId, text) {
    const encoder = new TextEncoder();
    const buffer = encoder.encode(text);
    const encrypted = await this.encryptChunk(peerId, buffer);
    return this.arrayBufferToBase64(encrypted);
  }

  /**
   * Decrypt a file chunk with prepended IVs (dual-layer decryption)
   * Layer 1: Peer-to-peer ECDH decryption
   * Layer 2: Room key decryption (if password is set)
   * @param {string} peerId - Source peer ID
   * @param {ArrayBuffer} data - Data with IVs prepended
   * @returns {Promise<ArrayBuffer>} Decrypted chunk
   */
  async decryptChunk(peerId, data) {
    const dataArray = new Uint8Array(data);

    // Parse format: [room_iv_length][room_iv][peer_iv][encrypted_data]
    const roomIvLength = dataArray[0];
    let offset = 1;

    let roomIv = null;
    if (roomIvLength > 0) {
      roomIv = dataArray.slice(offset, offset + roomIvLength);
      offset += roomIvLength;
    }

    const peerIv = dataArray.slice(offset, offset + 12);
    offset += 12;

    const encrypted = dataArray.slice(offset);

    // Layer 1: Peer-to-peer decryption
    let decrypted = await this.decrypt(peerId, encrypted.buffer, peerIv);

    // Layer 2: Room-level decryption (if password is set)
    if (this.hasRoomPassword() && roomIv) {
      decrypted = await this.decryptWithRoomKey(decrypted, roomIv);
    }

    return decrypted;
  }

  /**
   * Decrypt text message (E2EE)
   * @param {string} peerId - Source peer ID
   * @param {string} base64Data - Base64-encoded encrypted package
   * @returns {Promise<string>} Decrypted text
   */
  async decryptText(peerId, base64Data) {
    const buffer = this.base64ToArrayBuffer(base64Data);
    const decryptedBuffer = await this.decryptChunk(peerId, buffer);
    const decoder = new TextDecoder();
    return decoder.decode(decryptedBuffer);
  }

  /**
   * Remove peer's shared secret (cleanup)
   * @param {string} peerId - Peer identifier
   */
  removePeer(peerId) {
    this.sharedSecrets.delete(peerId);
    this.peerPublicKeys.delete(peerId);
  }

  /**
   * Check if we have a shared secret with a peer
   * @param {string} peerId - Peer identifier
   * @returns {boolean}
   */
  hasSharedSecret(peerId) {
    return this.sharedSecrets.has(peerId);
  }

  // ============================================
  // 持久设备身份（防伪造信任）
  // ============================================

  /**
   * 获取或创建设备身份密钥对（ECDSA P-256，不可导出，持久化在 IndexedDB）
   */
  async getOrCreateIdentityKeyPair() {
    if (this.identityKeyPair) return this.identityKeyPair;

    // 尝试从 IndexedDB 恢复持久身份
    try {
      const stored = await idbGet('device-identity');
      if (stored) {
        this.identityKeyPair = stored;
        this.identityPersistent = true;
        return this.identityKeyPair;
      }
    } catch (e) {
      // IndexedDB 不可用：使用会话级身份
    }

    this.identityKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false, // 不可导出
      ['sign', 'verify']
    );

    try {
      await idbPut('device-identity', this.identityKeyPair);
      this.identityPersistent = true;
    } catch (e) {
      // 持久化失败：身份随会话变化，信任回退到旧指纹
      console.warn('[Crypto] 设备身份无法持久化，信任验证回退到旧逻辑');
    }

    return this.identityKeyPair;
  }

  /**
   * 设备公钥（SPKI base64），随 join 消息广播给房间内其他设备
   */
  async getDevicePublicKey() {
    const keyPair = await this.getOrCreateIdentityKeyPair();
    const exported = await crypto.subtle.exportKey('spki', keyPair.publicKey);
    return this.arrayBufferToBase64(exported);
  }

  /**
   * 对挑战 payload 签名（证明持有设备私钥）
   */
  async signIdentityChallenge(payload) {
    const keyPair = await this.getOrCreateIdentityKeyPair();
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      keyPair.privateKey,
      new TextEncoder().encode(payload)
    );
    return this.arrayBufferToBase64(signature);
  }

  /**
   * 用对方设备公钥验证签名
   */
  async verifyIdentityChallenge(publicKeyBase64, payload, signatureBase64) {
    const publicKey = await crypto.subtle.importKey(
      'spki',
      this.base64ToArrayBuffer(publicKeyBase64),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    return crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      new TextEncoder().encode(payload),
      this.base64ToArrayBuffer(signatureBase64)
    );
  }

  /**
   * 身份密钥是否已持久化（决定信任指纹策略）
   */
  isIdentityPersistent() {
    return this.identityPersistent;
  }

  // ============================================
  // Room-Level Encryption (Password-Based)
  // ============================================

  /**
   * Derive a room encryption key from password using PBKDF2
   * @param {string} password - Room password
   * @param {string} roomCode - Room code (used as salt)
   * @returns {Promise<CryptoKey>} Derived AES-GCM key
   */
  async deriveRoomKeyFromPassword(password, roomCode) {
    // Encode password and room code (room code acts as salt)
    const encoder = new TextEncoder();
    const passwordBuffer = encoder.encode(password);
    const saltBuffer = encoder.encode(`clouddrop-room-${roomCode}`);

    // Import password as key material
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      passwordBuffer,
      'PBKDF2',
      false,
      ['deriveKey']
    );

    // Derive AES-GCM key using PBKDF2 (100,000 iterations for security)
    const roomKey = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: saltBuffer,
        iterations: 100000,
        hash: 'SHA-256'
      },
      keyMaterial,
      {
        name: 'AES-GCM',
        length: 256
      },
      false,
      ['encrypt', 'decrypt']
    );

    return roomKey;
  }

  /**
   * Set room password and derive encryption key
   * @param {string} password - Room password
   * @param {string} roomCode - Room code
   */
  async setRoomPassword(password, roomCode) {
    if (!password || !roomCode) {
      throw new Error('Password and room code are required');
    }

    this.roomKey = await this.deriveRoomKeyFromPassword(password, roomCode);
    this.roomPasswordSet = true;
    console.log('[Crypto] Room password set, encryption enabled');
  }

  /**
   * Clear room password and key
   */
  clearRoomPassword() {
    this.roomKey = null;
    this.roomPasswordSet = false;
    console.log('[Crypto] Room password cleared');
  }

  /**
   * Check if room password is set
   * @returns {boolean}
   */
  hasRoomPassword() {
    return this.roomPasswordSet && this.roomKey !== null;
  }

  /**
   * Encrypt data with room key (first encryption layer)
   * @param {ArrayBuffer} data - Data to encrypt
   * @returns {Promise<{encrypted: ArrayBuffer, iv: Uint8Array}>}
   */
  async encryptWithRoomKey(data) {
    if (!this.hasRoomPassword()) {
      // No room password, return data as-is
      return { encrypted: data, iv: null };
    }

    // Generate random IV
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const encrypted = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv
      },
      this.roomKey,
      data
    );

    return { encrypted, iv };
  }

  /**
   * Decrypt data with room key (first decryption layer)
   * @param {ArrayBuffer} encryptedData - Encrypted data
   * @param {Uint8Array} iv - Initialization vector
   * @returns {Promise<ArrayBuffer>}
   */
  async decryptWithRoomKey(encryptedData, iv) {
    if (!this.hasRoomPassword()) {
      // No room password, return data as-is
      return encryptedData;
    }

    if (!iv) {
      throw new Error('IV is required for room key decryption');
    }

    const decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv
      },
      this.roomKey,
      encryptedData
    );

    return decrypted;
  }

  /**
   * Generate password hash for server verification (SHA-256)
   * @param {string} password - Room password
   * @param {string} roomCode - Room code (used as salt)
   * @returns {Promise<string>} Hex-encoded hash
   */
  async hashPasswordForServer(password, roomCode) {
    const encoder = new TextEncoder();
    const data = encoder.encode(`${password}:${roomCode}:clouddrop`);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ============================================
  // Utility Methods
  // ============================================

  /**
   * Convert ArrayBuffer to Base64 string (chunked for large payloads)
   */
  arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const CHUNK_SIZE = 8192; // 8KB per chunk to avoid call-stack issues
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i += CHUNK_SIZE) {
      const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.byteLength));
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  /**
   * Convert Base64 string to ArrayBuffer
   */
  base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  /**
   * Generate a random file ID
   */
  generateFileId() {
    return crypto.randomUUID();
  }

  /**
   * Calculate SHA-256 hash of data (for integrity verification)
   * @param {ArrayBuffer} data
   * @returns {Promise<string>} Hex-encoded hash
   */
  async hash(data) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }
  /**
   * Calculate challenge response for replay protection
   * Response = SHA-256(passwordHash + nonce)
   * @param {string} passwordHash 
   * @param {string} nonce 
   */
  async calculateChallengeResponse(passwordHash, nonce) {
    const encoder = new TextEncoder();
    const data = encoder.encode(passwordHash + nonce);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }
}

// Singleton instance
export const cryptoManager = new CryptoManager();
