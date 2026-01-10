# CloudDrop

<p align="center">
  <img src="public/favicon.svg" alt="CloudDrop Logo" width="80" height="80">
</p>

<p align="center">
  <strong>A modern, secure peer-to-peer file sharing tool built on Cloudflare Workers.</strong>
</p>

<p align="center">
  <a href="./README.zh-CN.md">🇨🇳 中文文档</a> •
  <a href="#features">Features</a> •
  <a href="#deploy">Deploy</a> •
  <a href="#development">Development</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white" alt="Cloudflare Workers">
  <img src="https://img.shields.io/badge/WebRTC-P2P-333333?logo=webrtc&logoColor=white" alt="WebRTC">
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License">
</p>

---

## ✨ Features

### Core Features
- 🚀 **Instant Sharing** - Share files with anyone on the same network instantly
- 🔒 **End-to-End Encryption** - All transfers encrypted using AES-256-GCM
- 🌐 **P2P Transfer** - Direct peer-to-peer transfer via WebRTC, no server storage
- ☁️ **Cloudflare Powered** - Built on Cloudflare Workers for global edge deployment
- 📱 **Progressive Web App** - Install as a native app on any device
- 🔗 **Room Sharing** - Share a room code to connect with anyone, anywhere
- 💬 **Secure Messaging** - Send encrypted text messages between devices
- 🎨 **Beautiful UI** - Modern dark theme with glassmorphism and smooth animations

### Advanced Features
- 🔐 **Encrypted Rooms** - Create password-protected rooms with double encryption
- 🔄 **Smart Relay Fallback** - Auto fallback to relay mode when P2P fails (≤5s detection)
- 🔁 **Background P2P Recovery** - Silently attempts to restore P2P after relay fallback
- ✅ **Device Trust** - Trust devices to auto-accept file transfers
- ⏹️ **Transfer Control** - Cancel ongoing transfers at any time
- 📊 **Connection Indicator** - Visual indicator showing P2P or relay mode
- 📲 **Mobile Optimized** - Touch-friendly UI with bottom navigation bar

## 🖼️ Screenshots

<table>
  <tr>
    <td align="center">
      <img src="docs/screenshots/desktop-main.png" width="400" alt="Desktop Main Interface">
      <br><em>Desktop - Peer Discovery</em>
    </td>
    <td align="center">
      <img src="docs/screenshots/desktop-transfer.png" width="400" alt="File Transfer">
      <br><em>Desktop - File Transfer</em>
    </td>
  </tr>
  <tr>
    <td align="center">
      <img src="docs/screenshots/mobile-main.png" width="200" alt="Mobile Interface">
      <br><em>Mobile - Main Interface</em>
    </td>
    <td align="center">
      <img src="docs/screenshots/mobile-share.png" width="200" alt="Mobile Share">
      <br><em>Mobile - Room Sharing</em>
    </td>
  </tr>
</table>

## 🚀 One-Click Deploy

Deploy your own CloudDrop instance to Cloudflare Workers:

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/DeH40/cloudDrop)

## 🛠️ Development

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Cloudflare Account](https://dash.cloudflare.com/sign-up) (free tier works)

### Local Development

```bash
# Clone the repository
git clone https://github.com/DeH40/cloudDrop.git
cd cloudDrop

# Install dependencies
npm install

# Start development server
npm run dev
```

The development server will start at `http://localhost:8787`.

### Deploy to Production

```bash
# Login to Cloudflare (first time only)
npx wrangler login

# Deploy
npm run deploy
```

## ⚙️ Configuration

### Optional: TURN Server (for NAT traversal)

For better connectivity across restrictive networks, you can configure Cloudflare's TURN service:

1. Get your TURN credentials from [Cloudflare Dashboard](https://dash.cloudflare.com/?to=/:account/calls)
2. Add secrets to your worker:

```bash
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_API_TOKEN
```

Without TURN configuration, CloudDrop will use public STUN servers for WebRTC connection.

## 📁 Project Structure

```
cloudDrop/
├── public/              # Static assets
│   ├── index.html       # Main HTML file
│   ├── style.css        # Styles (dark theme + glassmorphism)
│   ├── manifest.json    # PWA manifest
│   └── js/
│       ├── app.js       # Main application logic
│       ├── config.js    # Unified configuration constants
│       ├── ui.js        # UI components & helpers
│       ├── webrtc.js    # WebRTC + relay fallback + P2P recovery
│       └── crypto.js    # Encryption (AES-GCM + room password)
├── src/
│   ├── index.ts         # Worker entry point
│   └── room.ts          # Durable Object for WebSocket rooms
├── wrangler.toml        # Cloudflare Workers configuration
└── package.json
```

## 🔧 Tech Stack

- **Runtime**: Cloudflare Workers + Durable Objects
- **Real-time**: WebSocket for signaling
- **Transfer**: WebRTC Data Channels (P2P) + WebSocket relay (fallback)
- **Encryption**: Web Crypto API (AES-256-GCM, ECDH key exchange)
- **Frontend**: Vanilla JavaScript + Modern CSS

## 🔒 Security

CloudDrop implements multiple layers of security:

1. **Transport Encryption** - All WebRTC connections use DTLS
2. **Application Encryption** - AES-256-GCM with per-session keys
3. **Key Exchange** - ECDH (P-256) for secure key negotiation
4. **Room Passwords** - Optional password protection with PBKDF2 derivation
5. **Zero Knowledge** - Server never sees file contents or encryption keys

## 📄 License

[MIT](./LICENSE) © DeH40

---

<p align="center">
  Made with ❤️ for seamless file sharing
</p>
