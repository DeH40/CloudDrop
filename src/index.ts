/**
 * CloudDrop - Cloudflare Worker Entry Point
 * Routes requests to static assets or WebSocket signaling
 */

import { Room } from './room';

export { Room };

export interface Env {
  ROOM: DurableObjectNamespace;
  // Cloudflare TURN credentials (set in wrangler.toml or dashboard)
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Handle WebSocket upgrade requests
    if (url.pathname === '/ws') {
      return handleWebSocket(request, env);
    }

    // Handle API endpoints
    if (url.pathname === '/api/room-id') {
      return handleRoomId(request);
    }

    // Handle room password APIs
    if (url.pathname === '/api/room/set-password') {
      return handleSetRoomPassword(request, env);
    }

    if (url.pathname === '/api/room/check-password') {
      return handleCheckRoomPassword(request, env);
    }

    // Handle ICE servers request (for TURN credentials)
    if (url.pathname === '/api/ice-servers') {
      return handleIceServers(env);
    }

    // Static assets are handled automatically by Cloudflare
    // This is just a fallback for any unhandled routes
    return new Response('Not Found', { status: 404 });
  },
};

/**
 * Handle WebSocket connections by routing to the appropriate room
 * Room is determined by: 1) explicit room param, or 2) client IP address
 */
async function handleWebSocket(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // Check for explicit room parameter first
  const explicitRoom = url.searchParams.get('room');

  let roomId: string;
  let roomCode: string; // User-friendly room code to display

  if (explicitRoom && /^[a-zA-Z0-9]{4,16}$/.test(explicitRoom)) {
    // Explicit room code from URL parameter
    roomCode = explicitRoom.toUpperCase();
  } else {
    // Auto-assign room based on client IP
    const clientIP = request.headers.get('CF-Connecting-IP') ||
                     request.headers.get('X-Forwarded-For')?.split(',')[0] ||
                     'default';
    const ipHash = await generateRoomId(clientIP);
    roomCode = ipHash.substring(0, 6).toUpperCase();
  }

  // Unified: roomId is always derived from roomCode
  roomId = `room-${roomCode.toLowerCase()}`;

  // Get or create the room Durable Object
  const roomObjectId = env.ROOM.idFromName(roomId);
  const roomStub = env.ROOM.get(roomObjectId);

  // Forward the WebSocket request to the room with room info
  const wsUrl = new URL(request.url);
  wsUrl.pathname = '/ws';
  // Pass room code via header so Room can include it in join response
  const headers = new Headers(request.headers);
  headers.set('X-Room-Code', roomCode);

  // Pass password hash if provided (from URL query parameter)
  const passwordHash = url.searchParams.get('passwordHash');
  if (passwordHash) {
    headers.set('X-Room-Password-Hash', passwordHash);
  }

  return roomStub.fetch(new Request(wsUrl.toString(), {
    headers,
    method: request.method,
  }));
}

/**
 * Return ICE servers configuration with TURN credentials
 */
