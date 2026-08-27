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
import { chunkStore } from './chunkStore.js';
import { debugLog } from './logger.js';
import { WEBRTC, P2P_RETRY, RELAY, ERROR_CODES } from './config.js';
import { i18n } from './i18n.js';

// Destructure config for convenience
const {
  CHUNK_SIZE,
  CONNECTION_TIMEOUT,
  FAST_FALLBACK_TIMEOUT,
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

// Keep text/image messages well under the 256KB server relay limit
// (encrypted payload is base64-encoded again before hitting the wire)
const MAX_TEXT_PAYLOAD = 200 * 1024;

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

  debugLog(`[WebRTC] Checking ${stunServers.length} STUN servers...`);

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
      debugLog(`[WebRTC] STUN ${r.result.url} responded in ${r.result.latency}ms`);
      return r.server;
    });

  const failedCount = results.filter(r => r.result === null).length;
  if (failedCount > 0) {
    debugLog(`[WebRTC] ${failedCount} STUN servers unreachable`);
  }

  // TURN servers come first (they're more reliable), then sorted STUN
  const ranked = [...turnServers, ...rankedStun];
  debugLog(`[WebRTC] ICE servers ranked: ${ranked.length} available`);

  return ranked.length > 0 ? ranked : FALLBACK_ICE_SERVERS;
}

/**
 * Fetch ICE servers configuration from the server with health check
 * Results are cached in memory for 5 minutes and in sessionStorage for
 * 30 minutes (avoids the cold-start cost of probing 5 STUN servers with
 * parallel RTCPeerConnections on every page load).
 * @param {boolean} forceRefresh - Force refresh cache
 */
