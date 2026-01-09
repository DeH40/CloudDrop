/**
 * CloudDrop - WebRTC Manager (Optimized)
 * Handles peer connections, data channels, and file transfer
 * with enhanced connection reliability and ICE restart support
 */

import { cryptoManager } from './crypto.js';

const CHUNK_SIZE = 64 * 1024; // 64KB chunks
const CONNECTION_TIMEOUT = 15000; // 15 seconds timeout for first attempt
const SLOW_CONNECTION_THRESHOLD = 5000; // Show "slow connection" hint after 5 seconds
const ICE_RESTART_DELAY = 2000; // Wait before ICE restart
const MAX_ICE_RESTARTS = 2; // Maximum ICE restart attempts
const DISCONNECTED_TIMEOUT = 5000; // Wait before treating disconnected as failed

// Minimal fallback (only used if server is unreachable)
const FALLBACK_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' }
];

// Cache for ICE servers with health check results
let cachedIceServers = null;
let cachedIceServersTimestamp = 0;
let iceServersFetchPromise = null;
const ICE_SERVERS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Check a single STUN server's health by attempting to gather ICE candidates
 * @param {string} stunUrl - STUN server URL
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<{url: string, latency: number} | null>}
 */
async function checkStunServerHealth(stunUrl, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let resolved = false;
    
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: stunUrl }] });
      
      const cleanup = () => {
        if (!resolved) {
          resolved = true;
          pc.close();
        }
      };
      
      const timeout = setTimeout(() => {
        cleanup();
        resolve(null); // Timeout = unreachable
      }, timeoutMs);
      
      // Create data channel to trigger ICE gathering
      pc.createDataChannel('stun-test');
      
      pc.onicecandidate = (e) => {
        if (e.candidate && e.candidate.type === 'srflx') {
          // Server Reflexive candidate = STUN server responded
          clearTimeout(timeout);
          const latency = Date.now() - startTime;
          cleanup();
          resolve({ url: stunUrl, latency });
        }
      };
      
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete' && !resolved) {
          // Gathering complete but no srflx = STUN failed
          clearTimeout(timeout);
          cleanup();
          resolve(null);
        }
      };
      
      // Start gathering
      pc.createOffer().then(offer => pc.setLocalDescription(offer)).catch(() => {
        clearTimeout(timeout);
        cleanup();
        resolve(null);
      });
      
    } catch (error) {
      resolve(null);
    }
  });
}

/**
 * Rank ICE servers by performing health checks on STUN servers
 * TURN servers are preserved as-is (they require authentication)
 * @param {Array} iceServers - ICE servers from server
 * @returns {Promise<Array>} - Sorted ICE servers
 */
async function rankIceServers(iceServers) {
  const stunServers = [];
  const turnServers = [];
  
  // Separate STUN and TURN servers
  for (const server of iceServers) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    const isStun = urls.some(url => url.startsWith('stun:'));
    const isTurn = urls.some(url => url.startsWith('turn:') || url.startsWith('turns:'));
    
    if (isTurn) {
      turnServers.push(server);
    } else if (isStun) {
      stunServers.push(server);
    }
  }
  
  console.log(`[WebRTC] Checking ${stunServers.length} STUN servers...`);
  
  // Check all STUN servers in parallel
  const healthChecks = stunServers.map(async (server) => {
    const url = Array.isArray(server.urls) ? server.urls[0] : server.urls;
    const result = await checkStunServerHealth(url);
    return { server, result };
  });
  
  const results = await Promise.all(healthChecks);
  
  // Filter and sort by latency
  const rankedStun = results
    .filter(r => r.result !== null)
    .sort((a, b) => a.result.latency - b.result.latency)
    .map(r => {
      console.log(`[WebRTC] STUN ${r.result.url} responded in ${r.result.latency}ms`);
      return r.server;
    });
  
  const failedCount = results.filter(r => r.result === null).length;
  if (failedCount > 0) {
    console.log(`[WebRTC] ${failedCount} STUN servers unreachable`);
  }
  
  // TURN servers come first (they're more reliable), then sorted STUN
  const ranked = [...turnServers, ...rankedStun];
  console.log(`[WebRTC] ICE servers ranked: ${ranked.length} available`);
  
  return ranked.length > 0 ? ranked : FALLBACK_ICE_SERVERS;
}

