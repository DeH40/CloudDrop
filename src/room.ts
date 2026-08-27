/**
 * CloudDrop - Durable Object for room management
 * Manages WebSocket connections and signaling for P2P file sharing
 * Supports optional password protection for secure rooms
 */

// WebSocket readyState constants (may not be available in Workers environment)
const WS_READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
};

export interface Env {
  ROOM: DurableObjectNamespace;
}

interface SignalingMessage {
  type: 'join' | 'offer' | 'answer' | 'ice-candidate' | 'peer-joined' | 'peer-left' | 'relay-data' | 'name-changed' | 'key-exchange' | 'file-request' | 'file-response' | 'file-cancel' | 'identity-challenge' | 'identity-response' | 'set-password' | 'set-password-result' | 'room-locked' | 'auth' | 'auth-success' | 'challenge';
  from?: string;
  to?: string;
  data?: unknown;
}

/**
 * Peer attachment data stored with WebSocket (survives hibernation)
 */
interface PeerAttachment {
  id?: string;
  name?: string;
  deviceType?: 'desktop' | 'mobile' | 'tablet';
  browserInfo?: string;
  deviceKey?: string; // 持久设备身份公钥（防伪造信任）
  publicKey?: string;
  isAuthenticated?: boolean;
  authChallenge?: string;
  authAttempts?: number; // Track failed attempts per connection
  clientBucket?: string; // 客户端网段桶（/24 或 /64 哈希），per-IP 爆破计数用
  joinedAt?: number; // 加入房间时间戳（设密在场要求）
}

/**
 * Room Durable Object - handles WebSocket connections for a room (based on IP)
 * Uses WebSocket Hibernation API for cost efficiency
 * Peer data is stored in WebSocket attachments to survive hibernation
 * Supports optional password protection for secure rooms
 */
export class Room {
  private state: DurableObjectState;
  private passwordHash: string | null; // Password hash for secure rooms (null = no password)
  private messageRateLimits: Map<WebSocket, { count: number; lastReset: number }> = new Map();
  private relayByteBudget: Map<WebSocket, { tokens: number; lastRefill: number }> = new Map();
  private relayDropWarn: Map<WebSocket, number> = new Map(); // ws -> last warning timestamp
  // peerId -> WebSocket cache to avoid getWebSockets()+JSON deserialization per message.
  // Lazily rebuilt (null on hibernation wake, stale entries pruned on close).
  private peerWsCache: Map<string, WebSocket> | null = null;
  // Removed global passwordAttempts to prevent DoS

  // Constants
  private static readonly MAX_NAME_LENGTH = 50;
  private static readonly RATE_LIMIT_WINDOW = 1000; // 1 second
  private static readonly MAX_MSGS_PER_WINDOW = 10; // 10 messages per second (control messages)
  private static readonly RELAY_BYTES_PER_SEC = 2 * 1024 * 1024; // 2MB/s data budget for relay/ICE
  private static readonly RELAY_BURST_BYTES = 4 * 1024 * 1024; // 4MB burst allowance
  private static readonly MAX_PASSWORD_ATTEMPTS = 5; // 5 attempts per connection
  private static readonly MAX_ROOM_AUTH_FAILURES = 50; // Global failures per room within window
  private static readonly MAX_IP_AUTH_FAILURES = 10; // Per network-bucket failures within window
  private static readonly AUTH_FAILURE_WINDOW = 10 * 60 * 1000; // 10 minutes
  private static readonly ROOM_CLAIM_MIN_PRESENCE = 3000; // 设密前需在房间内最短 3 秒
  private static readonly SECURE_ROOM_TTL = 600000; // 10 minutes

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
    this.passwordHash = null;