async function handleIceServers(env: Env): Promise<Response> {
  // Default STUN-only configuration (fallback if TURN not configured)
  // Prioritize China-accessible servers, with global fallbacks
  const defaultIceServers = [
    // China-accessible STUN servers (prioritized)
    { urls: 'stun:stun.miwifi.com:3478' },      // Xiaomi - China
    { urls: 'stun:stun.yy.com:3478' },          // YY - China
    // Global STUN servers
    { urls: 'stun:stun.cloudflare.com:3478' },  // Cloudflare
    { urls: 'stun:stun.syncthing.net:3478' },   // Syncthing
    { urls: 'stun:stun.nextcloud.com:3478' },   // Nextcloud
  ];

  // If TURN credentials are configured, fetch dynamic credentials
  if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
    try {
      const response = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.TURN_KEY_API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ttl: 86400 }), // 24 hours
        }
      );

      if (response.ok) {
        const data = await response.json() as { iceServers: unknown[] };
        // Filter out port 53 URLs (blocked by browsers)
        const filteredServers = data.iceServers.map((server: unknown) => {
          const s = server as { urls?: string | string[] };
          if (Array.isArray(s.urls)) {
            return { ...s, urls: s.urls.filter((url: string) => !url.includes(':53')) };
          }
          return s;
        });
        return new Response(JSON.stringify({ iceServers: filteredServers }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
    } catch (error) {
      console.error('Failed to fetch TURN credentials:', error);
    }
  }

  // Return default STUN-only config
  return new Response(JSON.stringify({ iceServers: defaultIceServers }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Return the room ID for the current client
 */
async function handleRoomId(request: Request): Promise<Response> {
  const clientIP = request.headers.get('CF-Connecting-IP') || 
                   request.headers.get('X-Forwarded-For')?.split(',')[0] || 
                   'default';

  const roomId = await generateRoomId(clientIP);

  return new Response(JSON.stringify({ roomId }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Generate a room ID from an IP address
 * IPv4: uses first 3 octets (/24 network)
 * IPv6: uses first 4 groups (/64 network prefix)
 * Local: uses 'localhost' as seed for consistent local room
 */
async function generateRoomId(ip: string): Promise<string> {
  let networkPart: string;

  // For local development, use 'localhost' as seed
  // This generates a valid shareable room code instead of 'local-dev-room'
  if (ip === 'default' || ip === '127.0.0.1' || ip === '::1') {
    networkPart = 'localhost';
  } else if (ip.includes('.') && !ip.includes(':')) {
    // IPv4: use first 3 octets for /24 network
    const parts = ip.split('.');
    if (parts.length === 4) {
      networkPart = parts.slice(0, 3).join('.');
    } else {
      networkPart = ip;
    }
  } else {
    // IPv6 - extract network prefix (first 64 bits = first 4 groups)
    const expanded = expandIPv6(ip);
    const groups = expanded.split(':');
    networkPart = groups.slice(0, 4).join(':');
  }

  // Hash the network portion to generate room ID
  const encoder = new TextEncoder();
  const data = encoder.encode(networkPart);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hash));
  return hashArray.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Expand abbreviated IPv6 address to full form
 */
function expandIPv6(ip: string): string {
  // Remove IPv4-mapped suffix if present
  if (ip.includes('.')) {
    const lastColon = ip.lastIndexOf(':');
    ip = ip.substring(0, lastColon);
  }

  // Handle :: abbreviation
  if (ip.includes('::')) {
    const parts = ip.split('::');
    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts[1] ? parts[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    const middle = Array(missing).fill('0000');
    const full = [...left, ...middle, ...right];
    return full.map(g => g.padStart(4, '0')).join(':');
  }

  // Already full, just pad each group
  return ip.split(':').map(g => g.padStart(4, '0')).join(':');
}

/**
 * Handle room password setting
 * Forwards request to the appropriate Room Durable Object
 */
async function handleSetRoomPassword(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const roomParam = url.searchParams.get('room');

  if (!roomParam || !/^[a-zA-Z0-9]{4,16}$/.test(roomParam)) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Invalid room code format'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const roomId = `room-${roomParam.toLowerCase()}`;
  const roomObjectId = env.ROOM.idFromName(roomId);
  const roomStub = env.ROOM.get(roomObjectId);

  // Forward request to Room Durable Object
  const roomUrl = new URL(request.url);
  roomUrl.pathname = '/set-password';

  return roomStub.fetch(new Request(roomUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.body,
  }));
}

/**
 * Handle room password check
 * Forwards request to the appropriate Room Durable Object
 */
async function handleCheckRoomPassword(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const roomParam = url.searchParams.get('room');

  if (!roomParam || !/^[a-zA-Z0-9]{4,16}$/.test(roomParam)) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Invalid room code format'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const roomId = `room-${roomParam.toLowerCase()}`;
  const roomObjectId = env.ROOM.idFromName(roomId);
  const roomStub = env.ROOM.get(roomObjectId);

  // Forward request to Room Durable Object
  const roomUrl = new URL(request.url);
  roomUrl.pathname = '/check-password';

  return roomStub.fetch(new Request(roomUrl.toString(), {
    method: 'GET',
    headers: request.headers,
  }));
}