/**
 * Fetch ICE servers configuration from the server with health check
 * Results are cached for 5 minutes
 * @param {boolean} forceRefresh - Force refresh cache
 */
async function fetchIceServers(forceRefresh = false) {
  const now = Date.now();
  
  // Return cached if valid
  if (!forceRefresh && cachedIceServers && (now - cachedIceServersTimestamp) < ICE_SERVERS_CACHE_TTL) {
    return cachedIceServers;
  }
  
  // Return pending promise if already fetching
  if (iceServersFetchPromise) return iceServersFetchPromise;
  
  iceServersFetchPromise = (async () => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      
      const response = await fetch('/api/ice-servers', { signal: controller.signal });
      clearTimeout(timeoutId);
      
      if (response.ok) {
        const data = await response.json();
        console.log(`[WebRTC] Fetched ${data.iceServers.length} ICE servers from server`);
        
        // Rank servers by health check
        const rankedServers = await rankIceServers(data.iceServers);
        
        // Update cache
        cachedIceServers = rankedServers;
        cachedIceServersTimestamp = Date.now();
        
        return cachedIceServers;
      }
    } catch (error) {
      console.warn('[WebRTC] Failed to fetch ICE servers:', error.message);
    } finally {
      iceServersFetchPromise = null;
    }
    
    // Use fallback if server unreachable
    console.warn('[WebRTC] Using fallback STUN server');
    return FALLBACK_ICE_SERVERS;
  })();
  
  return iceServersFetchPromise;
}

// Debug helper - expose for console access
if (typeof window !== 'undefined') {
  window.debugStunServers = async () => {
    const servers = await fetchIceServers(true);
    console.table(servers.map(s => ({
      urls: Array.isArray(s.urls) ? s.urls.join(', ') : s.urls,
      hasCredentials: !!s.credential
    })));
    return servers;
  };
}

export class WebRTCManager {
  constructor(signaling) {
    this.signaling = signaling;
    this.connections = new Map(); // peerId -> RTCPeerConnection
    this.dataChannels = new Map(); // peerId -> RTCDataChannel
    this.pendingFiles = new Map(); // peerId -> { file, resolve, reject }
    this.incomingTransfers = new Map(); // peerId -> transfer state
    this.pendingConnections = new Map(); // peerId -> Promise
    this.pendingCandidates = new Map(); // peerId -> Array<RTCIceCandidate>
    this.iceRestartCounts = new Map(); // peerId -> number
    this.disconnectedTimers = new Map(); // peerId -> timeout id
    this.makingOffer = new Map(); // peerId -> boolean (for perfect negotiation)
    this.ignoreOffer = new Map(); // peerId -> boolean
    
    this.onFileReceived = null;
    this.onFileRequest = null;
    this.onProgress = null;
    this.onTextReceived = null;
    this.onConnectionStateChange = null;
    
    this.relayMode = new Map(); // peerId -> boolean
    
    // Pre-fetch ICE servers
    fetchIceServers();
  }

  /**
   * Determine if we are the "polite" peer (for Perfect Negotiation)
   * We use peerId comparison - the lexicographically smaller ID is polite
   */
  _isPolite(peerId) {
    // If we don't have our own ID yet, be polite by default
    if (!this._myPeerId) return true;
    return this._myPeerId < peerId;
  }

  /**
   * Set our own peer ID (called after joining room)
   */
  setMyPeerId(peerId) {
    this._myPeerId = peerId;
    console.log(`[WebRTC] My peer ID set to: ${peerId}`);
  }

