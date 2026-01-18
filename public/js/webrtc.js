/**
 * CloudDrop - WebRTC Manager (Optimized v2)
 * Handles peer connections, data channels, and file transfer
 * with enhanced connection reliability and fast P2P-to-relay fallback
 *
 * Key optimizations:
 * - Happy Eyeballs style parallel connection racing
 * - Early ICE candidate type detection for smart fallback
 * - Aggressive timeouts for faster fallback
 * - Connection quality prediction
 */

import { cryptoManager } from './crypto.js';
import { WEBRTC, P2P_RETRY, RELAY } from './config.js';
import { i18n } from './i18n.js';

// Destructure config for convenience
const {
  CHUNK_SIZE,
  CONNECTION_TIMEOUT,
  FAST_FALLBACK_TIMEOUT,
  CANDIDATE_GATHERING_TIMEOUT,
  SLOW_CONNECTION_THRESHOLD,
  ICE_RESTART_DELAY,
  MAX_ICE_RESTARTS,
  DISCONNECTED_TIMEOUT,
  ICE_SERVERS_CACHE_TTL,
  FALLBACK_ICE_SERVERS,
} = WEBRTC;

const {
  INITIAL_DELAY: P2P_RETRY_INITIAL_DELAY,
  INTERVAL: P2P_RETRY_INTERVAL,
  MAX_ATTEMPTS: P2P_RETRY_MAX_ATTEMPTS,
} = P2P_RETRY;

// =============================================================================
// Safe Base64 encoding/decoding for large binary data (mobile compatible)
// =============================================================================

/**
 * Safely encode ArrayBuffer to base64 string (chunk-based for mobile compatibility)
 * @param {ArrayBuffer} buffer - Binary data to encode
 * @returns {string} Base64 encoded string
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK_SIZE = 8192; // Process in 8KB chunks to avoid call stack issues
  let result = '';

  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
    result += String.fromCharCode.apply(null, chunk);
  }

  return btoa(result);
}

/**
 * Safely decode base64 string to Uint8Array
 * @param {string} base64 - Base64 encoded string
 * @returns {Uint8Array} Decoded binary data
 */
