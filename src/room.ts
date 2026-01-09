/**
 * CloudDrop - Durable Object for room management
 * Manages WebSocket connections and signaling for P2P file sharing
 */

export interface Env {
  ROOM: DurableObjectNamespace;
}

interface Peer {
  id: string;
  name: string;
  deviceType: 'desktop' | 'mobile' | 'tablet';
  browserInfo?: string;
  webSocket: WebSocket;
}

interface SignalingMessage {
  type: 'join' | 'leave' | 'offer' | 'answer' | 'ice-candidate' | 'peers' | 'text' | 'peer-joined' | 'peer-left' | 'relay-data' | 'name-changed';
  from?: string;
  to?: string;
  data?: unknown;
}

/**
 * Peer attachment data stored with WebSocket (survives hibernation)
 */
interface PeerAttachment {
  id: string;
  name: string;
  deviceType: 'desktop' | 'mobile' | 'tablet';
  browserInfo?: string;
  publicKey?: string;
}

/**
 * Room Durable Object - handles WebSocket connections for a room (based on IP)
 * Uses WebSocket Hibernation API for cost efficiency
 * Peer data is stored in WebSocket attachments to survive hibernation
 */
export class Room {
  private state: DurableObjectState;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname === '/ws') {
      return this.handleWebSocket(request);
    }

    return new Response('Not Found', { status: 404 });
  }

  private handleWebSocket(request: Request): Response {
    // Check for WebSocket upgrade
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    // Create WebSocket pair
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Accept the WebSocket with hibernation API
    this.state.acceptWebSocket(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  /**
   * Get all active peers from WebSocket attachments (survives hibernation)
   */
  private getActivePeers(): Map<string, { ws: WebSocket; attachment: PeerAttachment }> {
    const peers = new Map<string, { ws: WebSocket; attachment: PeerAttachment }>();
    const webSockets = this.state.getWebSockets();
    
    for (const ws of webSockets) {
      const attachment = ws.deserializeAttachment() as PeerAttachment | null;
      if (attachment && attachment.id) {
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
      const msg: SignalingMessage = JSON.parse(data);

      switch (msg.type) {
        case 'join':
          await this.handleJoin(ws, msg);
          break;
        case 'offer':
        case 'answer':
        case 'ice-candidate':
          await this.handleSignaling(ws, msg);
          break;
        case 'text':
          await this.handleText(ws, msg);
          break;
        case 'relay-data':
          await this.handleRelayData(ws, msg);
          break;
        case 'name-changed':
          await this.handleNameChanged(ws, msg);
          break;
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  }

  /**
   * WebSocket close handler (Hibernation API)
   */
  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    await this.handleLeave(ws);
  }

  /**
   * WebSocket error handler (Hibernation API)
   */
  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.handleLeave(ws);
  }

  /**
   * Handle peer joining the room
   */
  private async handleJoin(ws: WebSocket, msg: SignalingMessage): Promise<void> {
    const joinData = msg.data as { name: string; deviceType: 'desktop' | 'mobile' | 'tablet'; browserInfo?: string };
    const peerId = crypto.randomUUID();

    // Create peer attachment data
    const attachment: PeerAttachment = {
      id: peerId,
      name: joinData.name || this.generateName(),
      deviceType: joinData.deviceType || 'desktop',
      browserInfo: joinData.browserInfo,
    };

    // Store peer info in WebSocket attachment (survives hibernation)
    ws.serializeAttachment(attachment);

    // Setup auto-response for ping/pong
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));

    // Get all other active peers from their WebSocket attachments
    const activePeers = this.getActivePeers();
    const otherPeers = Array.from(activePeers.entries())
      .filter(([id]) => id !== peerId)
      .map(([id, { attachment: p }]) => ({ id, name: p.name, deviceType: p.deviceType, browserInfo: p.browserInfo }));

    // Send peer their ID and list of other peers
    ws.send(JSON.stringify({
      type: 'joined',
      peerId,
      peers: otherPeers,
    }));

    // Notify other peers about new peer
    this.broadcast({
      type: 'peer-joined',
      data: { id: peerId, name: attachment.name, deviceType: attachment.deviceType, browserInfo: attachment.browserInfo },
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
  }

  /**
   * Handle WebRTC signaling messages (offer/answer/ice-candidate)
   */
  private async handleSignaling(ws: WebSocket, msg: SignalingMessage): Promise<void> {
    if (!msg.to) return;

    const fromPeerId = this.getPeerIdFromWs(ws);
    if (!fromPeerId) return;

    // Find target peer from active connections
    const activePeers = this.getActivePeers();
    const targetPeer = activePeers.get(msg.to);
    
    if (targetPeer && targetPeer.ws.readyState === WebSocket.OPEN) {
      targetPeer.ws.send(JSON.stringify({
        type: msg.type,
        from: fromPeerId,
        data: msg.data,
      }));
    }
  }

  /**
   * Handle text messages between peers
   */
  private async handleText(ws: WebSocket, msg: SignalingMessage): Promise<void> {
    if (!msg.to) return;

    const fromPeerId = this.getPeerIdFromWs(ws);
    if (!fromPeerId) return;

    const activePeers = this.getActivePeers();
    const targetPeer = activePeers.get(msg.to);
    
    if (targetPeer && targetPeer.ws.readyState === WebSocket.OPEN) {
      targetPeer.ws.send(JSON.stringify({
        type: 'text',
        from: fromPeerId,
        data: msg.data,
      }));
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

    const activePeers = this.getActivePeers();
    const targetPeer = activePeers.get(msg.to);
    
    if (targetPeer && targetPeer.ws.readyState === WebSocket.OPEN) {
      targetPeer.ws.send(JSON.stringify({
        type: 'relay-data',
        from: fromPeerId,
        data: msg.data,
      }));
    }
  }

  /**
   * Broadcast message to all peers except excluded one
   */
  private broadcast(msg: SignalingMessage, excludePeerId?: string): void {
    const message = JSON.stringify(msg);
    const activePeers = this.getActivePeers();
    
    for (const [peerId, { ws }] of activePeers.entries()) {
      if (peerId !== excludePeerId && ws.readyState === WebSocket.OPEN) {
        ws.send(message);
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
    
    // Update peer attachment with new name
    const attachment = ws.deserializeAttachment() as PeerAttachment | null;
    if (attachment) {
      attachment.name = nameData.name;
      ws.serializeAttachment(attachment);
    }

    // Broadcast name change to all other peers
    this.broadcast({
      type: 'name-changed',
      from: senderId,
      data: { name: nameData.name }
    }, senderId);
  }
}