  // Create connection to peer with enhanced configuration
  async createConnection(peerId) {
    // Return existing connection if available and not failed
    const existing = this.connections.get(peerId);
    if (existing && existing.connectionState !== 'failed' && existing.connectionState !== 'closed') {
      return existing;
    }
    
    // Return pending connection promise if one is already in progress
    if (this.pendingConnections.has(peerId)) {
      console.log(`[WebRTC] Connection to ${peerId} already in progress, waiting...`);
      return this.pendingConnections.get(peerId);
    }

    const connectionPromise = (async () => {
      try {
        const iceServers = await fetchIceServers();
        
        // Enhanced RTCPeerConnection configuration
        const pc = new RTCPeerConnection({
          iceServers,
          iceTransportPolicy: 'all', // Ensure we gather all candidates (host, srflx, relay)
          bundlePolicy: 'max-bundle',
          rtcpMuxPolicy: 'require'
        });
        
        this.connections.set(peerId, pc);
        this.makingOffer.set(peerId, false);
        this.ignoreOffer.set(peerId, false);

        // ICE candidate handler
        pc.onicecandidate = (e) => {
          if (e.candidate) {
            this.signaling.send({ type: 'ice-candidate', to: peerId, data: e.candidate });
          } else {
            console.log(`[WebRTC] ICE gathering completed for ${peerId}`);
          }
        };

        // ICE candidate error handler
        pc.onicecandidateerror = (e) => {
          console.warn(`[WebRTC] ICE candidate error with ${peerId}:`, e.url, e.errorCode, e.errorText);
        };

        // ICE gathering state
        pc.onicegatheringstatechange = () => {
          console.log(`[WebRTC] ICE gathering state with ${peerId}: ${pc.iceGatheringState}`);
        };

        // ICE connection state - handle disconnected/failed with restart
        pc.oniceconnectionstatechange = () => {
          console.log(`[WebRTC] ICE connection state with ${peerId}: ${pc.iceConnectionState}`);
          this._handleIceConnectionStateChange(peerId, pc);
        };

        // Connection state
        pc.onconnectionstatechange = () => {
          console.log(`[WebRTC] Connection state with ${peerId}: ${pc.connectionState}`);
          this._handleConnectionStateChange(peerId, pc);
        };

        // Negotiation needed - log only, don't auto-handle
        // We manually control signaling via createOffer
        pc.onnegotiationneeded = () => {
          console.log(`[WebRTC] Negotiation needed with ${peerId} (handled manually)`);
        };

        // Data channel received
        pc.ondatachannel = (e) => {
          console.log(`[WebRTC] Received data channel from ${peerId}`);
          this.setupDataChannel(peerId, e.channel);
        };
        
        // Flush pending ICE candidates
        this._flushPendingCandidates(peerId, pc);

        return pc;
      } catch (e) {
        console.error(`[WebRTC] Failed to create connection to ${peerId}:`, e);
        this.pendingConnections.delete(peerId);
        throw e;
      }
    })();

    this.pendingConnections.set(peerId, connectionPromise);
    connectionPromise.finally(() => {
      if (this.connections.has(peerId)) {
        this.pendingConnections.delete(peerId);
      }
    });

    return connectionPromise;
  }

  /**
   * Handle ICE connection state changes with restart logic
   */
  _handleIceConnectionStateChange(peerId, pc) {
    const state = pc.iceConnectionState;
    
    // Clear any disconnected timer
    if (this.disconnectedTimers.has(peerId)) {
      clearTimeout(this.disconnectedTimers.get(peerId));
      this.disconnectedTimers.delete(peerId);
    }
    
    if (state === 'disconnected') {
      // Wait before treating as failed - may recover
      console.log(`[WebRTC] ICE disconnected with ${peerId}, waiting for recovery...`);
      const timer = setTimeout(() => {
        if (pc.iceConnectionState === 'disconnected') {
          console.log(`[WebRTC] ICE still disconnected, attempting restart...`);
          this._attemptIceRestart(peerId, pc);
        }
      }, DISCONNECTED_TIMEOUT);
      this.disconnectedTimers.set(peerId, timer);
    } else if (state === 'failed') {
      console.log(`[WebRTC] ICE failed with ${peerId}, attempting restart...`);
      this._attemptIceRestart(peerId, pc);
    } else if (state === 'connected' || state === 'completed') {
      // Reset restart counter on successful connection
      this.iceRestartCounts.delete(peerId);
      console.log(`[WebRTC] ICE connected with ${peerId}`);
    }
  }