function base64ToUint8Array(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// Cache for ICE servers with health check results
let cachedIceServers = null;
let cachedIceServersTimestamp = 0;
let iceServersFetchPromise = null;

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
    this.onFileRequest = null; // Called when file request needs user confirmation
    this.onFileRequestResponse = null; // Called when sender receives accept/decline
    this.onTransferStart = null; // Called when file transfer starts (with fileId)
    this.onProgress = null;
    this.onTextReceived = null;
    this.onConnectionStateChange = null;

    this.relayMode = new Map(); // peerId -> boolean

    // ICE candidate type tracking for smart fallback
    this.candidateTypes = new Map(); // peerId -> Set<'host'|'srflx'|'relay'>
    this.connectionQuality = new Map(); // peerId -> { p2pPossible: boolean, hasRelay: boolean }

    // Connection attempt tracking for racing
    this.connectionRacing = new Map(); // peerId -> { p2pPromise, resolved, winner }

    // File transfer request tracking
    this.pendingFileRequests = new Map(); // fileId -> { peerId, file, resolve, reject }
    this.FILE_REQUEST_TIMEOUT = 60000; // 60 seconds to respond

    // Active transfer tracking for cancellation support
    this.activeTransfers = new Map(); // fileId -> { peerId, direction: 'send'|'receive', cancelled: boolean }
    this.onTransferCancelled = null; // Callback when transfer is cancelled by peer

    // Pre-fetch ICE servers eagerly
    fetchIceServers();

    // Track peers for prewarming
    this.knownPeers = new Set();
    this.prewarmEnabled = true;

    // 中继降级设置
    this.relayFallbackEnabled = true;
    this.relayFallbackTimeout = FAST_FALLBACK_TIMEOUT;

    // Background P2P retry tracking
    this.p2pRetryTimers = new Map(); // peerId -> timeout id
    this.p2pRetryAttempts = new Map(); // peerId -> number
  }

  /**
   * Prewarm connection to a peer (background, non-blocking, SILENT)
   * Called when a new peer is discovered to reduce latency for first transfer
   * Uses fast fallback - if P2P doesn't work quickly, switch to relay silently
   */
  prewarmConnection(peerId) {
    if (!this.prewarmEnabled || this.knownPeers.has(peerId)) {
      return;
    }

    this.knownPeers.add(peerId);

    // Delay prewarm slightly to avoid overwhelming on initial peer list
    setTimeout(async () => {
      // Only prewarm if no active connection/attempt exists
      if (!this.connections.has(peerId) && !this.pendingConnections.has(peerId) && !this.relayMode.get(peerId)) {
        console.log(`[WebRTC] Prewarming connection to ${peerId}`);

        try {
          // Try P2P with fast timeout - but DON'T permanently mark as relay on failure
          // This allows actual file transfer to retry P2P
          const result = await this._raceP2PWithFallbackSilent(peerId);
          console.log(`[WebRTC] Prewarm result for ${peerId}: ${result}`);
        } catch (err) {
          // Prewarm failure - just log, don't mark as relay
          // Actual file transfer will make its own decision
          console.log(`[WebRTC] Prewarm failed for ${peerId}: ${err.message} (will retry on actual transfer)`);
        }
      }
    }, 300 + Math.random() * 300); // Stagger prewarm requests
  }

  /**
   * Enable/disable connection prewarming
   */
  setPrewarmEnabled(enabled) {
    this.prewarmEnabled = enabled;
  }

  /**
   * 设置是否允许中继降级
   * @param {boolean} enabled - 是否启用
   */
  setRelayFallbackEnabled(enabled) {
    this.relayFallbackEnabled = enabled;
    console.log(`[WebRTC] Relay fallback ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * 设置中继降级超时时间
   * @param {number} seconds - 超时秒数
   */
  setRelayFallbackTimeout(seconds) {
    // 更新配置中的快速降级超时
    this.relayFallbackTimeout = seconds * 1000; // 转换为毫秒
    console.log(`[WebRTC] Relay fallback timeout set to ${seconds}s`);
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

        // Initialize candidate type tracking
        if (!this.candidateTypes.has(peerId)) {
          this.candidateTypes.set(peerId, new Set());
        }

        // ICE candidate handler with type tracking
        pc.onicecandidate = (e) => {
          if (e.candidate) {
            // Track candidate types for smart fallback decisions
            const candidateType = e.candidate.type; // 'host', 'srflx', 'relay'
            this.candidateTypes.get(peerId)?.add(candidateType);
            console.log(`[WebRTC] ICE candidate (${candidateType}) for ${peerId}`);

            // Update connection quality prediction
            this._updateConnectionQuality(peerId);

            this.signaling.send({ type: 'ice-candidate', to: peerId, data: e.candidate });
          } else {
            console.log(`[WebRTC] ICE gathering completed for ${peerId}`);
            this._finalizeConnectionQuality(peerId);
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
   * Update connection quality prediction based on gathered candidates
   */
  _updateConnectionQuality(peerId) {
    const types = this.candidateTypes.get(peerId);
    if (!types) return;

    const quality = {
      hasHost: types.has('host'),
      hasSrflx: types.has('srflx'),
      hasPrflx: types.has('prflx'),  // Peer reflexive - important for symmetric NAT
      hasRelay: types.has('relay'),
      // P2P is possible with host, srflx, or prflx candidates
      p2pPossible: types.has('host') || types.has('srflx') || types.has('prflx'),
      // P2P is likely with srflx or prflx (NAT traversal path exists)
      p2pLikely: types.has('srflx') || types.has('prflx'),
    };

    this.connectionQuality.set(peerId, quality);
    console.log(`[WebRTC] Connection quality for ${peerId}:`, quality);
  }

  /**
   * Finalize connection quality after ICE gathering completes
   */
  _finalizeConnectionQuality(peerId) {
    const types = this.candidateTypes.get(peerId);
    const quality = this.connectionQuality.get(peerId);

    if (!types || types.size === 0) {
      console.warn(`[WebRTC] No ICE candidates gathered for ${peerId} - network issue`);
      this.connectionQuality.set(peerId, { p2pPossible: false, hasRelay: false, networkIssue: true });
    } else if (!quality?.p2pPossible && quality?.hasRelay) {
      console.log(`[WebRTC] Only relay candidates for ${peerId} - will use relay`);
    }
  }

  /**
   * Check if we should fast-fallback to relay based on ICE candidate analysis
   */
  _shouldFastFallback(peerId) {
    const quality = this.connectionQuality.get(peerId);

    // If we only have relay candidates after gathering, P2P won't work
    if (quality && !quality.p2pPossible && quality.hasRelay) {
      return true;
    }

    // If we have a network issue (no candidates at all), use relay
    if (quality?.networkIssue) {
      return true;
    }

    return false;
  }

  /**
   * Handle ICE connection state changes with fast fallback logic
   */
  _handleIceConnectionStateChange(peerId, pc) {
    const state = pc.iceConnectionState;

    // Clear any disconnected timer
    if (this.disconnectedTimers.has(peerId)) {
      clearTimeout(this.disconnectedTimers.get(peerId));
      this.disconnectedTimers.delete(peerId);
    }

    // Check if this is a background recovery attempt (already in relay mode)
    const isBackgroundRecovery = this.relayMode.get(peerId);

    if (state === 'disconnected') {
      // Wait before treating as failed - may recover
      console.log(`[WebRTC] ICE disconnected with ${peerId}, waiting for recovery...`);
      const timer = setTimeout(() => {
        if (pc.iceConnectionState === 'disconnected') {
          console.log(`[WebRTC] ICE still disconnected, fast-switching to relay...`);
          // Silent switch if already in background recovery mode
          this._switchToRelay(peerId, 'P2P连接失败，已切换到中继传输', isBackgroundRecovery);
        }
      }, DISCONNECTED_TIMEOUT);
      this.disconnectedTimers.set(peerId, timer);
    } else if (state === 'failed') {
      // Check if we should attempt restart or just fallback to relay
      const restartCount = this.iceRestartCounts.get(peerId) || 0;
      const quality = this.connectionQuality.get(peerId);

      // Attempt ICE restart if P2P is possible (has any non-relay candidates) and we haven't exhausted restarts
      // Use p2pPossible instead of p2pLikely to give host-only connections (LAN) a chance too
      if (quality?.p2pPossible && restartCount < MAX_ICE_RESTARTS) {
        console.log(`[WebRTC] ICE failed with ${peerId}, attempting restart ${restartCount + 1}/${MAX_ICE_RESTARTS}...`);
        this._attemptIceRestart(peerId, pc);
      } else {
        console.log(`[WebRTC] ICE failed for ${peerId} (restarts: ${restartCount}/${MAX_ICE_RESTARTS}, p2pPossible: ${quality?.p2pPossible}), switching to relay`);
        // Silent switch if already in background recovery mode
        this._switchToRelay(peerId, 'P2P连接失败，已切换到中继传输', isBackgroundRecovery);
      }
    } else if (state === 'connected' || state === 'completed') {
      // Reset restart counter on successful connection
      this.iceRestartCounts.delete(peerId);
      // Clear relay mode if we have P2P
      this.relayMode.delete(peerId);
      console.log(`[WebRTC] ICE connected with ${peerId} (P2P mode)`);
    }
  }

  /**
   * Switch to relay mode for a peer
   * @param {string} peerId - Peer ID
   * @param {string} message - Message to display (null for silent switch)
   * @param {boolean} silent - If true, don't show notification even on first switch
   */
  _switchToRelay(peerId, message, silent = false) {
    const wasAlreadyRelay = this.relayMode.get(peerId);

    if (!wasAlreadyRelay) {
      this.relayMode.set(peerId, true);
      // Always update the badge, but only show toast if not silent
      // Pass null message when silent to update badge without toast
      this._notifyConnectionState(peerId, 'relay', silent ? null : message);
      console.log(`[WebRTC] Switched to relay mode for ${peerId}`);

      // Resolve any pending connection with relay mode
      const racing = this.connectionRacing.get(peerId);
      if (racing && !racing.resolved) {
        racing.resolved = true;
        racing.winner = 'relay';
      }

      // Start background P2P retry
      this._startBackgroundP2PRetry(peerId);
    } else {
      // Already in relay mode - just log, no notification
      console.log(`[WebRTC] Already in relay mode for ${peerId}, skipping notification`);
    }
  }

  /**
   * Start background P2P retry timer
   * Periodically attempts to re-establish P2P connection while in relay mode
   */
  _startBackgroundP2PRetry(peerId) {
    // Clear any existing timer
    this._stopBackgroundP2PRetry(peerId);

    // Reset attempt counter
    this.p2pRetryAttempts.set(peerId, 0);

    // Start first retry after initial delay
    const timerId = setTimeout(() => {
      this._attemptSilentP2PReconnect(peerId);
    }, P2P_RETRY_INITIAL_DELAY);

    this.p2pRetryTimers.set(peerId, timerId);
    console.log(`[WebRTC] Started background P2P retry for ${peerId}`);
  }

  /**
   * Stop background P2P retry timer
   */
  _stopBackgroundP2PRetry(peerId) {
    const timerId = this.p2pRetryTimers.get(peerId);
    if (timerId) {
      clearTimeout(timerId);
      this.p2pRetryTimers.delete(peerId);
    }
    this.p2pRetryAttempts.delete(peerId);
  }

  /**
   * Attempt silent P2P reconnection in background
   * If successful, switch back to P2P mode
   * If failed, schedule another retry
   */
  async _attemptSilentP2PReconnect(peerId) {
    // Check if still in relay mode (peer might have left or P2P already restored)
    if (!this.relayMode.get(peerId)) {
      console.log(`[WebRTC] P2P retry cancelled for ${peerId} - no longer in relay mode`);
      this._stopBackgroundP2PRetry(peerId);
      return;
    }

    const attempts = (this.p2pRetryAttempts.get(peerId) || 0) + 1;
    this.p2pRetryAttempts.set(peerId, attempts);

    // Check if exceeded max attempts
    if (attempts > P2P_RETRY_MAX_ATTEMPTS) {
      console.log(`[WebRTC] P2P retry max attempts (${P2P_RETRY_MAX_ATTEMPTS}) reached for ${peerId}`);
      this._stopBackgroundP2PRetry(peerId);
      return;
    }

    console.log(`[WebRTC] Attempting silent P2P reconnect for ${peerId} (attempt ${attempts}/${P2P_RETRY_MAX_ATTEMPTS})`);

    try {
      // Close existing connection if any
      const existingPc = this.connections.get(peerId);
      if (existingPc) {
        existingPc.close();
        this.connections.delete(peerId);
      }

      const existingDc = this.dataChannels.get(peerId);
      if (existingDc) {
        existingDc.close();
        this.dataChannels.delete(peerId);
      }

      // Clear related state for fresh attempt
      this.pendingCandidates.delete(peerId);
      this.iceRestartCounts.delete(peerId);
      this.candidateTypes.delete(peerId);
      this.connectionQuality.delete(peerId);

      // Attempt P2P connection silently
      await this._attemptP2PConnectionSilent(peerId);

      // If we get here, P2P succeeded!
      console.log(`[WebRTC] Background P2P reconnect succeeded for ${peerId}`);

      // Switch back to P2P mode
      this.relayMode.delete(peerId);
      this._stopBackgroundP2PRetry(peerId);

      // Notify UI silently (update badge without toast)
      this._notifyConnectionState(peerId, 'connected', null);

    } catch (err) {
      console.log(`[WebRTC] Background P2P retry failed for ${peerId}: ${err.message}`);

      // Schedule next retry if still in relay mode
      if (this.relayMode.get(peerId)) {
        const timerId = setTimeout(() => {
          this._attemptSilentP2PReconnect(peerId);
        }, P2P_RETRY_INTERVAL);

        this.p2pRetryTimers.set(peerId, timerId);
        console.log(`[WebRTC] Next P2P retry scheduled in ${P2P_RETRY_INTERVAL / 1000}s`);
      }
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
      // Stop any background P2P retry since we're now connected
      this._stopBackgroundP2PRetry(peerId);
      // Notify UI that P2P connection is established (for both sender and receiver)
      this._notifyConnectionState(peerId, 'connected', null);
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
      // Check if we already have a working data channel - skip if so
      if (this.dataChannels.has(peerId)) {
        const dc = this.dataChannels.get(peerId);
        if (dc.readyState === 'open' || dc.readyState === 'connecting') {
          return; // Already have a working channel
        }
      }

      // Notify UI that we're connecting (only if we're actually creating new connection)
      this._notifyConnectionState(peerId, 'connecting', i18n.t('transfer.connection.establishing'));

      const pc = await this.createConnection(peerId);

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

    // Update badge only (no toast) for incoming offers
    // Toast is only shown when user actively initiates a transfer
    const existingChannel = this.dataChannels.get(peerId);
    const isInRelayMode = this.relayMode.get(peerId);
    if (!existingChannel || existingChannel.readyState !== 'open') {
      if (!isInRelayMode) {
        // Silent update - only badge, no toast
        this._notifyConnectionState(peerId, 'connecting', null);
      }
    }

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

  // Send file - automatically uses best available method
  // Now with request/confirmation flow
  async sendFile(peerId, file) {
    // Try to establish connection (may result in P2P or relay)
    await this.ensureConnection(peerId);

    const fileId = crypto.randomUUID();
    const isRelayMode = this.relayMode.get(peerId);

    // Notify about transfer start (for tracking/cancellation)
    if (this.onTransferStart) {
      this.onTransferStart({ peerId, fileId, fileName: file.name, fileSize: file.size, direction: 'send' });
    }

    // Step 1: Send file request and wait for confirmation
    console.log(`[WebRTC] Requesting file transfer permission from ${peerId}`);
    const accepted = await this._requestFileTransfer(peerId, file, fileId, isRelayMode);

    if (!accepted) {
      throw new Error('对方拒绝了文件接收');
    }

    // Step 2: Actually transfer the file
    if (isRelayMode) {
      console.log(`[WebRTC] Sending file to ${peerId} via relay`);
      return this._sendFileDataViaRelay(peerId, file, fileId);
    }

    // Verify we have a working P2P channel
    const dc = this.dataChannels.get(peerId);
    if (!dc || dc.readyState !== 'open') {
      console.log(`[WebRTC] No P2P channel available, using relay for ${peerId}`);
      this._switchToRelay(peerId, null, true);
      return this._sendFileDataViaRelay(peerId, file, fileId);
    }

    console.log(`[WebRTC] Sending file to ${peerId} via P2P`);
    return this._sendFileDataViaP2P(peerId, file, fileId, dc);
  }

  /**
   * Request file transfer permission from recipient
   * @returns {Promise<boolean>} - true if accepted, false if declined
   */
  async _requestFileTransfer(peerId, file, fileId, isRelayMode) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingFileRequests.delete(fileId);
        reject(new Error('文件请求超时，对方未响应'));
      }, this.FILE_REQUEST_TIMEOUT);

      this.pendingFileRequests.set(fileId, {
        peerId,
        file,
        resolve: (accepted) => {
          clearTimeout(timeoutId);
          this.pendingFileRequests.delete(fileId);
          resolve(accepted);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          this.pendingFileRequests.delete(fileId);
          reject(error);
        }
      });

      // Send file request via signaling (always goes through server)
      this.signaling.send({
        type: 'file-request',
        to: peerId,
        data: {
          fileId,
          name: file.name,
          size: file.size,
          mimeType: file.type || 'application/octet-stream', // Add MIME type
          totalChunks: Math.ceil(file.size / CHUNK_SIZE),
          transferMode: isRelayMode ? 'relay' : 'p2p'
        }
      });
    });
  }

  /**
   * Handle incoming file request (called by app.js)
   */
  handleFileRequest(peerId, data) {
    console.log(`[WebRTC] Received file request from ${peerId}:`, data);
    // This is now handled by signaling, forwarded to onFileRequest callback
    if (this.onFileRequest) {
      this.onFileRequest(peerId, data);
    }
  }

  /**
   * Respond to a file request (called by app.js when user accepts/declines)
   * @param {string} peerId - Sender's peer ID
   * @param {string} fileId - File ID
   * @param {boolean} accept - true to accept, false to decline
   */
  respondToFileRequest(peerId, fileId, accept) {
    console.log(`[WebRTC] Responding to file request ${fileId}: ${accept ? 'accept' : 'decline'}`);

    this.signaling.send({
      type: 'file-response',
      to: peerId,
      data: { fileId, accepted: accept }
    });

    if (accept) {
      // Prepare to receive file - initialize transfer state
      // The actual transfer state will be set when file-start arrives
    }
  }

  /**
   * Handle file response (accept/decline from recipient)
   */
  handleFileResponse(peerId, data) {
    console.log(`[WebRTC] Received file response from ${peerId}:`, data);
    const pending = this.pendingFileRequests.get(data.fileId);

    if (pending) {
      pending.resolve(data.accepted);
    }

    // Also notify via callback for UI updates
    if (this.onFileRequestResponse) {
      this.onFileRequestResponse(peerId, data.fileId, data.accepted);
    }
  }

  /**
   * Cancel an active transfer (either sending or receiving)
   * @param {string} fileId - File ID to cancel
   * @param {string} peerId - Peer ID involved in transfer
   * @param {string} reason - Optional reason for cancellation
   */
  cancelTransfer(fileId, peerId, reason = 'user') {
    console.log(`[WebRTC] Cancelling transfer ${fileId} with ${peerId}, reason: ${reason}`);

    // Mark as cancelled in active transfers
    const transfer = this.activeTransfers.get(fileId);
    if (transfer) {
      transfer.cancelled = true;
    }

    // Clean up incoming transfer state
    const incomingTransfer = this.incomingTransfers.get(peerId);
    if (incomingTransfer && incomingTransfer.fileId === fileId) {
      this.incomingTransfers.delete(peerId);
    }

    // Notify the other peer
    this.signaling.send({
      type: 'file-cancel',
      to: peerId,
      data: { fileId, reason }
    });

    // Also send via data channel if available (faster)
    const dc = this.dataChannels.get(peerId);
    if (dc && dc.readyState === 'open') {
      try {
        dc.send(JSON.stringify({ type: 'file-cancel', fileId, reason }));
      } catch (e) {
        console.warn('[WebRTC] Failed to send cancel via data channel:', e);
      }
    }
  }

  /**
   * Handle incoming file cancel message
   */
  handleFileCancel(peerId, data) {
    console.log(`[WebRTC] Received file cancel from ${peerId}:`, data);

    const { fileId, reason } = data;

    // Mark transfer as cancelled
    const transfer = this.activeTransfers.get(fileId);
    if (transfer) {
      transfer.cancelled = true;
    }

    // Clean up incoming transfer state
    const incomingTransfer = this.incomingTransfers.get(peerId);
    if (incomingTransfer && incomingTransfer.fileId === fileId) {
      this.incomingTransfers.delete(peerId);
    }

    // Also check pending file requests (cancel during confirmation wait)
    const pendingRequest = this.pendingFileRequests.get(fileId);
    if (pendingRequest) {
      pendingRequest.reject(new Error('对方取消了传输'));
    }

    // Notify via callback
    if (this.onTransferCancelled) {
      this.onTransferCancelled(peerId, fileId, reason);
    }
  }

  /**
   * Get current active transfer info
   */
  getActiveTransfer(peerId) {
    // Find transfer involving this peer
    for (const [fileId, transfer] of this.activeTransfers.entries()) {
      if (transfer.peerId === peerId && !transfer.cancelled) {
        return { fileId, ...transfer };
      }
    }
    // Check incoming transfers
    const incoming = this.incomingTransfers.get(peerId);
    if (incoming && !incoming.cancelled) {
      return { fileId: incoming.fileId, peerId, direction: 'receive', ...incoming };
    }
    return null;
  }

  /**
   * Send file data via P2P (after confirmation)
   */
  async _sendFileDataViaP2P(peerId, file, fileId, dc) {
    // Register active transfer
    this.activeTransfers.set(fileId, { peerId, direction: 'send', cancelled: false });

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    dc.send(JSON.stringify({
      type: 'file-start',
      fileId,
      name: file.name,
      size: file.size,
      mimeType: file.type || 'application/octet-stream', // Add MIME type
      totalChunks
    }));

    let offset = 0, chunkIndex = 0, startTime = Date.now();

    try {
      while (offset < file.size) {
        // Check if transfer was cancelled
        const transfer = this.activeTransfers.get(fileId);
        if (!transfer || transfer.cancelled) {
          console.log(`[WebRTC] Transfer ${fileId} was cancelled`);
          throw new Error('传输已取消');
        }

        const chunk = file.slice(offset, offset + CHUNK_SIZE);
        const buffer = await chunk.arrayBuffer();
        const encrypted = await cryptoManager.encryptChunk(peerId, buffer);

        while (dc.bufferedAmount > 1024 * 1024) {
          // Check cancellation during buffer wait
          const t = this.activeTransfers.get(fileId);
          if (!t || t.cancelled) {
            throw new Error('传输已取消');
          }
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
    } finally {
      this.activeTransfers.delete(fileId);
    }
  }

  // Send file via WebSocket relay (legacy - now wrapped by sendFile)
  async sendFileViaRelay(peerId, file) {
    const fileId = crypto.randomUUID();
    const accepted = await this._requestFileTransfer(peerId, file, fileId, true);

    if (!accepted) {
      throw new Error('对方拒绝了文件接收');
    }

    return this._sendFileDataViaRelay(peerId, file, fileId);
  }

  /**
   * Send file data via relay with reliability (after confirmation)
   * Features: flow control, ACK, retransmission, timeout handling
   */
  async _sendFileDataViaRelay(peerId, file, fileId) {
    // Register active transfer with enhanced state
    const transferState = {
      peerId,
      direction: 'send',
      cancelled: false,
      ackedChunks: new Set(),      // Chunks that have been acknowledged
      pendingChunks: new Map(),    // Chunks waiting for ACK: index -> {data, retries, sentAt}
      lastAckTime: Date.now(),     // Last ACK received time
    };
    this.activeTransfers.set(fileId, transferState);

    // Ensure we have encryption key before sending
    if (!cryptoManager.hasSharedSecret(peerId)) {
      console.log(`[WebRTC] No shared key for ${peerId}, exchanging keys via signaling...`);
      await this._exchangeKeysViaSignaling(peerId);
    }

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // Send file-start with total chunks for integrity check
    this.signaling.send({
      type: 'relay-data',
      to: peerId,
      data: {
        type: 'file-start',
        fileId,
        name: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
        totalChunks
      }
    });

    let offset = 0, chunkIndex = 0, startTime = Date.now();

    try {
      while (offset < file.size) {
        // Check if transfer was cancelled
        const transfer = this.activeTransfers.get(fileId);
        if (!transfer || transfer.cancelled) {
          console.log(`[WebRTC] Relay transfer ${fileId} was cancelled`);
          throw new Error('传输已取消');
        }

        // Flow control: wait if too many unacknowledged chunks
        while (transfer.pendingChunks.size >= RELAY.WINDOW_SIZE) {
          // Check for timeout
          if (Date.now() - transfer.lastAckTime > RELAY.ACK_TIMEOUT) {
            // Retransmit oldest unacked chunk
            const oldestPending = this._getOldestPendingChunk(transfer);
            if (oldestPending) {
              const { index, data, retries } = oldestPending;
              if (retries >= RELAY.MAX_CHUNK_RETRIES) {
                console.error(`[WebRTC] Chunk ${index} failed after ${retries} retries`);
                throw new Error('传输失败：数据块重传次数过多');
              }
              console.log(`[WebRTC] Retransmitting chunk ${index}, retry ${retries + 1}`);
              this._sendChunk(peerId, fileId, index, data.base64, retries + 1);
              transfer.pendingChunks.get(index).retries = retries + 1;
              transfer.pendingChunks.get(index).sentAt = Date.now();
            }
          }

          // Check cancellation during wait
          if (transfer.cancelled) {
            throw new Error('传输已取消');
          }

          await new Promise(r => setTimeout(r, 50));
        }

        // Check transfer timeout (no progress)
        if (Date.now() - transfer.lastAckTime > RELAY.TRANSFER_TIMEOUT && chunkIndex > 0) {
          throw new Error('传输超时：接收方无响应');
        }

        const chunk = file.slice(offset, offset + CHUNK_SIZE);
        const buffer = await chunk.arrayBuffer();
        const encrypted = await cryptoManager.encryptChunk(peerId, buffer);

        const base64Data = arrayBufferToBase64(encrypted);

        // Track pending chunk
        transfer.pendingChunks.set(chunkIndex, {
          base64: base64Data,
          retries: 0,
          sentAt: Date.now()
        });

        this._sendChunk(peerId, fileId, chunkIndex, base64Data, 0);

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

        await new Promise(r => setTimeout(r, RELAY.CHUNK_INTERVAL));
      }

      // Wait for all chunks to be acknowledged (with timeout)
      const ackWaitStart = Date.now();
      while (transferState.ackedChunks.size < totalChunks) {
        if (Date.now() - ackWaitStart > RELAY.ACK_TIMEOUT * 2) {
          console.warn(`[WebRTC] ACK timeout, ${totalChunks - transferState.ackedChunks.size} chunks unacked`);
          break;
        }
        if (transferState.cancelled) {
          throw new Error('传输已取消');
        }
        await new Promise(r => setTimeout(r, 100));
      }

      // Extra delay to ensure last chunk is fully processed before file-end
      await new Promise(r => setTimeout(r, 500));

      // Send file-end
      this.signaling.send({
        type: 'relay-data',
        to: peerId,
        data: { type: 'file-end', fileId, totalChunks }
      });

      console.log(`[WebRTC] Relay transfer complete: ${totalChunks} chunks sent`);
    } finally {
      this.activeTransfers.delete(fileId);
    }
  }

  /**
   * Send a single chunk via relay
   */
  _sendChunk(peerId, fileId, index, base64Data, retryCount) {
    this.signaling.send({
      type: 'relay-data',
      to: peerId,
      data: {
        type: 'chunk',
        fileId,
        index,
        data: base64Data,
        retry: retryCount > 0
      }
    });
  }

  /**
   * Get the oldest pending chunk for retransmission
   */
  _getOldestPendingChunk(transfer) {
    let oldest = null;
    let oldestTime = Infinity;
    for (const [index, info] of transfer.pendingChunks) {
      if (info.sentAt < oldestTime) {
        oldestTime = info.sentAt;
        oldest = { index, ...info };
      }
    }
    return oldest;
  }

  /**
   * Handle ACK from receiver
   */
  handleRelayAck(peerId, data) {
    const { fileId, acks } = data;
    const transfer = this.activeTransfers.get(fileId);
    if (!transfer || transfer.direction !== 'send') return;

    // Process acknowledged chunks
    for (const index of acks) {
      transfer.ackedChunks.add(index);
      transfer.pendingChunks.delete(index);
    }
    transfer.lastAckTime = Date.now();

    console.log(`[WebRTC] Received ACK for chunks: ${acks.join(',')}, pending: ${transfer.pendingChunks.size}`);
  }

  /**
   * Send chunk acknowledgment to sender
   */
  _sendChunkAck(peerId, fileId, acks) {
    this.signaling.send({
      type: 'relay-data',
      to: peerId,
      data: {
        type: 'ack',
        fileId,
        acks
      }
    });
  }

  // Handle incoming message
  async handleMessage(peerId, data) {
    if (typeof data === 'string') {
      const msg = JSON.parse(data);

      if (msg.type === 'file-start') {
        // Check if we have a pre-confirmed transfer (from file-request flow)
        const existingTransfer = this.incomingTransfers.get(peerId);

        if (existingTransfer && existingTransfer.confirmed && existingTransfer.fileId === msg.fileId) {
          // Transfer was already confirmed, update with actual start time
          existingTransfer.startTime = Date.now();
          // Register as active transfer for cancellation support
          this.activeTransfers.set(msg.fileId, { peerId, direction: 'receive', cancelled: false });
          console.log(`[WebRTC] Starting confirmed file transfer: ${msg.name}`);
        } else {
          // Legacy flow or direct P2P without confirmation
          // Initialize new transfer
          this.incomingTransfers.set(peerId, {
            fileId: msg.fileId, name: msg.name, size: msg.size,
            mimeType: msg.mimeType || 'application/octet-stream', // Save MIME type
            totalChunks: msg.totalChunks, chunks: [], received: 0, startTime: Date.now(),
            confirmed: true // Mark as confirmed since it's already starting
          });
          // Register as active transfer
          this.activeTransfers.set(msg.fileId, { peerId, direction: 'receive', cancelled: false });
          console.log(`[WebRTC] File transfer started (direct): ${msg.name}`);
        }

        // Notify for progress modal update
        if (this.onFileRequest) this.onFileRequest(peerId, msg);
      } else if (msg.type === 'file-end') {
        const transfer = this.incomingTransfers.get(peerId);
        if (transfer) {
          const blob = new Blob(transfer.chunks, { type: transfer.mimeType || 'application/octet-stream' }); // Use MIME type
          if (this.onFileReceived) this.onFileReceived(peerId, transfer.name, blob);
          this.incomingTransfers.delete(peerId);
          this.activeTransfers.delete(transfer.fileId);
        }
      } else if (msg.type === 'file-cancel') {
        // Handle cancel message from data channel
        this.handleFileCancel(peerId, msg);
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
      // Notify UI that we're in relay mode (receiver side)
      // Update badge but no toast (null message)
      this._notifyConnectionState(peerId, 'relay', null);
    }

    if (data.type === 'file-start') {
      // Check if we have a pre-confirmed transfer (from file-request flow)
      const existingTransfer = this.incomingTransfers.get(peerId);

      if (existingTransfer && existingTransfer.confirmed && existingTransfer.fileId === data.fileId) {
        // Transfer was already confirmed - RESET chunks array to avoid stale data!
        existingTransfer.startTime = Date.now();
        existingTransfer.chunks = [];  // Critical: clear any residual chunks
        existingTransfer.received = 0;
        existingTransfer.totalChunks = data.totalChunks;
        existingTransfer.receivedIndices = new Set(); // Track received chunk indices
        // Register as active transfer for cancellation support
        this.activeTransfers.set(data.fileId, { peerId, direction: 'receive', cancelled: false });
        console.log(`[WebRTC] Starting confirmed relay file transfer: ${data.name} (chunks reset)`);
      } else {
        // Clean up any stale transfer first
        if (existingTransfer) {
          console.log(`[WebRTC] Cleaning up stale transfer for peer ${peerId}`);
          this.incomingTransfers.delete(peerId);
          if (existingTransfer.fileId) {
            this.activeTransfers.delete(existingTransfer.fileId);
          }
        }

        // Initialize new transfer with fresh state
        this.incomingTransfers.set(peerId, {
          fileId: data.fileId, name: data.name, size: data.size,
          mimeType: data.mimeType || 'application/octet-stream',
          totalChunks: data.totalChunks,
          chunks: [],           // Fresh empty array
          receivedIndices: new Set(), // Track received chunk indices
          received: 0,
          startTime: Date.now(),
          confirmed: true
        });
        // Register as active transfer
        this.activeTransfers.set(data.fileId, { peerId, direction: 'receive', cancelled: false });
        console.log(`[WebRTC] Relay file transfer started (direct): ${data.name}`);
      }

      // Notify for progress modal update
      if (this.onFileRequest) this.onFileRequest(peerId, data);
    } else if (data.type === 'file-cancel') {
      // Handle cancel message
      this.handleFileCancel(peerId, data);
    } else if (data.type === 'file-end') {
      const transfer = this.incomingTransfers.get(peerId);
      if (transfer) {
        // Send any remaining ACKs immediately
        if (transfer.pendingAcks && transfer.pendingAcks.length > 0) {
          this._sendChunkAck(peerId, transfer.fileId, transfer.pendingAcks);
          transfer.pendingAcks = [];
        }

        // Verify integrity: check all chunks are present
        const expectedCount = data.totalChunks || transfer.totalChunks;
        let receivedCount = transfer.receivedIndices ? transfer.receivedIndices.size : 0;

        // If chunks are missing, wait a bit for them to arrive (they might be in-flight)
        if (receivedCount < expectedCount) {
          console.log(`[WebRTC] Waiting for missing chunks: ${receivedCount}/${expectedCount}`);
          const waitStart = Date.now();
          const maxWait = 3000; // Wait up to 3 seconds for missing chunks

          await new Promise(resolve => {
            const checkInterval = setInterval(() => {
              receivedCount = transfer.receivedIndices ? transfer.receivedIndices.size : 0;
              if (receivedCount >= expectedCount || Date.now() - waitStart > maxWait) {
                clearInterval(checkInterval);
                resolve();
              }
            }, 100);
          });

          receivedCount = transfer.receivedIndices ? transfer.receivedIndices.size : 0;
        }

        if (receivedCount !== expectedCount) {
          console.error(`[WebRTC] Transfer incomplete: expected ${expectedCount} chunks, received ${receivedCount}`);
          // Find missing chunks
          const missing = [];
          for (let i = 0; i < expectedCount; i++) {
            if (!transfer.receivedIndices || !transfer.receivedIndices.has(i)) {
              missing.push(i);
            }
          }
          console.error(`[WebRTC] Missing chunks: ${missing.join(', ')}`);
        }

        // Build blob from chunks in correct order
        const orderedChunks = [];
        for (let i = 0; i < expectedCount; i++) {
          if (transfer.chunks[i]) {
            orderedChunks.push(transfer.chunks[i]);
          }
        }

        const blob = new Blob(orderedChunks, { type: transfer.mimeType || 'application/octet-stream' });

        // Verify size
        if (blob.size !== transfer.size) {
          console.warn(`[WebRTC] Size mismatch: expected ${transfer.size}, got ${blob.size}`);
        }

        console.log(`[WebRTC] Transfer complete: ${receivedCount}/${expectedCount} chunks, size: ${blob.size}`);

        if (this.onFileReceived) this.onFileReceived(peerId, transfer.name, blob);
        this.incomingTransfers.delete(peerId);
        this.activeTransfers.delete(transfer.fileId);
      }
    } else if (data.type === 'chunk') {
      const transfer = this.incomingTransfers.get(peerId);
      if (transfer && transfer.fileId === data.fileId) {
        const chunkIndex = data.index !== undefined ? data.index : transfer.chunks.length;

        // Skip duplicate chunks (from retransmission)
        if (transfer.receivedIndices && transfer.receivedIndices.has(chunkIndex)) {
          console.log(`[WebRTC] Skipping duplicate chunk ${chunkIndex}`);
          // Still send ACK for duplicate to confirm receipt
          this._sendChunkAck(peerId, data.fileId, [chunkIndex]);
          return;
        }

        try {
          const bytes = base64ToUint8Array(data.data);

          const decrypted = await cryptoManager.decryptChunk(peerId, bytes.buffer);

          // Place chunk in correct position
          transfer.chunks[chunkIndex] = new Uint8Array(decrypted);
          transfer.received += decrypted.byteLength;

          // Mark as received
          if (!transfer.receivedIndices) transfer.receivedIndices = new Set();
          transfer.receivedIndices.add(chunkIndex);

          // Batch ACK: send ACK every N chunks
          if (!transfer.pendingAcks) transfer.pendingAcks = [];
          transfer.pendingAcks.push(chunkIndex);

          if (transfer.pendingAcks.length >= RELAY.ACK_BATCH_SIZE) {
            this._sendChunkAck(peerId, data.fileId, transfer.pendingAcks);
            transfer.pendingAcks = [];
          }

          if (this.onProgress) {
            const elapsed = (Date.now() - transfer.startTime) / 1000;
            this.onProgress({
              peerId, fileId: transfer.fileId, fileName: transfer.name, fileSize: transfer.size,
              sent: transfer.received, total: transfer.size,
              percent: (transfer.received / transfer.size) * 100,
              speed: transfer.received / elapsed
            });
          }
        } catch (err) {
          console.error(`[WebRTC] Error processing chunk ${chunkIndex}:`, err);
          // Request retransmission by not sending ACK
        }
      }
    } else if (data.type === 'ack') {
      // Handle ACK from receiver
      this.handleRelayAck(peerId, data);
    } else if (data.type === 'text') {
      if (this.onTextReceived) this.onTextReceived(peerId, data.content);
    }
  }

  // Send text - automatically uses best available method
  async sendText(peerId, text) {
    // Try to establish connection (may result in P2P or relay)
    await this.ensureConnection(peerId);

    // Check if we're in relay mode after connection attempt
    if (this.relayMode.get(peerId)) {
      console.log(`[WebRTC] Sending text to ${peerId} via relay`);
      return this._sendTextViaRelay(peerId, text);
    }

    // Verify we have a working P2P channel
    const dc = this.dataChannels.get(peerId);
    if (!dc || dc.readyState !== 'open') {
      console.log(`[WebRTC] No P2P channel available for text, using relay for ${peerId}`);
      // Silent switch - already in usable state
      this._switchToRelay(peerId, null, true);
      return this._sendTextViaRelay(peerId, text);
    }

    console.log(`[WebRTC] Sending text to ${peerId} via P2P`);
    dc.send(JSON.stringify({ type: 'text', content: text }));
  }

  async _sendTextViaRelay(peerId, text) {
    // Ensure we have encryption key before sending
    if (!cryptoManager.hasSharedSecret(peerId)) {
      console.log(`[WebRTC] No shared key for ${peerId}, exchanging keys via signaling...`);
      await this._exchangeKeysViaSignaling(peerId);
    }

    this.signaling.send({
      type: 'relay-data',
      to: peerId,
      data: { type: 'text', content: text }
    });
  }

  /**
   * Exchange encryption keys via signaling server (for relay mode)
   */
  async _exchangeKeysViaSignaling(peerId) {
    const publicKey = await cryptoManager.exportPublicKey();

    // Send our public key
    this.signaling.send({
      type: 'key-exchange',
      to: peerId,
      data: { publicKey }
    });

    // Wait for peer's public key
    await this.waitForEncryptionKey(peerId, 5000);
    console.log(`[WebRTC] Key exchange completed with ${peerId}`);
  }

  /**
   * Handle incoming key exchange request
   */
  async handleKeyExchange(peerId, data) {
    if (data.publicKey) {
      await cryptoManager.importPeerPublicKey(peerId, data.publicKey);
      console.log(`[WebRTC] Imported public key from ${peerId} via key-exchange`);

      // Send our public key back if they don't have it
      if (!this._keyExchangeSent?.has(peerId)) {
        if (!this._keyExchangeSent) this._keyExchangeSent = new Set();
        this._keyExchangeSent.add(peerId);

        const publicKey = await cryptoManager.exportPublicKey();
        this.signaling.send({
          type: 'key-exchange',
          to: peerId,
          data: { publicKey }
        });
      }
    }
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

  /**
   * Ensure connection is established - uses racing strategy for fast fallback
   * This is the main entry point for establishing connections
   */
  async ensureConnection(peerId) {
    // Already in relay mode? Skip P2P attempt
    if (this.relayMode.get(peerId)) {
      console.log(`[WebRTC] Already in relay mode for ${peerId}`);
      return;
    }

    const channel = this.dataChannels.get(peerId);
    const hasKey = cryptoManager.hasSharedSecret(peerId);

    // Already have a working P2P connection?
    if (channel && channel.readyState === 'open' && hasKey) {
      console.log(`[WebRTC] Reusing existing P2P connection to ${peerId}`);
      return;
    }

    // Already establishing connection?
    if (this.pendingConnections.has(peerId)) {
      console.log(`[WebRTC] Waiting for pending connection to ${peerId}`);
      return this.pendingConnections.get(peerId);
    }

    console.log(`[WebRTC] Starting connection with racing strategy to ${peerId}`);
    this._notifyConnectionState(peerId, 'connecting', '正在建立连接...');

    // Start racing between P2P and fast-fallback timer
    const connectionPromise = this._raceP2PWithFallback(peerId);
    this.pendingConnections.set(peerId, connectionPromise);

    try {
      const result = await connectionPromise;
      if (result === 'p2p') {
        this._notifyConnectionState(peerId, 'connected', null);
      }
      // If result is 'relay', notification was already sent
    } finally {
      this.pendingConnections.delete(peerId);
    }
  }

  /**
   * Race P2P connection establishment against a fast-fallback timer
   * Returns 'p2p' if P2P succeeds, or 'relay' if fallback triggered
   */
  async _raceP2PWithFallback(peerId) {
    // Initialize racing state
    const racingState = { resolved: false, winner: null };
    this.connectionRacing.set(peerId, racingState);

    // Create P2P connection attempt
    const p2pPromise = this._attemptP2PConnection(peerId).then(() => {
      if (!racingState.resolved) {
        racingState.resolved = true;
        racingState.winner = 'p2p';
        console.log(`[WebRTC] P2P connection won the race for ${peerId}`);
      }
      return 'p2p';
    }).catch(err => {
      console.log(`[WebRTC] P2P attempt failed for ${peerId}: ${err.message}`);
      // P2P 失败时自动切换到中继，而不是抛出错误导致整个流程失败
      if (!racingState.resolved) {
        racingState.resolved = true;
        racingState.winner = 'relay';
        this._switchToRelay(peerId, i18n.t('transfer.connection.failedSwitchRelay'));
        return 'relay';
      }
      // 如果已经 resolved（比如被 fallbackTimer 切换到中继），返回当前结果
      return racingState.winner || 'relay';
    });

    // Create fast-fallback timer
    const fallbackPromise = new Promise((resolve) => {
      // Show "slow connection" hint after threshold
      const slowTimer = setTimeout(() => {
        if (!racingState.resolved) {
          this._notifyConnectionState(peerId, 'slow', i18n.t('transfer.connection.slow'));
        }
      }, SLOW_CONNECTION_THRESHOLD);

      // Fast fallback timer
      const fallbackTimer = setTimeout(() => {
        clearTimeout(slowTimer);

        if (!racingState.resolved) {
          // Check if we should give up on P2P based on ICE candidates
          const shouldFallback = this._shouldFastFallback(peerId) ||
            !this._hasP2PProgress(peerId);

          if (shouldFallback) {
            console.log(`[WebRTC] Fast-fallback triggered for ${peerId}`);
            this._switchToRelay(peerId, i18n.t('transfer.connection.switchedToRelay'));
            resolve('relay');
          } else {
            // P2P seems promising, give it more time
            console.log(`[WebRTC] P2P showing progress for ${peerId}, extending timeout`);
          }
        }
      }, FAST_FALLBACK_TIMEOUT);

      // Ultimate timeout - switch to relay if P2P not established
      const ultimateTimer = setTimeout(() => {
        clearTimeout(slowTimer);
        clearTimeout(fallbackTimer);

        if (!racingState.resolved) {
          console.log(`[WebRTC] Ultimate timeout for ${peerId}, switching to relay`);
          this._switchToRelay(peerId, i18n.t('transfer.connection.timeoutSwitchRelay'));
          resolve('relay');
        }
      }, CONNECTION_TIMEOUT);

      // Clean up timers when resolved
      p2pPromise.then(() => {
        clearTimeout(slowTimer);
        clearTimeout(fallbackTimer);
        clearTimeout(ultimateTimer);
      }).catch(() => {
        clearTimeout(slowTimer);
        clearTimeout(fallbackTimer);
        clearTimeout(ultimateTimer);
      });
    });

    // Race: P2P success vs fallback timer
    return Promise.race([
      p2pPromise,
      fallbackPromise
    ]).finally(() => {
      this.connectionRacing.delete(peerId);
    });
  }

  /**
   * Silent version of _raceP2PWithFallback for prewarming
   * No UI notifications, doesn't permanently mark as relay on timeout
   * This allows actual file transfer to retry P2P connection
   */
  async _raceP2PWithFallbackSilent(peerId) {
    const racingState = { resolved: false, winner: null };
    this.connectionRacing.set(peerId, racingState);

    // Create P2P connection attempt (silent - no notification)
    const p2pPromise = this._attemptP2PConnectionSilent(peerId).then(() => {
      if (!racingState.resolved) {
        racingState.resolved = true;
        racingState.winner = 'p2p';
        console.log(`[WebRTC] Prewarm P2P succeeded for ${peerId}`);
      }
      return 'p2p';
    }).catch(err => {
      console.log(`[WebRTC] Prewarm P2P failed for ${peerId}: ${err.message}`);
      throw err;
    });

    // Fast fallback timer (shorter for prewarm)
    const fallbackPromise = new Promise((resolve, reject) => {
      const fallbackTimer = setTimeout(() => {
        if (!racingState.resolved) {
          const shouldFallback = this._shouldFastFallback(peerId) || !this._hasP2PProgress(peerId);
          if (shouldFallback) {
            console.log(`[WebRTC] Prewarm fast-fallback triggered for ${peerId} (not marking as relay)`);
            // DON'T mark as relay - let actual transfer decide
            reject(new Error('Prewarm timeout - will retry on actual transfer'));
          }
        }
      }, FAST_FALLBACK_TIMEOUT);

      // Ultimate timeout
      const ultimateTimer = setTimeout(() => {
        clearTimeout(fallbackTimer);
        if (!racingState.resolved) {
          console.log(`[WebRTC] Prewarm ultimate timeout for ${peerId} (not marking as relay)`);
          // DON'T mark as relay - let actual transfer decide
          reject(new Error('Prewarm ultimate timeout - will retry on actual transfer'));
        }
      }, CONNECTION_TIMEOUT);

      p2pPromise.then(() => {
        clearTimeout(fallbackTimer);
        clearTimeout(ultimateTimer);
        resolve('p2p');
      }).catch(() => {
        clearTimeout(fallbackTimer);
        clearTimeout(ultimateTimer);
      });
    });

    return Promise.race([p2pPromise, fallbackPromise]).finally(() => {
      this.connectionRacing.delete(peerId);
    });
  }

  /**
   * Silent P2P connection attempt (for prewarming)
   */
  async _attemptP2PConnectionSilent(peerId) {
    this.makingOffer.set(peerId, true);

    try {
      const pc = await this.createConnection(peerId);
      const channel = pc.createDataChannel('file-transfer', { ordered: true });
      this.setupDataChannel(peerId, channel);

      const publicKey = await cryptoManager.exportPublicKey();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      this.signaling.send({
        type: 'offer',
        to: peerId,
        data: { sdp: pc.localDescription, publicKey }
      });
    } finally {
      this.makingOffer.set(peerId, false);
    }

    // Wait for channel and key
    await Promise.all([
      this.waitForChannel(peerId, CONNECTION_TIMEOUT),
      this.waitForEncryptionKey(peerId, CONNECTION_TIMEOUT)
    ]);
  }

  /**
   * Check if P2P connection is making progress (has candidates, checking state)
   */
  _hasP2PProgress(peerId) {
    const pc = this.connections.get(peerId);
    const types = this.candidateTypes.get(peerId);

    // Has gathered some non-relay candidates? (including prflx for symmetric NAT)
    const hasP2PCandidates = types && (
      types.has('host') ||
      types.has('srflx') ||
      types.has('prflx')  // Important for symmetric NAT traversal
    );

    // ICE is in a good state?
    const iceGood = pc && ['new', 'checking', 'connected', 'completed'].includes(pc.iceConnectionState);

    return hasP2PCandidates && iceGood;
  }

  /**
   * Attempt P2P connection
   */
  async _attemptP2PConnection(peerId) {
    const channel = this.dataChannels.get(peerId);

    if (!channel || channel.readyState === 'closed') {
      await this.createOffer(peerId);
    }

    // Wait for channel and key with timeout
    await Promise.all([
      this.waitForChannel(peerId, CONNECTION_TIMEOUT),
      this.waitForEncryptionKey(peerId, CONNECTION_TIMEOUT)
    ]);

    console.log(`[WebRTC] P2P connection established with ${peerId}`);
  }

  _notifyConnectionState(peerId, status, message) {
    if (this.onConnectionStateChange) {
      this.onConnectionStateChange({ peerId, status, message });
    }
  }

  // Close connection and cleanup all state
  closeConnection(peerId) {
    // Clear timers
    if (this.disconnectedTimers.has(peerId)) {
      clearTimeout(this.disconnectedTimers.get(peerId));
      this.disconnectedTimers.delete(peerId);
    }

    // Stop background P2P retry
    this._stopBackgroundP2PRetry(peerId);

    this.dataChannels.get(peerId)?.close();
    this.connections.get(peerId)?.close();
    this.dataChannels.delete(peerId);
    this.connections.delete(peerId);
    this.pendingCandidates.delete(peerId);
    this.pendingConnections.delete(peerId);
    this.iceRestartCounts.delete(peerId);
    this.makingOffer.delete(peerId);
    this.ignoreOffer.delete(peerId);

    // Clean up new tracking state
    this.candidateTypes.delete(peerId);
    this.connectionQuality.delete(peerId);
    this.connectionRacing.delete(peerId);
    this.relayMode.delete(peerId);
    this.knownPeers?.delete(peerId);

    cryptoManager.removePeer(peerId);
  }

  // Close all
  closeAll() {
    for (const peerId of this.connections.keys()) this.closeConnection(peerId);
  }
}
