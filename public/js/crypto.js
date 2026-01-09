/**
 * CloudDrop - End-to-End Encryption Module
 * Implements ECDH key exchange + AES-256-GCM encryption
 */

export class CryptoManager {
  constructor() {
    this.keyPair = null;
    this.sharedSecrets = new Map(); // peerId -> CryptoKey
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
   * Encrypt a file chunk with metadata
   * @param {string} peerId - Target peer ID
   * @param {ArrayBuffer} chunk - File chunk data
   * @returns {Promise<ArrayBuffer>} Encrypted chunk with IV prepended
   */
  async encryptChunk(peerId, chunk) {
    const { encrypted, iv } = await this.encrypt(peerId, chunk);
    
    // Prepend IV to encrypted data for transmission
    const result = new Uint8Array(iv.length + encrypted.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(encrypted), iv.length);
    
    return result.buffer;
  }

  /**
   * Decrypt a file chunk with prepended IV
   * @param {string} peerId - Source peer ID
   * @param {ArrayBuffer} data - Data with IV prepended
   * @returns {Promise<ArrayBuffer>} Decrypted chunk
   */
  async decryptChunk(peerId, data) {
    const dataArray = new Uint8Array(data);
    const iv = dataArray.slice(0, 12);
    const encrypted = dataArray.slice(12);
    
    return this.decrypt(peerId, encrypted.buffer, iv);
  }

  /**
   * Remove peer's shared secret (cleanup)
   * @param {string} peerId - Peer identifier
   */
  removePeer(peerId) {
    this.sharedSecrets.delete(peerId);
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
  // Utility Methods
  // ============================================

  /**
   * Convert ArrayBuffer to Base64 string
   */
  arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
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
}

// Singleton instance
export const cryptoManager = new CryptoManager();