  /**
   * Handle connection state changes
   */
  _handleConnectionStateChange(peerId, pc) {
    const state = pc.connectionState;
    
    if (state === 'failed') {
      // Check if we should try ICE restart or give up
      const restartCount = this.iceRestartCounts.get(peerId) || 0;
      if (restartCount >= MAX_ICE_RESTARTS) {
        console.log(`[WebRTC] Connection failed after ${restartCount} restarts, closing`);
        this.closeConnection(peerId);
      }
    } else if (state === 'closed') {
      this.closeConnection(peerId);
    }
  }

  /**
   * Attempt ICE restart for failed/disconnected connections
   */
  async _attemptIceRestart(peerId, pc) {
    const restartCount = this.iceRestartCounts.get(peerId) || 0;
    
    if (restartCount >= MAX_ICE_RESTARTS) {
      console.log(`[WebRTC] Max ICE restarts (${MAX_ICE_RESTARTS}) reached for ${peerId}`);
      return;
    }
    
    this.iceRestartCounts.set(peerId, restartCount + 1);
    console.log(`[WebRTC] Attempting ICE restart ${restartCount + 1}/${MAX_ICE_RESTARTS} for ${peerId}`);
    
    try {
      // Wait a bit before restart
      await new Promise(r => setTimeout(r, ICE_RESTART_DELAY));
      
      // Create offer with ICE restart
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      
      const publicKey = await cryptoManager.exportPublicKey();
      this.signaling.send({
        type: 'offer',
        to: peerId,
        data: { sdp: offer, publicKey, iceRestart: true }
      });
      
      console.log(`[WebRTC] ICE restart offer sent to ${peerId}`);
    } catch (e) {
      console.error(`[WebRTC] ICE restart failed for ${peerId}:`, e);
    }
  }

