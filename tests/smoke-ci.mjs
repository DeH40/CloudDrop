/**
 * CloudDrop - CI 冒烟测试
 * 启动 wrangler dev → 验证首页 200 + 安全头 + WebSocket 能完成 join。
 * （真实浏览器渲染/CSP 字体等仍建议本地 playwright 复核）
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 8798;
const BASE = `http://localhost:${PORT}`;

function waitWsMessage(ws, type, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting ${type}`)), timeout);
    const h = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === type) {
        clearTimeout(t);
        ws.removeEventListener('message', h);
        resolve(m);
      }
    };
    ws.addEventListener('message', h);
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
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=${room}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.send(JSON.stringify({ type: 'join', data: { name: 'smoke', deviceType: 'desktop', deviceKey: 'SMK' } }));
  const joined = await waitWsMessage(ws, 'joined');
  console.log('WebSocket joined:', joined.roomCode === room);
  ws.close();

  const failed = [
    ...checks.filter(([, ok]) => !ok).map(([f]) => `资源 ${f} 非 200`),
    ...(!fontOk ? ['CSP 缺 gstatic.loli.net'] : []),
    ...(!nosniff ? ['缺 nosniff'] : []),
    ...(joined.roomCode !== room ? ['WebSocket join 失败'] : []),
  ];

  if (failed.length) {
    console.error('SMOKE FAIL:', failed.join('; '));
    console.error(wranglerOutput.slice(-2000));
    process.exit(1);
  }
  console.log('SMOKE PASS');
  process.exit(0);
} catch (e) {
  console.error('SMOKE FAIL:', e.message);
  console.error(wranglerOutput.slice(-2000));
  process.exit(1);
} finally {
  try { process.kill(-wrangler.pid, 'SIGTERM'); } catch (e) { /* already gone */ }
  setTimeout(() => process.exit(0), 500).unref();
}
