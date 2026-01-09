# CloudDrop

<p align="center">
  <img src="public/favicon.svg" alt="CloudDrop Logo" width="80" height="80">
</p>

<p align="center">
  现代化、安全的点对点文件共享工具，基于 Cloudflare Workers 构建。
</p>

<p align="center">
  <a href="./README.md">🇺🇸 English</a> •
  <a href="#特性">特性</a> •
  <a href="#部署">部署</a> •
  <a href="#开发">开发</a>
</p>

---

## ✨ 特性

- 🚀 **即时分享** - 同一网络内的设备即时发现，快速传输
- 🔒 **端到端加密** - 使用 WebCrypto API 进行所有传输加密
- 🌐 **点对点传输** - 通过 WebRTC 直接传输，无服务器存储
- ☁️ **Cloudflare 驱动** - 基于 Cloudflare Workers 全球边缘部署
- 📱 **渐进式 Web 应用** - 可安装为原生应用
- 🔗 **房间分享** - 通过房间号与任何人连接
- 💬 **安全消息** - 设备间发送加密文本消息
- 🎨 **精美界面** - 现代深色主题，流畅动画

## 🚀 一键部署

将 CloudDrop 部署到您自己的 Cloudflare Workers：

[![部署到 Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/DeH40/cloudDrop)

## 🛠️ 开发

### 前置要求

- [Node.js](https://nodejs.org/) (v18+)
- [Cloudflare 账户](https://dash.cloudflare.com/sign-up)（免费套餐即可）

### 本地开发

```bash
# 克隆仓库
git clone https://github.com/DeH40/cloudDrop.git
cd cloudDrop

# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

开发服务器将在 `http://localhost:8787` 启动。

### 部署到生产环境

```bash
# 登录 Cloudflare（仅首次需要）
npx wrangler login

# 部署
npm run deploy
```

## ⚙️ 配置

### 可选：TURN 服务器（用于 NAT 穿透）

为了在受限网络中获得更好的连接性，您可以配置 Cloudflare 的 TURN 服务：

1. 从 [Cloudflare Dashboard](https://dash.cloudflare.com/?to=/:account/calls) 获取 TURN 凭证
2. 将密钥添加到您的 Worker：

```bash
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_API_TOKEN
```

未配置 TURN 时，CloudDrop 将使用公共 STUN 服务器进行 WebRTC 连接。

## 📁 项目结构

```
cloudDrop/
├── public/              # 静态资源
│   ├── index.html       # 主 HTML 文件
│   ├── style.css        # 样式表
│   ├── manifest.json    # PWA 清单
│   └── js/
│       ├── app.js       # 主应用逻辑
│       ├── ui.js        # UI 组件
│       ├── webrtc.js    # WebRTC 连接处理
│       └── crypto.js    # 加密工具
├── src/
│   ├── index.ts         # Worker 入口
│   └── room.ts          # WebSocket 房间的 Durable Object
├── wrangler.toml        # Cloudflare Workers 配置
└── package.json
```

## 🔧 技术栈

- **运行时**: Cloudflare Workers
- **实时通信**: WebSocket + Durable Objects
- **文件传输**: WebRTC Data Channels
- **加密**: Web Crypto API (AES-GCM)
- **前端**: 原生 JavaScript + CSS

## 📄 许可证

[MIT](./LICENSE) © DeH40

---

<p align="center">
  用 ❤️ 打造无缝文件分享体验
</p>