  /**
   * Flush pending ICE candidates for a peer
   */
  async _flushPendingCandidates(peerId, pc) {
    const pending = this.pendingCandidates.get(peerId);
    if (pending && pending.length > 0) {
      console.log(`[WebRTC] Flushing ${pending.length} pending ICE candidates for ${peerId}`);
      for (const candidate of pending) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.warn(`[WebRTC] Failed to add buffered candidate: ${e.message}`);
        }
      }
      this.pendingCandidates.delete(peerId);
    }
  }

  // Setup data channel
  setupDataChannel(peerId, channel) {
    channel.binaryType = 'arraybuffer';
    this.dataChannels.set(peerId, channel);

    channel.onopen = () => {
      console.log(`[WebRTC] DataChannel opened with ${peerId}`);
      // Reset relay mode when direct channel opens
      this.relayMode.delete(peerId);
    };
    
    channel.onmessage = (e) => this.handleMessage(peerId, e.data);
    
    channel.onclose = () => {
      console.log(`[WebRTC] DataChannel closed with ${peerId}`);
      this.dataChannels.delete(peerId);
    };
    
    channel.onerror = (e) => console.error('[WebRTC] DataChannel error:', e);
  }

  // Create offer
  async createOffer(peerId) {
    // Set flag immediately to prevent race conditions during async setup
    this.makingOffer.set(peerId, true);
    
    try {
      const pc = await this.createConnection(peerId);
      
      // Check if we already have a data channel
      if (this.dataChannels.has(peerId)) {
        const dc = this.dataChannels.get(peerId);
        if (dc.readyState === 'open' || dc.readyState === 'connecting') {
          return; // Already have a working channel
        }
      }

      const channel = pc.createDataChannel('file-transfer', { ordered: true });
      this.setupDataChannel(peerId, channel);

      const publicKey = await cryptoManager.exportPublicKey();
      
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      console.log(`[WebRTC] Sending offer to ${peerId}`);
      this.signaling.send({
        type: 'offer',
        to: peerId,
        data: { sdp: offer, publicKey }
      });
    } catch (e) {
      console.error(`[WebRTC] Error creating offer for ${peerId}:`, e);
    } finally {
      // Only clear flag if we're done (stable) or failed
      // In perfect negotiation, we might want to keep it true until answer?
      // MDN says: "The makingOffer variable is true while the peer is in the process of generating an offer"
      // So resetting here is correct for generation phase.
      this.makingOffer.set(peerId, false);
    }
  }

  // Handle offer with Perfect Negotiation
  async handleOffer(peerId, data) {
    console.log(`[WebRTC] Received offer from ${peerId}`);
    
    const pc = await this.createConnection(peerId);
    const isPolite = this._isPolite(peerId);
    
    // Perfect Negotiation: check for offer collision
    const offerCollision = this.makingOffer.get(peerId) || 
                           (pc.signalingState !== 'stable' && pc.signalingState !== 'have-local-offer');
    
    this.ignoreOffer.set(peerId, !isPolite && offerCollision);
    
    if (this.ignoreOffer.get(peerId)) {
      console.log(`[WebRTC] Ignoring offer from ${peerId} due to collision (impolite peer)`);
      return;
    }
    
    try {
      // If we're in have-local-offer state, we need to rollback first (polite peer)
      if (pc.signalingState === 'have-local-offer') {
        console.log(`[WebRTC] Rolling back local offer for ${peerId}`);
        await pc.setLocalDescription({ type: 'rollback' });
      }
      
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      
      // Flush pending candidates after setting remote description
      await this._flushPendingCandidates(peerId, pc);

      if (data.publicKey) {
        await cryptoManager.importPeerPublicKey(peerId, data.publicKey);
      }

      const publicKey = await cryptoManager.exportPublicKey();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      console.log(`[WebRTC] Sending answer to ${peerId}`);
      this.signaling.send({
        type: 'answer',
        to: peerId,
        data: { sdp: answer, publicKey }
      });
    } catch (e) {
      console.error(`[WebRTC] Error handling offer from ${peerId}:`, e);
    }
  }

  // Handle answer
  async handleAnswer(peerId, data) {
    console.log(`[WebRTC] Received answer from ${peerId}`);
    const pc = this.connections.get(peerId);
    
    if (!pc) {
      console.error(`[WebRTC] No connection found for ${peerId} when receiving answer`);
      return;
    }
    
    // Check signaling state
    if (pc.signalingState !== 'have-local-offer') {
      console.warn(`[WebRTC] Received answer in wrong state: ${pc.signalingState} (ignoring)`);
      // This is expected if we rolled back an offer (polite peer) but the other peer still answered it.
      // We can safely ignore this answer as we should be using the new negotiation.
      return;
    }

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      
      // Flush pending candidates after setting remote description
      await this._flushPendingCandidates(peerId, pc);
      
      if (data.publicKey) {
        await cryptoManager.importPeerPublicKey(peerId, data.publicKey);
        console.log(`[WebRTC] Imported public key from ${peerId}`);
      }
    } catch (e) {
      console.error(`[WebRTC] Error handling answer from ${peerId}:`, e);
    }
  }

  // Handle ICE candidate with improved buffering
  async handleIceCandidate(peerId, candidate) {
    const pc = this.connections.get(peerId);
    
    // Only add if we have a connection with remote description set
    if (pc && pc.remoteDescription && pc.remoteDescription.type) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
        console.log(`[WebRTC] Added ICE candidate from ${peerId}`);
        return;
      } catch (e) {
        console.warn(`[WebRTC] Error adding ICE candidate: ${e.message}`);
        // Don't buffer on error if remote desc is set - it's a real failure
        return;
      }
    }

    // Buffer candidate only if remote description not yet set
    console.log(`[WebRTC] Buffering ICE candidate from ${peerId} (no remote desc yet)`);
    if (!this.pendingCandidates.has(peerId)) {
      this.pendingCandidates.set(peerId, []);
    }
    this.pendingCandidates.get(peerId).push(candidate);
  }

  // Send file
  async sendFile(peerId, file) {
    if (this.relayMode.get(peerId)) {
      console.log(`[WebRTC] Using relay mode to send file to ${peerId}`);
      return this.sendFileViaRelay(peerId, file);
    }

    try {
      await this.ensureConnection(peerId);
    } catch (error) {
      console.warn(`[WebRTC] Connection failed, falling back to relay mode: ${error.message}`);
      this.relayMode.set(peerId, true);
      this._notifyConnectionState(peerId, 'relay', '已切换到中继传输');
      return this.sendFileViaRelay(peerId, file);
    }

    const dc = this.dataChannels.get(peerId);
    const fileId = crypto.randomUUID();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    dc.send(JSON.stringify({
      type: 'file-start',
      fileId,
      name: file.name,
      size: file.size,
      totalChunks
    }));

    let offset = 0, chunkIndex = 0, startTime = Date.now();
    
    while (offset < file.size) {
      const chunk = file.slice(offset, offset + CHUNK_SIZE);
      const buffer = await chunk.arrayBuffer();
      const encrypted = await cryptoManager.encryptChunk(peerId, buffer);

      while (dc.bufferedAmount > 1024 * 1024) {
        await new Promise(r => setTimeout(r, 10));
      }

      dc.send(encrypted);
      offset += CHUNK_SIZE;
      chunkIndex++;

      if (this.onProgress) {
        const elapsed = (Date.now() - startTime) / 1000;
        this.onProgress({
          peerId, fileId, fileName: file.name, fileSize: file.size,
          sent: offset, total: file.size,
          percent: (offset / file.size) * 100,
          speed: offset / elapsed
        });
      }
    }

    dc.send(JSON.stringify({ type: 'file-end', fileId }));
  }

  // Send file via WebSocket relay
  async sendFileViaRelay(peerId, file) {
    const fileId = crypto.randomUUID();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    this.signaling.send({
      type: 'relay-data',
      to: peerId,
      data: {
        type: 'file-start',
        fileId,
        name: file.name,
        size: file.size,
        totalChunks
      }
    });

    let offset = 0, chunkIndex = 0, startTime = Date.now();
    
    while (offset < file.size) {
      const chunk = file.slice(offset, offset + CHUNK_SIZE);
      const buffer = await chunk.arrayBuffer();
      const encrypted = await cryptoManager.encryptChunk(peerId, buffer);
      
      const base64Data = btoa(String.fromCharCode(...new Uint8Array(encrypted)));

      this.signaling.send({
        type: 'relay-data',
        to: peerId,
        data: {
          type: 'chunk',
          fileId,
          data: base64Data
        }
      });

      offset += CHUNK_SIZE;
      chunkIndex++;

      if (this.onProgress) {
        const elapsed = (Date.now() - startTime) / 1000;
        this.onProgress({
          peerId, fileId, fileName: file.name, fileSize: file.size,
          sent: Math.min(offset, file.size), total: file.size,
          percent: Math.min((offset / file.size) * 100, 100),
          speed: offset / elapsed
        });
      }
      
      await new Promise(r => setTimeout(r, 10));
    }

    this.signaling.send({
      type: 'relay-data',
      to: peerId,
      data: { type: 'file-end', fileId }
    });
  }

  // Handle incoming message
  async handleMessage(peerId, data) {
    if (typeof data === 'string') {
      const msg = JSON.parse(data);
      
      if (msg.type === 'file-start') {
        this.incomingTransfers.set(peerId, {
          fileId: msg.fileId, name: msg.name, size: msg.size,
          totalChunks: msg.totalChunks, chunks: [], received: 0, startTime: Date.now()
        });
        if (this.onFileRequest) this.onFileRequest(peerId, msg);
      } else if (msg.type === 'file-end') {
        const transfer = this.incomingTransfers.get(peerId);
        if (transfer) {
          const blob = new Blob(transfer.chunks);
          if (this.onFileReceived) this.onFileReceived(peerId, transfer.name, blob);
          this.incomingTransfers.delete(peerId);
        }
      } else if (msg.type === 'text') {
        if (this.onTextReceived) this.onTextReceived(peerId, msg.content);
      }
    } else {
      const transfer = this.incomingTransfers.get(peerId);
      if (transfer) {
        const decrypted = await cryptoManager.decryptChunk(peerId, data);
        transfer.chunks.push(new Uint8Array(decrypted));
        transfer.received += decrypted.byteLength;

        if (this.onProgress) {
          const elapsed = (Date.now() - transfer.startTime) / 1000;
          this.onProgress({
            peerId, fileId: transfer.fileId, fileName: transfer.name, fileSize: transfer.size,
            sent: transfer.received, total: transfer.size,
            percent: (transfer.received / transfer.size) * 100,
            speed: transfer.received / elapsed
          });
        }
      }
    }
  }

  // Handle incoming relay data
  async handleRelayData(peerId, data) {
    if (!this.relayMode.get(peerId)) {
      console.log(`[WebRTC] Received relay data from ${peerId}, switching to relay mode`);
      this.relayMode.set(peerId, true);
    }

    if (data.type === 'file-start') {
      this.incomingTransfers.set(peerId, {
        fileId: data.fileId, name: data.name, size: data.size,
        totalChunks: data.totalChunks, chunks: [], received: 0, startTime: Date.now()
      });
      if (this.onFileRequest) this.onFileRequest(peerId, data);
    } else if (data.type === 'file-end') {
      const transfer = this.incomingTransfers.get(peerId);
      if (transfer) {
        const blob = new Blob(transfer.chunks);
        if (this.onFileReceived) this.onFileReceived(peerId, transfer.name, blob);
        this.incomingTransfers.delete(peerId);
      }
    } else if (data.type === 'chunk') {
      const transfer = this.incomingTransfers.get(peerId);
      if (transfer && transfer.fileId === data.fileId) {
        const binaryString = atob(data.data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        
        const decrypted = await cryptoManager.decryptChunk(peerId, bytes.buffer);
        transfer.chunks.push(new Uint8Array(decrypted));
        transfer.received += decrypted.byteLength;

        if (this.onProgress) {
          const elapsed = (Date.now() - transfer.startTime) / 1000;
          this.onProgress({
            peerId, fileId: transfer.fileId, fileName: transfer.name, fileSize: transfer.size,
            sent: transfer.received, total: transfer.size,
            percent: (transfer.received / transfer.size) * 100,
            speed: transfer.received / elapsed
          });
        }
      }
    } else if (data.type === 'text') {
      if (this.onTextReceived) this.onTextReceived(peerId, data.content);
    }
  }

  // Send text
  async sendText(peerId, text) {
    if (this.relayMode.get(peerId)) {
      console.log(`[WebRTC] Using relay mode to send text to ${peerId}`);
      return this._sendTextViaRelay(peerId, text);
    }

    try {
      await this.ensureConnection(peerId);
      this.dataChannels.get(peerId).send(JSON.stringify({ type: 'text', content: text }));
    } catch (error) {
      console.warn(`[WebRTC] Connection failed for text, falling back to relay: ${error.message}`);
      this.relayMode.set(peerId, true);
      this._notifyConnectionState(peerId, 'relay', '已切换到中继传输');
      return this._sendTextViaRelay(peerId, text);
    }
  }

  _sendTextViaRelay(peerId, text) {
    this.signaling.send({
      type: 'relay-data',
      to: peerId,
      data: { type: 'text', content: text }
    });
  }

  // Wait for channel to open with fail-fast on ICE failure
  waitForChannel(peerId, timeout = CONNECTION_TIMEOUT) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const pc = this.connections.get(peerId);
      
      const check = () => {
        const ch = this.dataChannels.get(peerId);
        if (ch && ch.readyState === 'open') {
          resolve();
          return;
        }
        
        // Fail fast if ICE failed
        if (pc) {
          if (pc.iceConnectionState === 'failed' && !this.iceRestartCounts.get(peerId)) {
             // Only reject if not restarting usually, but here we want speed
             // If failed and no channel, likely dead.
             // But we have auto-restart logic.
             // We should wait if restarting? 
             // If we've exhausted restarts, it will be closed.
             if (pc.iceConnectionState === 'failed' && (this.iceRestartCounts.get(peerId) || 0) >= MAX_ICE_RESTARTS) {
                reject(new Error('ICE connection failed'));
                return;
             }
          }
          if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
             reject(new Error('Connection failed'));
             return;
          }
        }

        if (Date.now() - start > timeout) reject(new Error('Channel timeout'));
        else setTimeout(check, 100);
      };
      check();
    });
  }

  // Wait for encryption key
  waitForEncryptionKey(peerId, timeout = CONNECTION_TIMEOUT) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (cryptoManager.hasSharedSecret(peerId)) resolve();
        else if (Date.now() - start > timeout) reject(new Error('Encryption key timeout'));
        else setTimeout(check, 100);
      };
      check();
    });
  }

  // Ensure full connection is established
  async ensureConnection(peerId) {
    const channel = this.dataChannels.get(peerId);
    const hasKey = cryptoManager.hasSharedSecret(peerId);
    
    if (channel && channel.readyState === 'open' && hasKey) {
      return;
    }
    
    if (this.pendingConnections.has(peerId)) {
      console.log(`[WebRTC] Waiting for pending connection to ${peerId}`);
      try {
        await this.pendingConnections.get(peerId);
        await Promise.all([
          this.waitForChannel(peerId),
          this.waitForEncryptionKey(peerId)
        ]);
        return;
      } catch (e) {
        throw e;
      }
    }
    
    console.log(`[WebRTC] Starting new connection to ${peerId}`);
    this._notifyConnectionState(peerId, 'connecting', '正在建立连接...');
    
    const slowTimer = setTimeout(() => {
      this._notifyConnectionState(peerId, 'slow', '网络较慢，请稍候...');
    }, SLOW_CONNECTION_THRESHOLD);
    
    const connectionPromise = this._establishConnection(peerId);
    this.pendingConnections.set(peerId, connectionPromise);
    
    try {
      await connectionPromise;
      clearTimeout(slowTimer);
      this._notifyConnectionState(peerId, 'connected', null);
    } catch (error) {
      clearTimeout(slowTimer);
      throw error;
    } finally {
      this.pendingConnections.delete(peerId);
    }
  }

  _notifyConnectionState(peerId, status, message) {
    if (this.onConnectionStateChange) {
      this.onConnectionStateChange({ peerId, status, message });
    }
  }

  async _establishConnection(peerId) {
    const channel = this.dataChannels.get(peerId);
    
    if (!channel || channel.readyState === 'closed') {
      await this.createOffer(peerId);
    }
    
    await Promise.all([
      this.waitForChannel(peerId),
      this.waitForEncryptionKey(peerId)
    ]);
    
    console.log(`[WebRTC] Connection established with ${peerId}`);
  }

  // Close connection
  closeConnection(peerId) {
    // Clear timers
    if (this.disconnectedTimers.has(peerId)) {
      clearTimeout(this.disconnectedTimers.get(peerId));
      this.disconnectedTimers.delete(peerId);
    }
    
    this.dataChannels.get(peerId)?.close();
    this.connections.get(peerId)?.close();
    this.dataChannels.delete(peerId);
    this.connections.delete(peerId);
    this.pendingCandidates.delete(peerId);
    this.pendingConnections.delete(peerId);
    this.iceRestartCounts.delete(peerId);
    this.makingOffer.delete(peerId);
    this.ignoreOffer.delete(peerId);
    cryptoManager.removePeer(peerId);
  }

  // Close all
  closeAll() {
    for (const peerId of this.connections.keys()) this.closeConnection(peerId);
  }
}
