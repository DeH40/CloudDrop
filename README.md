# CloudDrop

<p align="center">
  <img src="public/favicon.svg" alt="CloudDrop Logo" width="80" height="80">
</p>

<p align="center">
  A modern, secure peer-to-peer file sharing tool built on Cloudflare Workers.
</p>

<p align="center">
  <a href="./README.zh-CN.md">🇨🇳 中文文档</a> •
  <a href="#features">Features</a> •
  <a href="#deploy">Deploy</a> •
  <a href="#development">Development</a>
</p>

---

## ✨ Features

- 🚀 **Instant Sharing** - Share files with anyone on the same network instantly
- 🔒 **End-to-End Encryption** - All transfers are encrypted using WebCrypto API
- 🌐 **P2P Transfer** - Direct peer-to-peer transfer via WebRTC, no server storage
- ☁️ **Cloudflare Powered** - Built on Cloudflare Workers for global edge deployment
- 📱 **Progressive Web App** - Install as a native app on any device
- 🔗 **Room Sharing** - Share a room code to connect with anyone, anywhere
- 💬 **Secure Messaging** - Send encrypted text messages between devices
- 🎨 **Beautiful UI** - Modern dark theme with smooth animations

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
│   ├── style.css        # Styles
│   ├── manifest.json    # PWA manifest
│   └── js/
│       ├── app.js       # Main application logic
│       ├── ui.js        # UI components
│       ├── webrtc.js    # WebRTC connection handling
│       └── crypto.js    # Encryption utilities
├── src/
│   ├── index.ts         # Worker entry point
│   └── room.ts          # Durable Object for WebSocket rooms
├── wrangler.toml        # Cloudflare Workers configuration
└── package.json
```

## 🔧 Tech Stack

- **Runtime**: Cloudflare Workers
- **Real-time**: WebSocket + Durable Objects
- **Transfer**: WebRTC Data Channels
- **Encryption**: Web Crypto API (AES-GCM)
- **Frontend**: Vanilla JavaScript + CSS

## 📄 License

[MIT](./LICENSE) © DeH40

---

<p align="center">
  Made with ❤️ for seamless file sharing
</p>
