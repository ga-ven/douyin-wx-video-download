/**
 * 作为库用：批量下载若干链接（抖音 / 视频号混着给都行），并挑最高画质。
 *
 *   node examples/programmatic.mjs "https://v.douyin.com/xxxx/" "https://weixin.qq.com/sph/yyyy"
 *
 * 视频号需要元宝 Cookie，从环境变量 YUANBAO_COOKIE 读。
 */

import path from 'node:path';
import { download, inspect, detectPlatform } from '../src/index.js';
import { loadCookie, maskCookie } from '../src/config.js';

const urls = process.argv.slice(2);
if (urls.length === 0) {
  console.error('用法: node examples/programmatic.mjs <链接> [更多链接...]');
  process.exit(2);
}

const outDir = path.resolve('./downloads');

// 视频号要凭据；这里只读环境变量（不传 required，抖音链接不需要它）
const { cookie, from } = loadCookie({});
if (cookie) console.log(`已读到元宝 Cookie（来源：${from}）→ ${maskCookie(cookie)}`);

for (const url of urls) {
  const platform = detectPlatform(url) || 'douyin';
  try {
    // 先看一眼有哪些档位，再决定下哪个
    const info = await inspect(url, { cookie });
    console.log(`\n== [${platform}] ${info.meta.author} · ${(info.meta.title || '').slice(0, 40)}`);
    for (const s of info.streams) {
      const dim = s.width && s.height ? `${s.width}x${s.height}` : '?';
      const size = s.size ? `${(s.size / 1048576).toFixed(2)} MB` : '体积未知';
      console.log(`   ${dim.padEnd(10)} ${String(s.codec).padEnd(5)} ${size.padEnd(12)} ${s.gear ?? s.label}`);
    }

    const res = await download(url, { outDir, quality: 'best', cookie });
    const f = res.files[0];
    const verify = f.verified === true ? 'MD5 OK' : f.verified === false ? 'MD5 失败' : '未校验';
    console.log(`   -> ${path.basename(f.path)}  ${(f.bytes / 1048576).toFixed(2)} MB  ${verify}`);
  } catch (e) {
    console.error(`   !! ${url} 失败: ${e.message}`);
  }
}