async function fetchIceServers(forceRefresh = false) {
  const now = Date.now();

  // Return cached if valid
  if (!forceRefresh && cachedIceServers && (now - cachedIceServersTimestamp) < ICE_SERVERS_CACHE_TTL) {
    return cachedIceServers;
  }

  // Try sessionStorage cache (survives reloads within the same session)
  if (!forceRefresh) {
    try {
      const stored = sessionStorage.getItem('clouddrop_ice_servers');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && Array.isArray(parsed.servers) && (now - parsed.timestamp) < ICE_SERVERS_CACHE_TTL * 6) {
          cachedIceServers = parsed.servers;
          cachedIceServersTimestamp = parsed.timestamp;
          debugLog(`[WebRTC] Reusing ICE servers from sessionStorage (${parsed.servers.length} servers)`);
          return cachedIceServers;
        }
      }
    } catch (e) {
      // Corrupt sessionStorage entry - ignore and refetch
    }
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
        debugLog(`[WebRTC] Fetched ${data.iceServers.length} ICE servers from server`);

        // Rank servers by health check
        const rankedServers = await rankIceServers(data.iceServers);

        // Update cache
        cachedIceServers = rankedServers;
        cachedIceServersTimestamp = Date.now();

        // Persist to sessionStorage so the next page load skips the probing
        try {
          sessionStorage.setItem('clouddrop_ice_servers', JSON.stringify({
            servers: rankedServers,
            timestamp: cachedIceServersTimestamp
          }));
        } catch (e) {
          // Storage full/unavailable - non-fatal
        }

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

    // Event-driven waiters (替代 100ms 轮询)
    this.channelWaiters = new Map(); // peerId -> { promise, resolve, reject, timer }
    this.keyWaiters = new Map(); // peerId -> { promise, resolve, reject, timer }
    this.fileEndAckWaiters = new Map(); // fileId -> { resolve, timer }（接收方组装完成确认）

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
    this.onTransferFailed = null; // Callback when a transfer fails (e.g. incomplete data)
    this.onPeerKeyReady = null; // Callback when peer ECDH key becomes available (SAS 安全码)

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
        debugLog(`[WebRTC] Prewarming connection to ${peerId}`);

        try {
          // Try P2P with fast timeout - if it fails, switch to relay SILENTLY
          // so the first message/file can go out instantly instead of re-racing
          const result = await this._raceP2PWithFallbackSilent(peerId);
          debugLog(`[WebRTC] Prewarm result for ${peerId}: ${result}`);
        } catch (err) {
          // Prewarm failure (e.g. relay fallback disabled) - just log
          // Actual file transfer will make its own decision
          debugLog(`[WebRTC] Prewarm failed for ${peerId}: ${err.message} (will retry on actual transfer)`);
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
    debugLog(`[WebRTC] Relay fallback ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * 设置中继降级超时时间
   * @param {number} seconds - 超时秒数
   */
  setRelayFallbackTimeout(seconds) {
    // 更新配置中的快速降级超时
    this.relayFallbackTimeout = seconds * 1000; // 转换为毫秒
    debugLog(`[WebRTC] Relay fallback timeout set to ${seconds}s`);
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
    debugLog(`[WebRTC] My peer ID set to: ${peerId}`);
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
      debugLog(`[WebRTC] Connection to ${peerId} already in progress, waiting...`);
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
            debugLog(`[WebRTC] ICE candidate (${candidateType}) for ${peerId}`);

            // Update connection quality prediction
            this._updateConnectionQuality(peerId);

            this.signaling.send({ type: 'ice-candidate', to: peerId, data: e.candidate });
          } else {
            debugLog(`[WebRTC] ICE gathering completed for ${peerId}`);
            this._finalizeConnectionQuality(peerId);
          }
        };

        // ICE candidate error handler
        pc.onicecandidateerror = (e) => {
          console.warn(`[WebRTC] ICE candidate error with ${peerId}:`, e.url, e.errorCode, e.errorText);
        };

        // ICE gathering state
        pc.onicegatheringstatechange = () => {
          debugLog(`[WebRTC] ICE gathering state with ${peerId}: ${pc.iceGatheringState}`);
        };

        // ICE connection state - handle disconnected/failed with restart
        pc.oniceconnectionstatechange = () => {
          debugLog(`[WebRTC] ICE connection state with ${peerId}: ${pc.iceConnectionState}`);
          this._handleIceConnectionStateChange(peerId, pc);
        };

        // Connection state
        pc.onconnectionstatechange = () => {
          debugLog(`[WebRTC] Connection state with ${peerId}: ${pc.connectionState}`);
          this._handleConnectionStateChange(peerId, pc);
        };

        // Negotiation needed - log only, don't auto-handle
        // We manually control signaling via createOffer
        pc.onnegotiationneeded = () => {
          debugLog(`[WebRTC] Negotiation needed with ${peerId} (handled manually)`);
        };

        // Data channel received
        pc.ondatachannel = (e) => {
          debugLog(`[WebRTC] Received data channel from ${peerId}`);
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
    debugLog(`[WebRTC] Connection quality for ${peerId}:`, quality);
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
      debugLog(`[WebRTC] Only relay candidates for ${peerId} - will use relay`);
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
    // Ignore events from connections retired by internal teardown (background retry)
    if (pc._retired) return;

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
      debugLog(`[WebRTC] ICE disconnected with ${peerId}, waiting for recovery...`);
      const timer = setTimeout(() => {
        if (pc.iceConnectionState === 'disconnected') {
          debugLog(`[WebRTC] ICE still disconnected, fast-switching to relay...`);
          // Silent switch if already in background recovery mode or during silent prewarm race
          const racing = this.connectionRacing.get(peerId);
          const isSilentRace = !!(racing && racing.silent && !racing.resolved);
          this._switchToRelay(peerId, 'P2P连接失败，已切换到中继传输', isBackgroundRecovery || isSilentRace, isSilentRace);
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
        debugLog(`[WebRTC] ICE failed with ${peerId}, attempting restart ${restartCount + 1}/${MAX_ICE_RESTARTS}...`);
        this._attemptIceRestart(peerId, pc);
      } else {
        debugLog(`[WebRTC] ICE failed for ${peerId} (restarts: ${restartCount}/${MAX_ICE_RESTARTS}, p2pPossible: ${quality?.p2pPossible}), switching to relay`);
        // Silent switch if already in background recovery mode or during silent prewarm race
        const racing = this.connectionRacing.get(peerId);
        const isSilentRace = !!(racing && racing.silent && !racing.resolved);
        this._switchToRelay(peerId, 'P2P连接失败，已切换到中继传输', isBackgroundRecovery || isSilentRace, isSilentRace);
      }
    } else if (state === 'connected' || state === 'completed') {
      // Reset restart counter on successful connection
      this.iceRestartCounts.delete(peerId);
      // NOTE: do NOT clear relay mode here - only a fully opened data channel
      // (setupDataChannel.onopen) upgrades the connection back to P2P.
      // Clearing too early can strand the peer with neither P2P nor relay.
      debugLog(`[WebRTC] ICE connected with ${peerId}`);
    }
  }

  /**
   * Switch to relay mode for a peer
   * @param {string} peerId - Peer ID
   * @param {string} message - Message to display (null for silent switch)
   * @param {boolean} silent - If true, don't show notification even on first switch
   */
  _switchToRelay(peerId, message, silent = false, skipP2PRetry = false) {
    const wasAlreadyRelay = this.relayMode.get(peerId);

    if (!wasAlreadyRelay) {
      this.relayMode.set(peerId, true);
      // Always update the badge, but only show toast if not silent
      // Pass null message when silent to update badge without toast
      this._notifyConnectionState(peerId, 'relay', silent ? null : message);
      debugLog(`[WebRTC] Switched to relay mode for ${peerId}`);

      // Resolve any pending connection with relay mode
      const racing = this.connectionRacing.get(peerId);
      if (racing && !racing.resolved) {
        racing.resolved = true;
        racing.winner = 'relay';
      }

      // Start background P2P retry (skip when an in-flight attempt already covers it)
      if (!skipP2PRetry) {
        this._startBackgroundP2PRetry(peerId);
      }

      // Pre-exchange encryption keys (no-op if already done) so the first
      // relay message doesn't wait for the ECDH handshake
      this._prewarmEncryptionKeys(peerId);
    } else {
      // Already in relay mode - just log, no notification
      debugLog(`[WebRTC] Already in relay mode for ${peerId}, skipping notification`);
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
    debugLog(`[WebRTC] Started background P2P retry for ${peerId}`);
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
      debugLog(`[WebRTC] P2P retry cancelled for ${peerId} - no longer in relay mode`);
      this._stopBackgroundP2PRetry(peerId);
      return;
    }

    const attempts = (this.p2pRetryAttempts.get(peerId) || 0) + 1;
    this.p2pRetryAttempts.set(peerId, attempts);

    // Check if exceeded max attempts
    if (attempts > P2P_RETRY_MAX_ATTEMPTS) {
      debugLog(`[WebRTC] P2P retry max attempts (${P2P_RETRY_MAX_ATTEMPTS}) reached for ${peerId}`);
      this._stopBackgroundP2PRetry(peerId);
      return;
    }

    debugLog(`[WebRTC] Attempting silent P2P reconnect for ${peerId} (attempt ${attempts}/${P2P_RETRY_MAX_ATTEMPTS})`);

    try {
      // Close existing connection if any
      const existingPc = this.connections.get(peerId);
      if (existingPc) {
        // Retire the old pc so its async state-change events are ignored
        // (close() fires 'closed' later, which must not wipe relay mode)
        existingPc._retired = true;
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
      debugLog(`[WebRTC] Background P2P reconnect succeeded for ${peerId}`);

      // Switch back to P2P mode
      this.relayMode.delete(peerId);
      this._stopBackgroundP2PRetry(peerId);

      // Notify UI silently (update badge without toast)
      this._notifyConnectionState(peerId, 'connected', null);

    } catch (err) {
      debugLog(`[WebRTC] Background P2P retry failed for ${peerId}: ${err.message}`);

      // Schedule next retry if still in relay mode
      if (this.relayMode.get(peerId)) {
        const timerId = setTimeout(() => {
          this._attemptSilentP2PReconnect(peerId);
        }, P2P_RETRY_INTERVAL);

        this.p2pRetryTimers.set(peerId, timerId);
        debugLog(`[WebRTC] Next P2P retry scheduled in ${P2P_RETRY_INTERVAL / 1000}s`);
      }
    }
  }

  /**
   * Handle connection state changes
   */
  _handleConnectionStateChange(peerId, pc) {
    // Ignore events from connections we retired internally (background retry teardown)
    if (pc._retired) return;

    const state = pc.connectionState;

    if (state === 'failed') {
      // Check if we should try ICE restart or give up
      const restartCount = this.iceRestartCounts.get(peerId) || 0;
      if (restartCount >= MAX_ICE_RESTARTS) {
        debugLog(`[WebRTC] Connection failed after ${restartCount} restarts, closing`);
        // If we're in relay mode, keep relay active - only clean up the dead P2P attempt
        this.closeConnection(peerId, this.relayMode.get(peerId));
      }
    } else if (state === 'closed') {
      // Preserve relay mode when the close came from an internal teardown
      this.closeConnection(peerId, this.relayMode.get(peerId));
    }
  }

  /**
   * Attempt ICE restart for failed/disconnected connections
   */
  async _attemptIceRestart(peerId, pc) {
    const restartCount = this.iceRestartCounts.get(peerId) || 0;

    if (restartCount >= MAX_ICE_RESTARTS) {
      debugLog(`[WebRTC] Max ICE restarts (${MAX_ICE_RESTARTS}) reached for ${peerId}`);
      return;
    }

    this.iceRestartCounts.set(peerId, restartCount + 1);
    debugLog(`[WebRTC] Attempting ICE restart ${restartCount + 1}/${MAX_ICE_RESTARTS} for ${peerId}`);

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

      debugLog(`[WebRTC] ICE restart offer sent to ${peerId}`);
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
      debugLog(`[WebRTC] Flushing ${pending.length} pending ICE candidates for ${peerId}`);
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
      debugLog(`[WebRTC] DataChannel opened with ${peerId}`);
      // Wake up any waitForChannel() waiters
      this._resolveChannelWaiters(peerId);
      // Reset relay mode when direct channel opens
      this.relayMode.delete(peerId);
      // Stop any background P2P retry since we're now connected
      this._stopBackgroundP2PRetry(peerId);
      // Notify UI that P2P connection is established (for both sender and receiver)
      this._notifyConnectionState(peerId, 'connected', null);
    };

    channel.onmessage = (e) => this.handleMessage(peerId, e.data);

    channel.onclose = () => {
      debugLog(`[WebRTC] DataChannel closed with ${peerId}`);
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

      debugLog(`[WebRTC] Sending offer to ${peerId}`);
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
    debugLog(`[WebRTC] Received offer from ${peerId}`);

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
      debugLog(`[WebRTC] Ignoring offer from ${peerId} due to collision (impolite peer)`);
      return;
    }

    try {
      // If we're in have-local-offer state, we need to rollback first (polite peer)
      if (pc.signalingState === 'have-local-offer') {
        debugLog(`[WebRTC] Rolling back local offer for ${peerId}`);
        await pc.setLocalDescription({ type: 'rollback' });
      }

      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

      // Flush pending candidates after setting remote description
      await this._flushPendingCandidates(peerId, pc);

      if (data.publicKey) {
        await cryptoManager.importPeerPublicKey(peerId, data.publicKey);
        this._resolveKeyWaiters(peerId);
        if (this.onPeerKeyReady) this.onPeerKeyReady(peerId);
      }

      const publicKey = await cryptoManager.exportPublicKey();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      debugLog(`[WebRTC] Sending answer to ${peerId}`);
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
    debugLog(`[WebRTC] Received answer from ${peerId}`);
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
        this._resolveKeyWaiters(peerId);
        if (this.onPeerKeyReady) this.onPeerKeyReady(peerId);
        debugLog(`[WebRTC] Imported public key from ${peerId}`);
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
        debugLog(`[WebRTC] Added ICE candidate from ${peerId}`);
        return;
      } catch (e) {
        console.warn(`[WebRTC] Error adding ICE candidate: ${e.message}`);
        // Don't buffer on error if remote desc is set - it's a real failure
        return;
      }
    }

    // Buffer candidate only if remote description not yet set
    debugLog(`[WebRTC] Buffering ICE candidate from ${peerId} (no remote desc yet)`);
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
    debugLog(`[WebRTC] Requesting file transfer permission from ${peerId}`);
    const accepted = await this._requestFileTransfer(peerId, file, fileId, isRelayMode);

    if (!accepted) {
      throw new Error(ERROR_CODES.FILE_DECLINED);
    }

    // Step 2: Actually transfer the file
    if (isRelayMode) {
      debugLog(`[WebRTC] Sending file to ${peerId} via relay`);
      return this._sendFileDataViaRelay(peerId, file, fileId);
    }

    // Verify we have a working P2P channel
    const dc = this.dataChannels.get(peerId);
    if (!dc || dc.readyState !== 'open') {
      debugLog(`[WebRTC] No P2P channel available, using relay for ${peerId}`);
      this._switchToRelay(peerId, null, true);
      return this._sendFileDataViaRelay(peerId, file, fileId);
    }

    debugLog(`[WebRTC] Sending file to ${peerId} via P2P`);
    return this._sendFileDataViaP2P(peerId, file, fileId, dc);
  }

  /**
   * 批量发送多个文件：只弹一次确认框，确认后逐个传输
   * @param {string} peerId - Target peer ID
   * @param {File[]} files - Files to send
   */
  async sendFiles(peerId, files) {
    // Try to establish connection (may result in P2P or relay)
    await this.ensureConnection(peerId);

    const isRelayMode = this.relayMode.get(peerId);

    const metas = files.map(file => ({
      fileId: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      totalChunks: Math.ceil(file.size / CHUNK_SIZE),
      transferMode: isRelayMode ? 'relay' : 'p2p'
    }));

    // Step 1: Send one batch request and wait for a single confirmation
    debugLog(`[WebRTC] Requesting batch transfer permission (${files.length} files) from ${peerId}`);
    const accepted = await this._requestFileTransferBatch(peerId, metas);

    if (!accepted) {
      throw new Error(ERROR_CODES.FILE_DECLINED);
    }

    // Step 2: Transfer each file sequentially
    for (let i = 0; i < files.length; i++) {
      const meta = metas[i];

      // Notify about transfer start (for tracking/cancellation)
      if (this.onTransferStart) {
        this.onTransferStart({ peerId, fileId: meta.fileId, fileName: meta.name, fileSize: meta.size, direction: 'send' });
      }

      if (isRelayMode) {
        debugLog(`[WebRTC] Sending batch file ${i + 1}/${files.length} via relay: ${meta.name}`);
        await this._sendFileDataViaRelay(peerId, files[i], meta.fileId);
      } else {
        // Verify we have a working P2P channel
        const dc = this.dataChannels.get(peerId);
        if (!dc || dc.readyState !== 'open') {
          debugLog(`[WebRTC] No P2P channel for batch, using relay for ${meta.name}`);
          this._switchToRelay(peerId, null, true);
          await this._sendFileDataViaRelay(peerId, files[i], meta.fileId);
        } else {
          debugLog(`[WebRTC] Sending batch file ${i + 1}/${files.length} via P2P: ${meta.name}`);
          await this._sendFileDataViaP2P(peerId, files[i], meta.fileId, dc);
        }
      }
    }
  }

  /**
   * 批量文件请求：一个 file-request 携带全部文件元数据，
   * 接收方单次确认，响应 fileId 使用 batchId
   * @returns {Promise<boolean>} - true if accepted, false if declined
   */
  _requestFileTransferBatch(peerId, metas) {
    return new Promise((resolve, reject) => {
      const batchId = crypto.randomUUID();

      const timeoutId = setTimeout(() => {
        this.pendingFileRequests.delete(batchId);
        reject(new Error(ERROR_CODES.FILE_TIMEOUT));
      }, this.FILE_REQUEST_TIMEOUT);

      this.pendingFileRequests.set(batchId, {
        peerId,
        file: metas[0],
        isBatch: true,
        resolve: (accepted) => {
          clearTimeout(timeoutId);
          this.pendingFileRequests.delete(batchId);
          resolve(accepted);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          this.pendingFileRequests.delete(batchId);
          reject(error);
        }
      });

      // Batch request always goes through signaling
      this.signaling.send({
        type: 'file-request',
        to: peerId,
        data: {
          batchId,
          files: metas
        }
      });
    });
  }

  /**
   * Request file transfer permission from recipient
   * @returns {Promise<boolean>} - true if accepted, false if declined
   */
  async _requestFileTransfer(peerId, file, fileId, isRelayMode) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingFileRequests.delete(fileId);
        reject(new Error(ERROR_CODES.FILE_TIMEOUT));
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
    debugLog(`[WebRTC] Received file request from ${peerId}:`, data);
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
    debugLog(`[WebRTC] Responding to file request ${fileId}: ${accept ? 'accept' : 'decline'}`);

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
    debugLog(`[WebRTC] Received file response from ${peerId}:`, data);
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
    debugLog(`[WebRTC] Cancelling transfer ${fileId} with ${peerId}, reason: ${reason}`);

    // Mark as cancelled in active transfers
    const transfer = this.activeTransfers.get(fileId);
    if (transfer) {
      transfer.cancelled = true;
    }

    // Clean up incoming transfer state
    const incomingTransfer = this.incomingTransfers.get(peerId);
    if (incomingTransfer && incomingTransfer.fileId === fileId) {
      if (incomingTransfer.useIdb) chunkStore.deleteFile(fileId).catch(() => {});
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
    debugLog(`[WebRTC] Received file cancel from ${peerId}:`, data);

    const { fileId, reason } = data;

    // Mark transfer as cancelled
    const transfer = this.activeTransfers.get(fileId);
    if (transfer) {
      transfer.cancelled = true;
    }

    // Clean up incoming transfer state
    const incomingTransfer = this.incomingTransfers.get(peerId);
    if (incomingTransfer && incomingTransfer.fileId === fileId) {
      // 清理落盘分块
      if (incomingTransfer.useIdb) {
        chunkStore.deleteFile(fileId).catch(() => {});
      }
      this.incomingTransfers.delete(peerId);
    }

    // Also check pending file requests (cancel during confirmation wait)
    const pendingRequest = this.pendingFileRequests.get(fileId);
    if (pendingRequest) {
      pendingRequest.reject(new Error(ERROR_CODES.FILE_CANCELLED));
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
          debugLog(`[WebRTC] Transfer ${fileId} was cancelled`);
          throw new Error(ERROR_CODES.FILE_CANCELLED);
        }

        const chunk = file.slice(offset, offset + CHUNK_SIZE);
        const buffer = await chunk.arrayBuffer();
        const encrypted = await cryptoManager.encryptChunk(peerId, buffer);

        while (dc.bufferedAmount > 1024 * 1024) {
          // Check cancellation during buffer wait
          const t = this.activeTransfers.get(fileId);
          if (!t || t.cancelled) {
            throw new Error(ERROR_CODES.FILE_CANCELLED);
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

      // 等待接收方确认组装完成（批量发送顺序保障；兼容旧客户端超时放行）
      const ok = await this._waitForFileEndAck(fileId);
      if (!ok) throw new Error(ERROR_CODES.TRANSFER_FAILED);
    } finally {
      this.activeTransfers.delete(fileId);
    }
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
      debugLog(`[WebRTC] No shared key for ${peerId}, exchanging keys via signaling...`);
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
          debugLog(`[WebRTC] Relay transfer ${fileId} was cancelled`);
          throw new Error(ERROR_CODES.FILE_CANCELLED);
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
                throw new Error(ERROR_CODES.TRANSFER_FAILED);
              }
              debugLog(`[WebRTC] Retransmitting chunk ${index}, retry ${retries + 1}`);
              this._sendChunk(peerId, fileId, index, data.base64, retries + 1);
              transfer.pendingChunks.get(index).retries = retries + 1;
              transfer.pendingChunks.get(index).sentAt = Date.now();
            }
          }

          // Check cancellation during wait
          if (transfer.cancelled) {
            throw new Error(ERROR_CODES.FILE_CANCELLED);
          }

          await new Promise(r => setTimeout(r, 50));
        }

        // Check transfer timeout (no progress)
        if (Date.now() - transfer.lastAckTime > RELAY.TRANSFER_TIMEOUT && chunkIndex > 0) {
          throw new Error(ERROR_CODES.FILE_TIMEOUT);
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
          throw new Error(ERROR_CODES.FILE_CANCELLED);
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

      debugLog(`[WebRTC] Relay transfer complete: ${totalChunks} chunks sent`);

      // 等待接收方确认组装完成（批量发送顺序保障；兼容旧客户端超时放行）
      const ok = await this._waitForFileEndAck(fileId);
      if (!ok) throw new Error(ERROR_CODES.TRANSFER_FAILED);
    } finally {
      // Keep transfer state for a grace period so the receiver can request
      // retransmission of chunks that were dropped in transit
      setTimeout(() => {
        this.activeTransfers.delete(fileId);
      }, RELAY.RETRANSMIT_GRACE);
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

    debugLog(`[WebRTC] Received ACK for chunks: ${acks.join(',')}, pending: ${transfer.pendingChunks.size}`);
  }

  /**
   * 等待接收方对 file-end 的确认（组装完成/失败）
   * 超时放行以兼容旧客户端
   */
  _waitForFileEndAck(fileId, timeout = 30000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.fileEndAckWaiters.delete(fileId);
        console.warn(`[WebRTC] file-end-ack 超时（兼容旧客户端）: ${fileId}`);
        resolve(true);
      }, timeout);
      this.fileEndAckWaiters.set(fileId, { resolve, timer });
    });
  }

  /**
   * 接收方 file-end-ack 到达：唤醒发送方等待者
   */
  _resolveFileEndAck(fileId, ok) {
    const waiter = this.fileEndAckWaiters.get(fileId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.fileEndAckWaiters.delete(fileId);
      waiter.resolve(ok !== false);
    }
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

  /**
   * 初始化接收存储：IndexedDB 可用则分块落盘（大文件不占内存），
   * 否则回退到内存数组
   */
  async _initTransferStorage(transfer, fileId, totalChunks) {
    transfer.useIdb = await chunkStore.isAvailable();
    transfer.chunkCount = 0;
    if (transfer.useIdb) {
      transfer.chunks = null; // 不再驻留内存
      debugLog(`[WebRTC] 分块落盘已启用（IndexedDB）：${fileId}`);
    } else {
      transfer.chunks = [];
    }
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
          await this._initTransferStorage(existingTransfer, msg.fileId, msg.totalChunks);
          // Register as active transfer for cancellation support
          this.activeTransfers.set(msg.fileId, { peerId, direction: 'receive', cancelled: false });
          debugLog(`[WebRTC] Starting confirmed file transfer: ${msg.name}`);
        } else {
          // Legacy flow or direct P2P without confirmation
          // Initialize new transfer
          const transfer = {
            fileId: msg.fileId, name: msg.name, size: msg.size,
            mimeType: msg.mimeType || 'application/octet-stream', // Save MIME type
            totalChunks: msg.totalChunks, chunks: [], received: 0, startTime: Date.now(),
            confirmed: true // Mark as confirmed since it's already starting
          };
          this.incomingTransfers.set(peerId, transfer);
          await this._initTransferStorage(transfer, msg.fileId, msg.totalChunks);
          // Register as active transfer
          this.activeTransfers.set(msg.fileId, { peerId, direction: 'receive', cancelled: false });
          debugLog(`[WebRTC] File transfer started (direct): ${msg.name}`);
        }

        // Notify for progress modal update
        if (this.onFileRequest) this.onFileRequest(peerId, msg);
      } else if (msg.type === 'file-end') {
        const transfer = this.incomingTransfers.get(peerId);
        if (transfer) {
          // Integrity check: never deliver an incomplete file
          const expectedChunks = transfer.totalChunks || 0;
          const chunkCount = transfer.useIdb ? transfer.chunkCount : (transfer.chunks ? transfer.chunks.length : 0);

          let blob = null;
          if (chunkCount === expectedChunks && transfer.received === transfer.size) {
            if (transfer.useIdb) {
              const stored = await chunkStore.getAllChunks(transfer.fileId);
              if (stored.length === expectedChunks) {
                blob = new Blob(stored, { type: transfer.mimeType || 'application/octet-stream' });
              }
            } else {
              blob = new Blob(transfer.chunks, { type: transfer.mimeType || 'application/octet-stream' });
            }
          }

          // 无论成败都清理落盘分块
          if (transfer.useIdb) chunkStore.deleteFile(transfer.fileId).catch(() => {});

          // 告知发送方组装结果（批量顺序保障）
          const ackDc = this.dataChannels.get(peerId);
          if (ackDc && ackDc.readyState === 'open') {
            try {
              ackDc.send(JSON.stringify({ type: 'file-end-ack', fileId: transfer.fileId, ok: !!blob }));
            } catch (e) { /* 忽略 */ }
          }

          if (!blob) {
            console.error(`[WebRTC] P2P transfer incomplete: ${chunkCount}/${expectedChunks} chunks, ${transfer.received}/${transfer.size} bytes - discarding`);
            if (this.onTransferFailed) {
              this.onTransferFailed(peerId, transfer.fileId, transfer.name, 'incomplete');
            }
            this.incomingTransfers.delete(peerId);
            this.activeTransfers.delete(transfer.fileId);
            return;
          }

          if (this.onFileReceived) this.onFileReceived(peerId, transfer.name, blob);
          this.incomingTransfers.delete(peerId);
          this.activeTransfers.delete(transfer.fileId);
        }
      } else if (msg.type === 'file-cancel') {
        // Handle cancel message from data channel
        this.handleFileCancel(peerId, msg);
      } else if (msg.type === 'file-end-ack') {
        this._resolveFileEndAck(msg.fileId, msg.ok);
      } else if (msg.type === 'text') {
        let content = msg.content;
        if (msg.isEncrypted) {
          try {
            content = await cryptoManager.decryptText(peerId, msg.content);
          } catch (e) {
            console.error('[WebRTC] Failed to decrypt text message:', e);
            content = i18n.t('chat.undecryptable');
          }
        }
        if (this.onTextReceived) this.onTextReceived(peerId, content);
      }
    } else {
      const transfer = this.incomingTransfers.get(peerId);
      if (transfer) {
        const decrypted = await cryptoManager.decryptChunk(peerId, data);
        const bytes = new Uint8Array(decrypted);

        if (transfer.useIdb) {
          // 大文件：分块落盘，避免内存 OOM
          await chunkStore.putChunk(transfer.fileId, transfer.chunkCount, bytes);
          transfer.chunkCount++;
        } else {
          transfer.chunks.push(bytes);
        }
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
      debugLog(`[WebRTC] Received relay data from ${peerId}, switching to relay mode`);
      this.relayMode.set(peerId, true);
      // Notify UI that we're in relay mode (receiver side)
      // Update badge but no toast (null message)
      this._notifyConnectionState(peerId, 'relay', null);
    }

    if (data.type === 'file-start') {
      // Check if we have a pre-confirmed transfer (from file-request flow)
      const existingTransfer = this.incomingTransfers.get(peerId);

      if (existingTransfer && existingTransfer.confirmed && existingTransfer.fileId === data.fileId) {
        // Transfer was already confirmed - RESET chunk state to avoid stale data!
        existingTransfer.startTime = Date.now();
        await this._initTransferStorage(existingTransfer, data.fileId, data.totalChunks);
        existingTransfer.received = 0;
        existingTransfer.totalChunks = data.totalChunks;
        existingTransfer.receivedIndices = new Set(); // Track received chunk indices
        // Register as active transfer for cancellation support
        this.activeTransfers.set(data.fileId, { peerId, direction: 'receive', cancelled: false });
        debugLog(`[WebRTC] Starting confirmed relay file transfer: ${data.name} (chunks reset)`);
      } else {
        // Clean up any stale transfer first
        if (existingTransfer) {
          debugLog(`[WebRTC] Cleaning up stale transfer for peer ${peerId}`);
          if (existingTransfer.useIdb && existingTransfer.fileId) {
            chunkStore.deleteFile(existingTransfer.fileId).catch(() => {});
          }
          this.incomingTransfers.delete(peerId);
          if (existingTransfer.fileId) {
            this.activeTransfers.delete(existingTransfer.fileId);
          }
        }

        // Initialize new transfer with fresh state
        const transfer = {
          fileId: data.fileId, name: data.name, size: data.size,
          mimeType: data.mimeType || 'application/octet-stream',
          totalChunks: data.totalChunks,
          chunks: [],           // Fresh empty array（useIdb 时置空）
          receivedIndices: new Set(), // Track received chunk indices
          received: 0,
          startTime: Date.now(),
          confirmed: true
        };
        this.incomingTransfers.set(peerId, transfer);
        await this._initTransferStorage(transfer, data.fileId, data.totalChunks);
        // Register as active transfer
        this.activeTransfers.set(data.fileId, { peerId, direction: 'receive', cancelled: false });
        debugLog(`[WebRTC] Relay file transfer started (direct): ${data.name}`);
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

        const collectMissing = () => {
          const missing = [];
          for (let i = 0; i < expectedCount; i++) {
            if (!transfer.receivedIndices || !transfer.receivedIndices.has(i)) {
              missing.push(i);
            }
          }
          return missing;
        };

        const waitForChunks = (ms) => new Promise(resolve => {
          const waitStart = Date.now();
          const checkInterval = setInterval(() => {
            receivedCount = transfer.receivedIndices ? transfer.receivedIndices.size : 0;
            if (receivedCount >= expectedCount || Date.now() - waitStart > ms) {
              clearInterval(checkInterval);
              resolve();
            }
          }, 100);
        });

        // Wait for in-flight chunks, then request retransmission of missing ones
        if (receivedCount < expectedCount) {
          debugLog(`[WebRTC] Waiting for in-flight chunks: ${receivedCount}/${expectedCount}`);
          await waitForChunks(RELAY.RETRANSMIT_WAIT);

          for (let round = 0; round < RELAY.RETRANSMIT_ROUNDS && receivedCount < expectedCount; round++) {
            const missing = collectMissing();
            if (missing.length === 0) break;
            debugLog(`[WebRTC] Requesting retransmission of ${missing.length} chunks (round ${round + 1}/${RELAY.RETRANSMIT_ROUNDS})`);
            this.signaling.send({
              type: 'relay-data',
              to: peerId,
              data: { type: 'retransmit-request', fileId: transfer.fileId, missing }
            });
            await waitForChunks(RELAY.RETRANSMIT_WAIT);
          }
        }

        // NEVER deliver an incomplete/corrupt file - fail the transfer instead
        if (receivedCount !== expectedCount || transfer.received !== transfer.size) {
          console.error(`[WebRTC] Transfer incomplete: expected ${expectedCount} chunks (${transfer.size} bytes), got ${receivedCount} chunks (${transfer.received} bytes) - discarding`);
          if (transfer.useIdb) chunkStore.deleteFile(transfer.fileId).catch(() => {});
          // 告知发送方组装失败（批量发送会中止后续文件）
          this.signaling.send({
            type: 'relay-data',
            to: peerId,
            data: { type: 'file-end-ack', fileId: transfer.fileId, ok: false }
          });
          if (this.onTransferFailed) {
            this.onTransferFailed(peerId, transfer.fileId, transfer.name, 'incomplete');
          }
          this.incomingTransfers.delete(peerId);
          this.activeTransfers.delete(transfer.fileId);
          return;
        }

        // Build blob from chunks in correct order
        let blob;
        if (transfer.useIdb) {
          const stored = await chunkStore.getAllChunks(transfer.fileId);
          blob = new Blob(stored, { type: transfer.mimeType || 'application/octet-stream' });
          chunkStore.deleteFile(transfer.fileId).catch(() => {});
        } else {
          const orderedChunks = [];
          for (let i = 0; i < expectedCount; i++) {
            orderedChunks.push(transfer.chunks[i]);
          }
          blob = new Blob(orderedChunks, { type: transfer.mimeType || 'application/octet-stream' });
        }

        debugLog(`[WebRTC] Transfer complete: ${receivedCount}/${expectedCount} chunks, size: ${blob.size}`);

        // 告知发送方组装完成（批量顺序保障）
        this.signaling.send({
          type: 'relay-data',
          to: peerId,
          data: { type: 'file-end-ack', fileId: transfer.fileId, ok: true }
        });

        if (this.onFileReceived) this.onFileReceived(peerId, transfer.name, blob);
        this.incomingTransfers.delete(peerId);
        this.activeTransfers.delete(transfer.fileId);
      }
    } else if (data.type === 'retransmit-request') {
      // Receiver asked for chunks missing at its end - resend if state still held
      const transfer = this.activeTransfers.get(data.fileId);
      if (transfer && transfer.direction === 'send' && transfer.pendingChunks) {
        const missing = Array.isArray(data.missing) ? data.missing : [];
        debugLog(`[WebRTC] Retransmitting ${missing.length} chunks for ${data.fileId}`);
        for (const index of missing) {
          const chunk = transfer.pendingChunks.get(index);
          if (chunk) {
            this._sendChunk(peerId, data.fileId, index, chunk.base64, chunk.retries + 1);
            chunk.retries += 1;
            chunk.sentAt = Date.now();
          }
        }
      }
    } else if (data.type === 'file-end-ack') {
      this._resolveFileEndAck(data.fileId, data.ok);
    } else if (data.type === 'chunk') {
      const transfer = this.incomingTransfers.get(peerId);
      if (transfer && transfer.fileId === data.fileId) {
        const chunkIndex = data.index !== undefined ? data.index : (transfer.chunkCount || 0);

        // Skip duplicate chunks (from retransmission)
        if (transfer.receivedIndices && transfer.receivedIndices.has(chunkIndex)) {
          debugLog(`[WebRTC] Skipping duplicate chunk ${chunkIndex}`);
          // Still send ACK for duplicate to confirm receipt
          this._sendChunkAck(peerId, data.fileId, [chunkIndex]);
          return;
        }

        try {
          const bytes = base64ToUint8Array(data.data);

          const decrypted = await cryptoManager.decryptChunk(peerId, bytes.buffer);

          // Place chunk in correct position (IDB 落盘或内存数组)
          if (transfer.useIdb) {
            await chunkStore.putChunk(transfer.fileId, chunkIndex, new Uint8Array(decrypted));
            transfer.chunkCount = Math.max(transfer.chunkCount || 0, chunkIndex + 1);
          } else if (transfer.chunks) {
            transfer.chunks[chunkIndex] = new Uint8Array(decrypted);
          }
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
      let content = data.content;
      if (data.isEncrypted) {
        try {
          content = await cryptoManager.decryptText(peerId, data.content);
        } catch (e) {
          console.error('[WebRTC] Failed to decrypt relay text message:', e);
          content = i18n.t('chat.undecryptableRelay');
        }
      }
      if (this.onTextReceived) this.onTextReceived(peerId, content);
    }
  }

  // Send text - automatically uses best available method
  async sendText(peerId, text) {
    // Try to establish connection (may result in P2P or relay)
    await this.ensureConnection(peerId);

    // Check if we're in relay mode after connection attempt
    if (this.relayMode.get(peerId)) {
      debugLog(`[WebRTC] Sending text to ${peerId} via relay`);
      return this._sendTextViaRelay(peerId, text);
    }

    // Verify we have a working P2P channel
    const dc = this.dataChannels.get(peerId);
    if (!dc || dc.readyState !== 'open') {
      debugLog(`[WebRTC] No P2P channel available for text, using relay for ${peerId}`);
      // Silent switch - already in usable state
      this._switchToRelay(peerId, null, true);
      return this._sendTextViaRelay(peerId, text);
    }

    debugLog(`[WebRTC] Sending text to ${peerId} via P2P`);
    const encrypted = await cryptoManager.encryptText(peerId, text);
    const payload = JSON.stringify({ type: 'text', content: encrypted, isEncrypted: true });

    // Pre-check: oversized messages fail loudly instead of silently breaking
    // the data channel (or being dropped by the relay server)
    if (payload.length > MAX_TEXT_PAYLOAD) {
      throw new Error(ERROR_CODES.MESSAGE_TOO_LARGE);
    }

    dc.send(payload);
  }

  async _sendTextViaRelay(peerId, text) {
    // Ensure we have encryption key before sending
    if (!cryptoManager.hasSharedSecret(peerId)) {
      debugLog(`[WebRTC] No shared key for ${peerId}, exchanging keys...`);
      await this._exchangeKeysViaSignaling(peerId);
    }

    const encrypted = await cryptoManager.encryptText(peerId, text);
    const relayPayload = { type: 'text', content: encrypted, isEncrypted: true };

    // Pre-check against the server 256KB limit - fail loudly instead of
    // letting the server drop the message silently
    if (JSON.stringify(relayPayload).length > MAX_TEXT_PAYLOAD) {
      throw new Error(ERROR_CODES.MESSAGE_TOO_LARGE);
    }

    this.signaling.send({
      type: 'relay-data',
      to: peerId,
      data: relayPayload
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
    debugLog(`[WebRTC] Key exchange completed with ${peerId}`);
  }

  /**
   * Handle incoming key exchange request
   */
  async handleKeyExchange(peerId, data) {
    if (data.publicKey) {
      await cryptoManager.importPeerPublicKey(peerId, data.publicKey);
      this._resolveKeyWaiters(peerId);
      if (this.onPeerKeyReady) this.onPeerKeyReady(peerId);
      debugLog(`[WebRTC] Imported public key from ${peerId} via key-exchange`);

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

  /**
   * Event-driven wait for the data channel to open (replaces 100ms polling)
   */
  waitForChannel(peerId, timeout = CONNECTION_TIMEOUT) {
    const ch = this.dataChannels.get(peerId);
    if (ch && ch.readyState === 'open') return Promise.resolve();

    // Fail fast if the connection is already dead
    const pc = this.connections.get(peerId);
    if (pc && (pc.connectionState === 'failed' || pc.connectionState === 'closed')) {
      return Promise.reject(new Error('Connection failed'));
    }

    return this._waitForEvent('channelWaiters', peerId, timeout, 'Channel timeout');
  }

  /**
   * Event-driven wait for the ECDH shared key (replaces 100ms polling)
   */
  waitForEncryptionKey(peerId, timeout = CONNECTION_TIMEOUT) {
    if (cryptoManager.hasSharedSecret(peerId)) return Promise.resolve();
    return this._waitForEvent('keyWaiters', peerId, timeout, 'Encryption key timeout');
  }

  /**
   * 通用事件等待器：注册 resolve/reject 到 waiter map，超时自动清理
   */
  _waitForEvent(mapKey, peerId, timeout, timeoutError) {
    let waiter = this[mapKey].get(peerId);
    if (waiter) return waiter.promise;

    let resolveFn, rejectFn;
    const promise = new Promise((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    const timer = setTimeout(() => {
      this[mapKey].delete(peerId);
      rejectFn(new Error(timeoutError));
    }, timeout);
    waiter = { promise, resolve: resolveFn, reject: rejectFn, timer };
    this[mapKey].set(peerId, waiter);
    return promise;
  }

  /**
   * Wake channel waiters (data channel opened)
   */
  _resolveChannelWaiters(peerId) {
    const waiter = this.channelWaiters.get(peerId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.channelWaiters.delete(peerId);
      waiter.resolve();
    }
  }

  /**
   * Wake key waiters (ECDH shared secret ready)
   */
  _resolveKeyWaiters(peerId) {
    const waiter = this.keyWaiters.get(peerId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.keyWaiters.delete(peerId);
      waiter.resolve();
    }
  }

  /**
   * Reject all waiters for a peer (connection closed/failed)
   */
  _rejectPeerWaiters(peerId, error) {
    for (const mapKey of ['channelWaiters', 'keyWaiters']) {
      const waiter = this[mapKey].get(peerId);
      if (waiter) {
        clearTimeout(waiter.timer);
        this[mapKey].delete(peerId);
        waiter.reject(error);
      }
    }
  }

  /**
   * Ensure connection is established - uses racing strategy for fast fallback
   * This is the main entry point for establishing connections
   */
  async ensureConnection(peerId) {
    // Already in relay mode? Skip P2P attempt
    if (this.relayMode.get(peerId)) {
      debugLog(`[WebRTC] Already in relay mode for ${peerId}`);
      return;
    }

    const channel = this.dataChannels.get(peerId);
    const hasKey = cryptoManager.hasSharedSecret(peerId);

    // Already have a working P2P connection?
    if (channel && channel.readyState === 'open' && hasKey) {
      debugLog(`[WebRTC] Reusing existing P2P connection to ${peerId}`);
      return;
    }

    // A race (e.g. silent prewarm) is already in progress for this peer - reuse
    // its outcome instead of starting a second, competing race
    const inFlightRace = this.connectionRacing.get(peerId);
    if (inFlightRace && inFlightRace.promise) {
      debugLog(`[WebRTC] Reusing in-flight race for ${peerId}`);
      const result = await inFlightRace.promise;
      if (result === 'p2p' || result === 'relay') {
        // Connection state already handled by the race (channel open or relay mode set)
        if (result === 'p2p') this._notifyConnectionState(peerId, 'connected', null);
        return;
      }
      // 'failed' - fall through and run our own race
      debugLog(`[WebRTC] In-flight race for ${peerId} failed, starting new attempt`);
    }

    // Already establishing connection?
    if (this.pendingConnections.has(peerId)) {
      debugLog(`[WebRTC] Waiting for pending connection to ${peerId}`);
      return this.pendingConnections.get(peerId);
    }

    debugLog(`[WebRTC] Starting connection with racing strategy to ${peerId}`);
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
        debugLog(`[WebRTC] P2P connection won the race for ${peerId}`);
      }
      return 'p2p';
    }).catch(err => {
      debugLog(`[WebRTC] P2P attempt failed for ${peerId}: ${err.message}`);
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
            debugLog(`[WebRTC] Fast-fallback triggered for ${peerId}`);
            this._switchToRelay(peerId, i18n.t('transfer.connection.switchedToRelay'));
            resolve('relay');
          } else {
            // P2P seems promising, give it more time
            debugLog(`[WebRTC] P2P showing progress for ${peerId}, extending timeout`);
          }
        }
      }, this.relayFallbackTimeout);

      // Ultimate timeout - switch to relay if P2P not established
      const ultimateTimer = setTimeout(() => {
        clearTimeout(slowTimer);
        clearTimeout(fallbackTimer);

        if (!racingState.resolved) {
          debugLog(`[WebRTC] Ultimate timeout for ${peerId}, switching to relay`);
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
    const racePromise = Promise.race([
      p2pPromise,
      fallbackPromise
    ]).finally(() => {
      this.connectionRacing.delete(peerId);
    });

    // Expose the promise so concurrent callers (e.g. ensureConnection) can
    // await the same race instead of starting a competing one
    racingState.promise = racePromise;
    return racePromise;
  }

  /**
   * Silent version of _raceP2PWithFallback for prewarming
   * No UI toasts. On fallback the peer is SILENTLY marked as relay (badge only)
   * and encryption keys are pre-exchanged, so the first message/file goes out
   * instantly instead of re-running the whole race. The in-flight P2P attempt
   * keeps running in the background - if it eventually opens a data channel,
   * setupDataChannel.onopen upgrades the connection back to P2P automatically.
   */
  async _raceP2PWithFallbackSilent(peerId) {
    const racingState = { resolved: false, winner: null, silent: true };
    this.connectionRacing.set(peerId, racingState);

    // Create P2P connection attempt (silent - no notification)
    const p2pPromise = this._attemptP2PConnectionSilent(peerId).then(() => {
      if (!racingState.resolved) {
        racingState.resolved = true;
        racingState.winner = 'p2p';
        debugLog(`[WebRTC] Prewarm P2P succeeded for ${peerId}`);
      }
      return 'p2p';
    }).catch(err => {
      debugLog(`[WebRTC] Prewarm P2P failed for ${peerId}: ${err.message}`);
      // If we already fell back to relay, take over background P2P retrying now
      // that the in-flight prewarm attempt has ended.
      if (this.relayMode.get(peerId) && !this.p2pRetryTimers.has(peerId)) {
        debugLog(`[WebRTC] In-flight prewarm attempt ended for ${peerId}, starting background P2P retry`);
        this._startBackgroundP2PRetry(peerId);
      }
      return racingState.winner || 'failed';
    });

    // Proactive fallback: if P2P isn't established quickly, switch to relay
    // silently (badge only) so subsequent sends are instant.
    const fallbackPromise = new Promise((resolve, reject) => {
      const fallbackToRelay = () => {
        if (racingState.resolved) return;
        racingState.resolved = true;
        racingState.winner = 'relay';
        debugLog(`[WebRTC] Prewarm falling back to relay for ${peerId} (proactive)`);
        // Silent switch + skip background retry (the in-flight attempt above is still running)
        this._switchToRelay(peerId, null, true, true);
        resolve('relay');
      };

      // Fast fallback timer (respects user's relay fallback setting)
      const fallbackTimer = setTimeout(() => {
        if (!racingState.resolved) {
          const shouldFallback = this.relayFallbackEnabled &&
            (this._shouldFastFallback(peerId) || !this._hasP2PProgress(peerId));
          if (shouldFallback) {
            fallbackToRelay();
          }
        }
      }, this.relayFallbackTimeout);

      // Ultimate timeout
      const ultimateTimer = setTimeout(() => {
        clearTimeout(fallbackTimer);
        if (!racingState.resolved) {
          if (this.relayFallbackEnabled) {
            fallbackToRelay();
          } else {
            reject(new Error('Prewarm ultimate timeout - will retry on actual transfer'));
          }
        }
      }, CONNECTION_TIMEOUT);

      p2pPromise.then((result) => {
        clearTimeout(fallbackTimer);
        clearTimeout(ultimateTimer);
        if (racingState.resolved) {
          resolve(racingState.winner);
        } else if (result === 'p2p') {
          resolve('p2p');
        } else if (this.relayFallbackEnabled) {
          // P2P attempt failed before any timer fired - fall back now
          fallbackToRelay();
        } else {
          resolve('failed');
        }
      });
    });

    const racePromise = Promise.race([p2pPromise, fallbackPromise]).finally(() => {
      this.connectionRacing.delete(peerId);
    });

    // Expose the promise so concurrent callers (e.g. ensureConnection) can
    // await the same race instead of starting a competing one
    racingState.promise = racePromise;
    return racePromise;
  }

  /**
   * Pre-exchange encryption keys for a peer (fire-and-forget)
   * Called when proactively switching to relay so the first relay message
   * doesn't have to wait for the ECDH handshake.
   */
  _prewarmEncryptionKeys(peerId) {
    if (cryptoManager.hasSharedSecret(peerId)) return;

    debugLog(`[WebRTC] Pre-exchanging encryption keys with ${peerId} for relay mode`);
    this._exchangeKeysViaSignaling(peerId).catch(err => {
      // Non-fatal - the key exchange will be retried on first actual send
      console.warn(`[WebRTC] Prewarm key exchange failed for ${peerId}: ${err.message}`);
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
   * Check if P2P connection is making REAL progress
   * A connection only gets the full ultimate timeout when there is actual NAT
   * traversal evidence (srflx = STUN reachable, prflx = connectivity already
   * worked). Host-only candidates with ICE stuck in 'checking' almost always
   * means STUN/UDP is blocked and P2P will never connect - those cases fall
   * back at the fast timeout instead of waiting the full 10s.
   */
  _hasP2PProgress(peerId) {
    const pc = this.connections.get(peerId);
    const types = this.candidateTypes.get(peerId);

    // Real NAT traversal evidence: srflx (STUN reachable) or prflx (symmetric NAT)
    const hasTraversalCandidates = types && (
      types.has('srflx') ||
      types.has('prflx')
    );

    // ICE already connected/completed = definitely progressing (channel about to open)
    const iceConnected = pc && ['connected', 'completed'].includes(pc.iceConnectionState);

    // ICE checking with traversal candidates = likely to succeed soon
    const iceChecking = pc && pc.iceConnectionState === 'checking';

    return iceConnected || (hasTraversalCandidates && iceChecking);
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

    debugLog(`[WebRTC] P2P connection established with ${peerId}`);
  }

  _notifyConnectionState(peerId, status, message) {
    if (this.onConnectionStateChange) {
      this.onConnectionStateChange({ peerId, status, message });
    }
  }

  // Close connection and cleanup all state
  closeConnection(peerId, preserveRelay = false) {
    const wasRelay = this.relayMode.get(peerId);

    // Reject pending waiters (connection is going away)
    this._rejectPeerWaiters(peerId, new Error('Connection closed'));

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
    if (preserveRelay && wasRelay) {
      // Internal teardown while in relay mode - keep relay active so background
      // P2P retry and relay messaging keep working
      this.relayMode.set(peerId, true);
      debugLog(`[WebRTC] Relay mode preserved for ${peerId} during connection cleanup`);
    }
    this.knownPeers?.delete(peerId);

    if (preserveRelay && wasRelay) {
      // Keep the shared encryption secret so relay messaging keeps working
      // without a new ECDH key exchange
    } else {
      cryptoManager.removePeer(peerId);
    }
  }

  // Close all
  closeAll() {
    for (const peerId of this.connections.keys()) this.closeConnection(peerId);
  }

  /**
   * Full teardown: stop all timers, close all connections, detach callbacks.
   * Called before replacing this manager (reconnect / room switch) so stale
   * timers and in-flight promises can't leak into the new instance's UI.
   */
  destroy() {
    // Stop pending timers
    for (const timer of this.disconnectedTimers.values()) clearTimeout(timer);
    for (const timer of this.p2pRetryTimers.values()) clearTimeout(timer);
    for (const waiter of this.fileEndAckWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve(true);
    }
    this.disconnectedTimers.clear();
    this.p2pRetryTimers.clear();
    this.p2pRetryAttempts.clear();
    this.fileEndAckWaiters.clear();

    // Close all connections and clean up state
    this.closeAll();

    // 清理未完成的接收传输及其落盘分块
    for (const [peerId, transfer] of this.incomingTransfers.entries()) {
      if (transfer.useIdb && transfer.fileId) {
        chunkStore.deleteFile(transfer.fileId).catch(() => {});
      }
    }
    this.incomingTransfers.clear();
    this.activeTransfers.clear();

    // Detach callbacks so late async completions are ignored
    this.onFileReceived = null;
    this.onFileRequest = null;
    this.onFileRequestResponse = null;
    this.onTransferStart = null;
    this.onProgress = null;
    this.onTextReceived = null;
    this.onConnectionStateChange = null;
    this.onTransferCancelled = null;
    this.onTransferFailed = null;
    this.onPeerKeyReady = null;

    debugLog('[WebRTC] Manager destroyed');
  }
}