    // Load password hash from storage on initialization
    this.state.blockConcurrencyWhile(async () => {
      this.passwordHash = await this.state.storage.get<string>('passwordHash') || null;
      // If there's a password, set an alarm to check for inactivity
      if (this.passwordHash) {
         await this.scheduleInactivityCheck();
      }
    });
  }

  /**
   * Schedule inactivity check alarm
   */
  private async scheduleInactivityCheck() {
     const currentAlarm = await this.state.storage.getAlarm();
     if (currentAlarm === null) {
        await this.state.storage.setAlarm(Date.now() + Room.SECURE_ROOM_TTL);
     }
  }

  /**
   * Handle Durable Object Alarm
   * Triggered when room is inactive for too long
   */
  async alarm(): Promise<void> {
    // Check if room has any AUTHENTICATED peers
    const activePeers = this.getActivePeers();
    let hasAuthenticatedUsers = false;
    
    for (const { attachment } of activePeers.values()) {
      if (attachment.isAuthenticated) {
        hasAuthenticatedUsers = true;
        break;
      }
    }

    if (!hasAuthenticatedUsers && this.passwordHash) {
       // Room is empty (or only has unauthenticated ghosts) -> destroy it
       this.passwordHash = null;
       await this.state.storage.delete('passwordHash');

       // Close ALL connections (authenticated or not) - the room is gone.
       // getActivePeers() only returns joined peers, so iterate sockets directly.
       for (const ws of this.state.getWebSockets()) {
         try { ws.close(4000, 'Room destroyed due to inactivity'); } catch (e) { /* ignore */ }
       }

       console.log('[Room] Secure room destroyed due to inactivity');
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      return this.handleWebSocket(request);
    }

    if (url.pathname === '/check-password') {
      // Check if room has password protection
      return this.handleCheckPassword(request);
    }

    return new Response('Not Found', { status: 404 });
  }

  /**
   * Check if room requires password
   */
  private handleCheckPassword(_request: Request): Response {
    return new Response(JSON.stringify({
      hasPassword: this.passwordHash !== null
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  /**
   * 通过 WebSocket 在房间内设置密码（替代原 HTTP 端点）
   * 要求发送者已加入房间（持有 peerId），从根本封死任意房间抢注
   */
  private async handleSetPasswordViaWs(ws: WebSocket, msg: SignalingMessage): Promise<void> {
    const attachment = ws.deserializeAttachment() as PeerAttachment | null;

    // 未加入房间的连接不能设置密码
    if (!attachment?.id) {
      this.sendErrorFrame(ws, 'FORBIDDEN', '需要先加入房间才能设置密码');
      return;
    }

    // 只允许首次设置；要求设置者已在房间内待满最短时间（提高抢注成本）
    if (this.passwordHash !== null) {
      this.sendErrorFrame(ws, 'PASSWORD_ALREADY_SET', '房间密码已设置');
      return;
    }

    if (!attachment.joinedAt || (Date.now() - attachment.joinedAt) < Room.ROOM_CLAIM_MIN_PRESENCE) {
      this.sendErrorFrame(ws, 'FORBIDDEN', '需要先在房间内停留片刻才能设置密码');
      return;
    }

    const body = msg.data as { passwordHash?: string };
    // 严格格式：64 位十六进制（SHA-256）
    if (!body?.passwordHash || typeof body.passwordHash !== 'string' || !/^[a-f0-9]{64}$/i.test(body.passwordHash)) {
      this.sendErrorFrame(ws, 'INVALID_PASSWORD_HASH', '无效的密码哈希');
      return;
    }

    this.passwordHash = body.passwordHash;
    await this.state.storage.put('passwordHash', body.passwordHash);
    await this.state.storage.setAlarm(Date.now() + Room.SECURE_ROOM_TTL);

    ws.send(JSON.stringify({ type: 'set-password-result', success: true }));

    // 通知房间内其他设备：房间已被加密，需要密码重新加入
    this.broadcast({ type: 'room-locked', data: {} }, attachment.id);
  }

  private handleWebSocket(request: Request): Response {
    // Check for WebSocket upgrade
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    // Get room code from header (passed by index.ts)
    const roomCode = request.headers.get('X-Room-Code') || '';

    // Create WebSocket pair
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Accept the WebSocket with hibernation API
    // Use tag to store room code (survives hibernation)
    this.state.acceptWebSocket(server, [roomCode]);

    // Generate challenge nonce
    const nonce = crypto.randomUUID();

    // Initialize attachment with isAuthenticated: false if password is set
    // If no password, they are implicitly authenticated
    server.serializeAttachment({
      isAuthenticated: this.passwordHash === null,
      authChallenge: nonce,
      authAttempts: 0,
      clientBucket: this.sanitizeString(request.headers.get('X-Client-Bucket') || '', 64)
    });

    // Initialize rate limiter for this connection
    this.messageRateLimits.set(server, { count: 0, lastReset: Date.now() });

    // If password is required, send challenge immediately
    if (this.passwordHash !== null) {
      server.send(JSON.stringify({
        type: 'challenge',
        data: { nonce }
      }));
      // Do NOT delete alarm here. Wait until auth success.
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  /**
   * Get all active peers from WebSocket attachments (survives hibernation)
   * Only returns peers with OPEN WebSocket connections
   */
  private getActivePeers(): Map<string, { ws: WebSocket; attachment: PeerAttachment }> {
    const peers = new Map<string, { ws: WebSocket; attachment: PeerAttachment }>();
    const webSockets = this.state.getWebSockets();

    for (const ws of webSockets) {
      const attachment = ws.deserializeAttachment() as PeerAttachment | null;
      const readyState = ws.readyState;

      // Only include WebSockets that are OPEN (readyState === 1) and have valid attachment
      // Use explicit constant as WebSocket.OPEN may not be available in Workers
      if (attachment && attachment.id && readyState === WS_READY_STATE.OPEN) {
        peers.set(attachment.id, { ws, attachment });
      }
    }

    return peers;
  }

  /**
   * Get peer ID from WebSocket attachment
   */
  private getPeerIdFromWs(ws: WebSocket): string | undefined {
    const attachment = ws.deserializeAttachment() as PeerAttachment | null;
    return attachment?.id;
  }

  /**
   * WebSocket message handler (Hibernation API)
   */
  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    try {
      const data = typeof message === 'string' ? message : new TextDecoder().decode(message);

      // 1. Message Size Validation (Basic DoS protection)
      if (data.length > 262144) { 
         this.sendErrorFrame(ws, 'MESSAGE_TOO_LARGE', 'Message exceeds size limit (256KB)');
         return;
      }

      const msg: SignalingMessage = JSON.parse(data);

      // 2. Typed rate limiting:
      //    - relay-data / ice-candidate: byte-based token bucket (2MB/s) so file
      //      chunks and ICE candidates are NOT starved by the control limiter
      //    - all other (control) messages: low per-connection message quota,
      //      exceeded -> identifiable error frame instead of silent drop
      if (msg.type === 'relay-data' || msg.type === 'ice-candidate') {
        if (!this.consumeRelayBudget(ws, data.length)) {
          if (msg.type === 'ice-candidate') {
            // ICE 候选被丢会伤 P2P 协商，明确告知
            this.sendErrorFrame(ws, 'RATE_LIMIT_EXCEEDED', 'ICE candidate 发送过快');
          } else {
            // 分块丢弃由 ACK/重传自愈；限频告警（每秒最多一条）
            const now = Date.now();
            const lastWarn = this.relayDropWarn.get(ws) || 0;
            if (now - lastWarn > 1000) {
              this.relayDropWarn.set(ws, now);
              this.sendErrorFrame(ws, 'RATE_LIMIT_EXCEEDED', '中继数据超速，部分分块已丢弃（将自动重传）');
            }
          }
          return;
        }
      } else if (this.isRateLimited(ws)) {
        this.sendErrorFrame(ws, 'RATE_LIMIT_EXCEEDED', '消息发送过快，请稍后重试');
        return;
      }

      // Check authentication
      const attachment = ws.deserializeAttachment() as PeerAttachment | null;
      // If room has password and user is not authenticated yet
      if (this.passwordHash !== null) {
        const isAuthenticated = attachment?.isAuthenticated === true;
        
        if (!isAuthenticated) {
          if (msg.type === 'auth') {
             await this.handleAuth(ws, msg, attachment);
             return;
          }
          
          // Reject any other message type if not authenticated
          ws.send(JSON.stringify({
            type: 'error',
            error: 'PASSWORD_REQUIRED',
            message: '此房间需要密码'
          }));
          return;
        }
      }

      switch (msg.type) {
        case 'join':
          await this.handleJoin(ws, msg);
          break;
        case 'offer':
        case 'answer':
        case 'ice-candidate':
        case 'identity-challenge':
        case 'identity-response':
          await this.handleSignaling(ws, msg);
          break;
        case 'set-password':
          await this.handleSetPasswordViaWs(ws, msg);
          break;
        case 'relay-data':
          await this.handleRelayData(ws, msg);
          break;
        case 'key-exchange':
          await this.handleKeyExchange(ws, msg);
          break;
        case 'name-changed':
          await this.handleNameChanged(ws, msg);
          break;
        case 'file-request':
        case 'file-response':
        case 'file-cancel':
          await this.handleFileSignaling(ws, msg);
          break;
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  }

  /**
   * 读取某网段桶的认证失败计数（过期自动视为清零）
   */
  private async getBucketAuthFailures(bucket: string): Promise<{ count: number; windowStart: number }> {
    const all = await this.state.storage.get<Record<string, { count: number; windowStart: number }>>('authFailuresByBucket') || {};
    const now = Date.now();
    const entry = all[bucket];
    if (entry && (now - entry.windowStart) < Room.AUTH_FAILURE_WINDOW) {
      return entry;
    }
    return { count: 0, windowStart: now };
  }

  /**
   * 递增某网段桶的认证失败计数（清理过期条目，防存储无限增长）
   */
  private async incrementBucketAuthFailures(bucket: string): Promise<void> {
    await this.state.blockConcurrencyWhile(async () => {
      const all = await this.state.storage.get<Record<string, { count: number; windowStart: number }>>('authFailuresByBucket') || {};
      const now = Date.now();

      for (const k of Object.keys(all)) {
        if (now - all[k].windowStart >= Room.AUTH_FAILURE_WINDOW) {
          delete all[k];
        }
      }

      const entry = all[bucket] || { count: 0, windowStart: now };
      entry.count += 1;
      entry.windowStart = now;
      all[bucket] = entry;

      await this.state.storage.put('authFailuresByBucket', all);
    });
  }

  /**
   * 认证成功后清除该网段桶的失败计数
   */
  private async clearBucketAuthFailures(bucket: string): Promise<void> {
    const all = await this.state.storage.get<Record<string, { count: number; windowStart: number }>>('authFailuresByBucket');
    if (!all || !all[bucket]) return;
    delete all[bucket];
    await this.state.storage.put('authFailuresByBucket', all);
  }

  /**
   * Check if WebSocket is rate limited (control messages only)
   */
  private isRateLimited(ws: WebSocket): boolean {
    let limit = this.messageRateLimits.get(ws);
    const now = Date.now();

    if (!limit) {
      limit = { count: 0, lastReset: now };
      this.messageRateLimits.set(ws, limit);
    }

    if (now - limit.lastReset > Room.RATE_LIMIT_WINDOW) {
      limit.count = 0;
      limit.lastReset = now;
    }

    limit.count++;

    // If exceeded, we can block
    if (limit.count > Room.MAX_MSGS_PER_WINDOW) {
      return true;
    }

    return false;
  }

  /**
   * Byte-based token bucket for data-heavy messages (relay chunks, ICE candidates)
   * Allows ~2MB/s sustained with 4MB burst - file chunks recover from drops via
   * the ACK/retransmission protocol, so silent drop is safe here.
   */
  private consumeRelayBudget(ws: WebSocket, bytes: number): boolean {
    const now = Date.now();
    let budget = this.relayByteBudget.get(ws);

    if (!budget) {
      budget = { tokens: Room.RELAY_BURST_BYTES, lastRefill: now };
      this.relayByteBudget.set(ws, budget);
    }

    // Refill based on elapsed time
    const elapsed = (now - budget.lastRefill) / 1000;
    budget.tokens = Math.min(Room.RELAY_BURST_BYTES, budget.tokens + elapsed * Room.RELAY_BYTES_PER_SEC);
    budget.lastRefill = now;

    if (budget.tokens < bytes) {
      return false;
    }

    budget.tokens -= bytes;
    return true;
  }

  /**
   * Send an error frame to a client
   */
  private sendErrorFrame(ws: WebSocket, error: string, message: string): void {
    try {
      ws.send(JSON.stringify({ type: 'error', error, message }));
    } catch (e) {
      // Connection may be closing - ignore
    }
  }

  /**
   * Handle authentication request with brute-force protection
   */
  private async handleAuth(ws: WebSocket, msg: SignalingMessage, currentAttachment: PeerAttachment | null): Promise<void> {
    // Check per-connection attempts
    const attempts = currentAttachment?.authAttempts || 0;
    if (attempts >= Room.MAX_PASSWORD_ATTEMPTS) {
      this.sendErrorFrame(ws, 'RATE_LIMIT_EXCEEDED', '尝试次数过多，请重新连接');
      ws.close(4002, 'RATE_LIMIT_EXCEEDED');
      return;
    }

    // Global room-level brute-force protection (survives reconnects - the
    // per-connection counter alone is trivially bypassed by reconnecting)
    const now = Date.now();
    const storedFailures = await this.state.storage.get<{ count: number; windowStart: number }>('authFailures');
    const failures = storedFailures && (now - storedFailures.windowStart) < Room.AUTH_FAILURE_WINDOW
      ? storedFailures
      : { count: 0, windowStart: now };

    if (failures.count >= Room.MAX_ROOM_AUTH_FAILURES) {
      this.sendErrorFrame(ws, 'RATE_LIMIT_EXCEEDED', '尝试次数过多，请稍后再试');
      ws.close(4002, 'RATE_LIMIT_EXCEEDED');
      return;
    }

    // Per-network-bucket brute-force protection（CF-Connecting-IP 网段桶，
    // 换连接/换 IPv6 临时地址都无法绕过；分布式换网段由全局计数兑底）
    const clientBucket = currentAttachment?.clientBucket || '';
    if (clientBucket) {
      const bucketFailures = await this.getBucketAuthFailures(clientBucket);
      if (bucketFailures.count >= Room.MAX_IP_AUTH_FAILURES) {
        this.sendErrorFrame(ws, 'RATE_LIMIT_EXCEEDED', '尝试次数过多，请稍后再试');
        ws.close(4002, 'RATE_LIMIT_EXCEEDED');
        return;
      }
    }

    const authData = msg.data as { response: string };
    const expectedNonce = currentAttachment?.authChallenge;

    if (!expectedNonce || !this.passwordHash) {
       ws.close(4002, 'AUTH_ERROR');
       return;
    }

    // Verify response = SHA256(passwordHash + nonce)
    const encoder = new TextEncoder();
    const data = encoder.encode(this.passwordHash + expectedNonce);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const expectedResponse = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    
    if (authData && authData.response === expectedResponse) {
      // Authentication successful
      
      // Reset global failure counter
      await this.state.storage.delete('authFailures');

      // Reset per-bucket failure counter
      if (currentAttachment?.clientBucket) {
        await this.clearBucketAuthFailures(currentAttachment.clientBucket);
      }

      // Clear challenge and set authenticated
      ws.serializeAttachment({
        ...currentAttachment,
        isAuthenticated: true,
        authChallenge: undefined,
        authAttempts: 0
      });
      
      // Now that we have a verified user, we can clear the inactivity alarm
      await this.state.storage.deleteAlarm();

      ws.send(JSON.stringify({
        type: 'auth-success'
      }));
    } else {
      // Authentication failed - increment attempts
      const newAttempts = attempts + 1;
      const newNonce = crypto.randomUUID();

      // Increment global room-level failure counter
      failures.count += 1;
      failures.windowStart = now;
      await this.state.storage.put('authFailures', failures);

      // Increment per-bucket failure counter
      if (currentAttachment?.clientBucket) {
        await this.incrementBucketAuthFailures(currentAttachment.clientBucket);
      }

      ws.serializeAttachment({
        ...currentAttachment,
        authChallenge: newNonce,
        authAttempts: newAttempts
      });

      ws.send(JSON.stringify({
        type: 'error',
        error: 'PASSWORD_INCORRECT',
        message: '密码错误',
        data: { nonce: newNonce } // Send new nonce for retry
      }));
      
      // If max attempts reached, close
      if (newAttempts >= Room.MAX_PASSWORD_ATTEMPTS) {
        ws.close(4002, 'RATE_LIMIT_EXCEEDED');
      }
    }
  }

  /**
   * WebSocket close handler (Hibernation API)
   */
  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    this.messageRateLimits.delete(ws);
    this.relayByteBudget.delete(ws);
    this.relayDropWarn.delete(ws);

    // Prune the cache entry for this connection
    if (this.peerWsCache) {
      const attachment = ws.deserializeAttachment() as PeerAttachment | null;
      if (attachment?.id && this.peerWsCache.get(attachment.id) === ws) {
        this.peerWsCache.delete(attachment.id);
      }
    }

    await this.handleLeave(ws);
  }

  /**
   * WebSocket error handler (Hibernation API)
   * Note: a close event always follows an error - peer-left is handled once
   * in webSocketClose to avoid duplicate broadcasts.
   */
  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.messageRateLimits.delete(ws);
    this.relayByteBudget.delete(ws);
    this.relayDropWarn.delete(ws);
  }

  /**
   * Sanitize string input (truncate to max length)
   */
  private sanitizeString(str: string, maxLength: number): string {
    if (!str) return '';
    return str.substring(0, maxLength);
  }

  /**
   * Handle peer joining the room
   */
  private async handleJoin(ws: WebSocket, msg: SignalingMessage): Promise<void> {
    const joinData = msg.data as { name: string; deviceType: 'desktop' | 'mobile' | 'tablet'; browserInfo?: string; deviceKey?: string };

    // 重复 join：记录旧 ID（缓存清理 + 通知其他设备旧 ID 离开）
    const oldAttachment = ws.deserializeAttachment() as PeerAttachment | null;
    const oldId = oldAttachment?.id || null;

    const peerId = crypto.randomUUID();

    // Sanitize name
    const sanitizedName = this.sanitizeString(joinData.name || this.generateName(), Room.MAX_NAME_LENGTH);

    // Get room code from WebSocket tag
    const tags = this.state.getTags(ws);
    const roomCode = tags.length > 0 ? tags[0] : '';

    // Create peer attachment data
    const attachment: PeerAttachment = {
      id: peerId,
      name: sanitizedName,
      deviceType: joinData.deviceType || 'desktop',
      browserInfo: this.sanitizeString(joinData.browserInfo || '', 100), // Limit browser info length
      deviceKey: this.sanitizeString(joinData.deviceKey || '', 500), // 设备身份公钥（SPKI base64）
      isAuthenticated: true, // If they reached here, they are authenticated (or no password required)
      joinedAt: Date.now(),
    };

    // 先更新附件，再同步缓存（休眠唤醒后缓存为 null 时从最新附件重建，
    // 旧 peerId 自然不在缓存中，不会留下脏条目）
    ws.serializeAttachment(attachment);
    if (!this.peerWsCache) {
      this.rebuildPeerCache();
    } else {
      if (oldId) this.peerWsCache.delete(oldId);
      this.peerWsCache.set(peerId, ws);
    }

    // 重复 join：通知其他设备旧 ID 已离开
    if (oldId) {
      this.broadcast({ type: 'peer-left', data: { id: oldId } });
    }

    // Setup auto-response for ping/pong
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));

    // Get all other active peers from their WebSocket attachments
    const activePeers = this.getActivePeers();

    const otherPeers = Array.from(activePeers.entries())
      .filter(([id]) => id !== peerId)
      .map(([id, { attachment: p }]) => ({ id, name: p.name, deviceType: p.deviceType, browserInfo: p.browserInfo, deviceKey: p.deviceKey }));

    // Send peer their ID, room code, and list of other peers
    ws.send(JSON.stringify({
      type: 'joined',
      peerId,
      roomCode,
      peers: otherPeers,
    }));

    // Notify other peers about new peer
    this.broadcast({
      type: 'peer-joined',
      data: { id: peerId, name: attachment.name, deviceType: attachment.deviceType, browserInfo: attachment.browserInfo, deviceKey: attachment.deviceKey },
    }, peerId);
  }

  /**
   * Handle peer leaving the room
   */
  private async handleLeave(ws: WebSocket): Promise<void> {
    const peerId = this.getPeerIdFromWs(ws);
    
    if (peerId) {
      // Notify other peers
      this.broadcast({
        type: 'peer-left',
        data: { id: peerId },
      });
    }

    // Check if room is empty now
    // We need to wait a tick because getWebSockets() might still include the closing one?
    // Actually handleLeave is called from webSocketClose/Error, so it should be fine or we check explicitly
    const activePeers = this.getActivePeers();
    // Note: The current WS is already in 'CLOSING' or 'CLOSED' state or about to be,
    // but getActivePeers filters for OPEN. 
    // However, to be safe, we check if count is 0.
    
    if (activePeers.size === 0 && this.passwordHash) {
       // Room became empty, schedule destruction
       await this.state.storage.setAlarm(Date.now() + Room.SECURE_ROOM_TTL);
    } else {
       // Room is not empty, check if we have any authenticated users
       // If only unauthenticated users remain, we might want to schedule alarm anyway?
       // For simplicity, we rely on handleAuth clearing alarm.
       // But if everyone leaves except one unauthenticated user, handleLeave logic above keeps alarm cleared?
       // Wait, handleLeave checks activePeers.size. If activePeers > 0, we don't set alarm.
       // This is fine. If users are stuck in unauthenticated state, they can't do anything.
       // But we should probably check if *only* unauthenticated users remain.
       
       let hasAuthenticated = false;
       for (const { attachment } of activePeers.values()) {
         if (attachment.isAuthenticated) {
           hasAuthenticated = true;
           break;
         }
       }
       
       if (!hasAuthenticated && this.passwordHash) {
          // No authenticated users left, start countdown
          await this.state.storage.setAlarm(Date.now() + Room.SECURE_ROOM_TTL);
       }
    }
  }

  /**
   * Rebuild the peerId -> WebSocket cache from hibernation state
   */
  private rebuildPeerCache(): void {
    this.peerWsCache = new Map();
    for (const ws of this.state.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as PeerAttachment | null;
      if (attachment?.id) {
        this.peerWsCache.set(attachment.id, ws);
      }
    }
  }

  /**
   * Get the WebSocket for a peer ID using the cache (lazy rebuild on wake)
   */
  private getPeerWs(peerId: string): WebSocket | undefined {
    if (!this.peerWsCache) this.rebuildPeerCache();
    return this.peerWsCache?.get(peerId);
  }

  /**
   * Handle WebRTC signaling messages (offer/answer/ice-candidate)
   */
  private async handleSignaling(ws: WebSocket, msg: SignalingMessage): Promise<void> {
    if (!msg.to) return;

    const fromPeerId = this.getPeerIdFromWs(ws);
    if (!fromPeerId) return;

    const targetWs = this.getPeerWs(msg.to);
    if (!targetWs) return;

    try {
      targetWs.send(JSON.stringify({
        type: msg.type,
        from: fromPeerId,
        data: msg.data,
      }));
    } catch (e) {
      console.error(`[Room] Failed to send signaling to ${msg.to}:`, e);
    }
  }

  /**
   * Handle relay data messages (fallback when P2P fails)
   * Forwards binary data chunks between peers via WebSocket
   */
  private async handleRelayData(ws: WebSocket, msg: SignalingMessage): Promise<void> {
    if (!msg.to) return;

    const fromPeerId = this.getPeerIdFromWs(ws);
    if (!fromPeerId) return;

    this.sendToPeer(msg.to, {
      type: 'relay-data',
      from: fromPeerId,
      data: msg.data,
    });
  }

  /**
   * Handle key exchange messages (for relay mode encryption)
   */
  private async handleKeyExchange(ws: WebSocket, msg: SignalingMessage): Promise<void> {
    if (!msg.to) return;

    const fromPeerId = this.getPeerIdFromWs(ws);
    if (!fromPeerId) return;

    this.sendToPeer(msg.to, {
      type: 'key-exchange',
      from: fromPeerId,
      data: msg.data,
    });
  }

  /**
   * Handle file request/response signaling messages
   * Used for file transfer confirmation flow
   */
  private async handleFileSignaling(ws: WebSocket, msg: SignalingMessage): Promise<void> {
    if (!msg.to) return;

    const fromPeerId = this.getPeerIdFromWs(ws);
    if (!fromPeerId) return;

    this.sendToPeer(msg.to, {
      type: msg.type, // 'file-request' or 'file-response' or 'file-cancel'
      from: fromPeerId,
      data: msg.data,
    });
  }

  /**
   * Send message to a specific peer by ID (uses the peerId -> ws cache)
   */
  private sendToPeer(targetPeerId: string, message: object): boolean {
    const targetWs = this.getPeerWs(targetPeerId);
    if (!targetWs) return false;

    try {
      targetWs.send(JSON.stringify(message));
      return true;
    } catch (e) {
      console.error(`[Room] Failed to send to ${targetPeerId}:`, e);
      return false;
    }
  }

  /**
   * Broadcast message to all peers except excluded one (uses the cache)
   */
  private broadcast(msg: SignalingMessage, excludePeerId?: string): void {
    const message = JSON.stringify(msg);
    if (!this.peerWsCache) this.rebuildPeerCache();

    for (const [peerId, targetWs] of this.peerWsCache!.entries()) {
      if (peerId === excludePeerId) continue;

      try {
        // Try to send regardless of readyState - let the send fail if connection is bad
        targetWs.send(message);
      } catch (e) {
        // Silently ignore send failures - peer may have disconnected
      }
    }
  }

  /**
   * Generate a random device name
   */
  private generateName(): string {
    const adjectives = ['Swift', 'Bright', 'Cool', 'Fast', 'Sleek', 'Sharp', 'Bold', 'Calm'];
    const nouns = ['Phoenix', 'Dragon', 'Falcon', 'Tiger', 'Eagle', 'Panda', 'Wolf', 'Lion'];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    return `${adj} ${noun}`;
  }

  /**
   * Handle peer name change
   */
  private async handleNameChanged(ws: WebSocket, msg: SignalingMessage): Promise<void> {
    const senderId = (ws.deserializeAttachment() as PeerAttachment | null)?.id;
    if (!senderId) return;

    const nameData = msg.data as { name: string };
    const sanitizedName = this.sanitizeString(nameData.name, Room.MAX_NAME_LENGTH);
    
    // Update peer attachment with new name
    const attachment = ws.deserializeAttachment() as PeerAttachment | null;
    if (attachment) {
      attachment.name = sanitizedName;
      ws.serializeAttachment(attachment);
    }

    // Broadcast name change to all other peers
    this.broadcast({
      type: 'name-changed',
      from: senderId,
      data: { name: sanitizedName }
    }, senderId);
  }
}
