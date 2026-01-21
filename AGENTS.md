# Agent Guide for CloudDrop

This repository contains the CloudDrop backend, a modern P2P file-sharing tool built on Cloudflare Workers and Durable Objects.
This guide provides context, commands, coding standards, and architectural patterns for AI agents operating in this codebase.

## Project Overview

- **Framework**: Cloudflare Workers
- **Language**: TypeScript
- **Core Component**: Durable Objects (`Room` class in `src/room.ts`)
- **Key Feature**: WebSocket Hibernation API for cost-effective connection management
- **Deployment**: Wrangler
- **State**: Ephemeral signaling state + optional persistent room passwords

## Development Commands

### Build & Run

*   **Install Dependencies**
    ```bash
    npm install
    ```

*   **Start Local Development Server**
    ```bash
    npm run dev
    ```
    *Runs `wrangler dev`. This starts a local server (usually port 8787) emulating the Cloudflare Workers environment.*

*   **Deploy to Cloudflare**
    ```bash
    npm run deploy
    ```
    *Runs `wrangler deploy`. Requires `wrangler login` authentication.*

### Testing & Linting

*   **Run Tests**
    ```bash
    npm test
    ```
    *Current Status: No test suite is configured ("echo 'No tests yet'").*
    *Recommended: When adding tests, use `vitest` with `@cloudflare/vitest-pool-workers`.*

*   **Type Check**
    ```bash
    npx tsc --noEmit
    ```
    *Validates TypeScript types across the project without emitting output files.*

## Code Style & Guidelines

### TypeScript Configuration
- **Strict Mode**: `strict: true` is enabled in `tsconfig.json`. No implicit `any`.
- **Target**: `ES2022`.
- **Module Resolution**: `bundler`.
- **Types**:
    - Use `interface` for object shapes (e.g., `SignalingMessage`, `PeerAttachment`).
    - Explicitly type function arguments and return values (e.g., `: Promise<Response>`).
    - Use the `Env` interface for worker environment bindings (Durable Objects, Vars).

### Naming Conventions
- **Files**: kebab-case (e.g., `index.ts`, `room.ts`).
- **Classes**: PascalCase (e.g., `Room`).
- **Interfaces**: PascalCase (e.g., `PeerAttachment`, `Env`).
- **Functions & Variables**: camelCase (e.g., `handleWebSocket`, `roomCode`).
- **Constants**: UPPER_SNAKE_CASE (e.g., `WS_READY_STATE`).
- **Private Properties**: No underscore prefix required, just use the `private` keyword.

### Formatting
- **Indentation**: 2 spaces.
- **Semicolons**: Always use semicolons.
- **Strings**: Single quotes preferred, except for template literals.
- **Braces**: K&R style (opening brace on the same line).

### Error Handling
- **HTTP**: Return explicit `Response` objects with appropriate status codes.
    - `400 Bad Request`: Invalid input/parameters.
    - `404 Not Found`: Unknown route or resource.
    - `500 Internal Error`: Unexpected failures.
- **WebSockets**:
    - Wrap message handling in `try-catch` blocks to prevent Durable Object crashes.
    - Send typed error messages to the client: `{ type: 'error', error: 'CODE', message: '...' }`.
    - Log errors to the console (`console.error`), which streams to Cloudflare logs.

## Architecture & Patterns

### 1. Project Structure
- `src/index.ts`: **The Router**.
    - Handles incoming HTTP requests.
    - Generates Room IDs based on Client IP hashing (SHA-256).
    - Routes `/ws` requests to the specific `Room` Durable Object stub.
    - Handles static API endpoints (e.g., `/api/room-id`, `/api/ice-servers`).
- `src/room.ts`: **The State Machine**.
    - Implements the `DurableObject` interface.
    - Manages the WebSocket lifecycle.
    - Handles signaling logic (join, offer, answer, ice-candidate).

### 2. Durable Objects & WebSocket Hibernation
This project uses the **WebSocket Hibernation API** for high performance and lower costs. Agents must follow these specific patterns:

*   **State Management**:
    *   **Do Not** store active WebSocket objects in a class property array.
    *   Use `this.state.getWebSockets()` to iterate over active connections.
    *   Use `ws.serializeAttachment(...)` and `ws.deserializeAttachment()` to store metadata (Peer ID, Name) directly on the socket. This data survives hibernation.

*   **Initialization**:
    *   Use `this.state.blockConcurrencyWhile(async () => { ... })` in the constructor to load storage data (like passwords) before handling requests.

*   **Message Handling**:
    *   Implement `webSocketMessage(ws, message)`.
    *   Implement `webSocketClose(ws, ...)` and `webSocketError(ws, ...)` to handle disconnections and cleanup.

### 3. Signaling Protocol
The signaling logic handles WebRTC coordination. New message types should be added to:
1.  The `SignalingMessage` interface (`src/room.ts`).
2.  The `switch (msg.type)` block in `webSocketMessage`.
3.  A dedicated handler method (e.g., `private async handleNewFeature(...)`).

### 4. IP-Based Room Generation
Room IDs are deterministic based on the client's network to facilitate P2P discovery without login:
- **IPv4**: First 3 octets (/24 subnet).
- **IPv6**: First 64 bits (/64 prefix).
- **Logic**: Located in `generateRoomId` in `src/index.ts`.
- **Privacy**: The network part is hashed (SHA-256) before use; actual IPs are not exposed in the room ID.

## Security Rules

1.  **Room Passwords**:
    - Stored in DO storage as `passwordHash`.
    - Verified immediately upon WebSocket connection setup.
    - If verification fails, send an error frame and close with code `4001` or `4002`.

2.  **Input Validation**:
    - Validate all JSON bodies using strict type checks.
    - Ensure `roomCode` matches the expected format (6 alphanumeric chars) before processing.

3.  **CORS & Headers**:
    - API endpoints typically return JSON with `Content-Type: application/json`.
    - Ensure proper CORS headers are present if the frontend is hosted on a different domain (though currently served from same origin).
