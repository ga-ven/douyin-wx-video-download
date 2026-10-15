/**
 * 兜底方案：App Feed 接口万一被抖音改掉时，用无头 Chrome 打开网页版，
 * 读 <video> 元素的 currentSrc —— 那是抖音自己的 JS 签好名的直链。
 *
 * 比 App Feed 慢得多（冷启动 profile 实测要 90~100s 才出真流），
 * 而且未登录只有低码率，所以只在主路失败时才用。
 *
 * 需要 Node >= 22（用到了全局 WebSocket 连 CDP）和本机装有 Chrome。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sleep } from './util.js';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export function findChrome() {
  if (process.env.CHROME && fs.existsSync(process.env.CHROME)) return process.env.CHROME;
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onerror = () => reject(new Error('无法连接 Chrome 调试端口'));
    ws.onopen = () => {
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
      };
      resolve({
        send: (method, params = {}) => new Promise((r) => {
          const i = ++id;
          pending.set(i, r);
          ws.send(JSON.stringify({ id: i, method, params }));
        }),
        close: () => ws.close(),
      });
    };
  });
}

// 中途 currentSrc 会先指向一个"加载占位动画"，必须只认真视频 CDN
const REAL_MEDIA = /douyinvod\.com|\/video\/tos\//;

/**
 * @returns {Promise<{url:string, title:string, waitedMs:number}>}
 */
export async function fetchViaBrowser(awemeId, {
  waitMs = 180000,
  chromePath = null,
  reuseProfile = true,
  onTick = null,
  logger = null,
} = {}) {
  if (typeof WebSocket === 'undefined') {
    throw new Error('浏览器兜底需要 Node >= 22（用到了全局 WebSocket），当前版本 ' + process.version);
  }
  const chrome = chromePath || findChrome();
  if (!chrome) throw new Error('找不到 Chrome，可用 CHROME 环境变量指定路径');

  const profileDir = reuseProfile
    ? path.join(os.tmpdir(), 'douyin-video-download-chrome')
    : fs.mkdtempSync(path.join(os.tmpdir(), 'dvd-chrome-'));
  fs.mkdirSync(profileDir, { recursive: true });

  const port = String(9300 + Math.floor(Math.random() * 500));
  const child = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--autoplay-policy=no-user-gesture-required',
    '--lang=zh-CN',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    let wsUrl = null;
    for (let i = 0; i < 160 && !wsUrl; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const page = list.find((t) => t.type === 'page') || list[0];
        wsUrl = page?.webSocketDebuggerUrl || null;
      } catch { /* 还没起来 */ }
      if (!wsUrl) await sleep(300);
    }
    if (!wsUrl) throw new Error('Chrome 调试端口没起来（冷启动可能要 10~30s）');

    cdp = await connectCdp(wsUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `https://www.douyin.com/video/${awemeId}` });

    const t0 = Date.now();
    let url = '';
    while (Date.now() - t0 < waitMs) {
      await sleep(1000);
      try {
        const r = await cdp.send('Runtime.evaluate', {
          expression: "(()=>{const v=document.querySelector('video');return (v&&(v.currentSrc||v.src))||''})()",
          returnByValue: true,
        });
        const candidate = r?.result?.value || '';
        if (candidate && REAL_MEDIA.test(candidate)) { url = candidate; break; }
      } catch { /* 页面还在导航 */ }
      if (onTick) onTick(Date.now() - t0);
    }
    if (!url) throw new Error(`浏览器兜底失败：等了 ${Math.round(waitMs / 1000)}s 没拿到视频流`);

    let title = '';
    try {
      const r = await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
      title = r?.result?.value || '';
    } catch { /* 拿不到就算了 */ }

    return { url, title, waitedMs: Date.now() - t0 };
  } finally {
    try { cdp?.close(); } catch { /* ignore */ }
    try { child.kill(); } catch { /* ignore */ }
    if (!reuseProfile) {
      await sleep(800);
      for (let i = 0; i < 10; i++) {
        try { fs.rmSync(profileDir, { recursive: true, force: true }); break; } catch { await sleep(500); }
      }
    }
  }
}
