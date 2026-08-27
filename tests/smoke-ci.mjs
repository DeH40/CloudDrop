/**
 * CloudDrop - CI 冒烟测试
 * 启动 wrangler dev → 验证首页 200 + 安全头 + WebSocket 能完成 join。
 * （真实浏览器渲染/CSP 字体等仍建议本地 playwright 复核）
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const PORT = 8798;
const BASE = `http://localhost:${PORT}`;

function waitWsMessage(ws, type, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener('message', handleMessage);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting ${type}`));
    }, timeout);
    const handleMessage = (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === type) {
          cleanup();
          resolve(message);
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    ws.addEventListener('message', handleMessage);
  });
}

function waitWsOpen(ws, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timeout opening WebSocket'));
    }, timeout);
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener('open', handleOpen);
      ws.removeEventListener('error', handleError);
    };
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleError = (error) => {
      cleanup();
      reject(error);
    };
    ws.addEventListener('open', handleOpen);
    ws.addEventListener('error', handleError);
  });
}

async function waitForServer(attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.ok) return;
    } catch (e) { /* not ready */ }
    await sleep(1000);
  }
  throw new Error('wrangler dev 启动超时');
}

const wrangler = spawn('npx', ['wrangler', 'dev', '--port', String(PORT)], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
  detached: true, // 独立进程组，便于连子进程一起清理
});

let wranglerOutput = '';
wrangler.stdout.on('data', (d) => { wranglerOutput += d.toString(); });
wrangler.stderr.on('data', (d) => { wranglerOutput += d.toString(); });

let exitCode = 0;
let ws;

try {
  await waitForServer();

  // 1. 首页与静态资源
  const checks = [];
  for (const f of ['/', '/js/app.js', '/vendor/qrcode.min.js']) {
    const res = await fetch(BASE + f);
    checks.push([f, res.status === 200]);
  }
  console.log('静态资源:', JSON.stringify(checks));

  // 2. 安全头（含字体真实域名 gstatic.loli.net）
  const css = await fetch(`${BASE}/style.css`);
  const csp = css.headers.get('content-security-policy') || '';
  const fontOk = csp.includes('https://gstatic.loli.net');
  const nosniff = css.headers.get('x-content-type-options') === 'nosniff';
  console.log('CSP 含字体域名:', fontOk, '| nosniff:', nosniff);

  // 3. WebSocket join
  const room = 'SMOKE1';
  ws = new WebSocket(`ws://localhost:${PORT}/ws?room=${room}`);
  await waitWsOpen(ws);
  const joinedPromise = waitWsMessage(ws, 'joined');
  ws.send(JSON.stringify({ type: 'join', data: { name: 'smoke', deviceType: 'desktop', deviceKey: 'SMK' } }));
  const joined = await joinedPromise;
  console.log('WebSocket joined:', joined.roomCode === room);
  ws.close();

  const failed = [
    ...checks.filter(([, ok]) => !ok).map(([f]) => `资源 ${f} 非 200`),
    ...(!fontOk ? ['CSP 缺 gstatic.loli.net'] : []),
    ...(!nosniff ? ['缺 nosniff'] : []),
    ...(joined.roomCode !== room ? ['WebSocket join 失败'] : []),
  ];

  if (failed.length) {
    throw new Error(failed.join('; '));
  }
  console.log('SMOKE PASS');
} catch (e) {
  console.error('SMOKE FAIL:', e.message);
  console.error(wranglerOutput.slice(-2000));
  exitCode = 1;
} finally {
  ws?.terminate();
  try { process.kill(-wrangler.pid, 'SIGTERM'); } catch (e) { /* already gone */ }
}

process.exitCode = exitCode;
