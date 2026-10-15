/**
 * 作为库用：批量下载若干链接，并挑最高画质。
 *
 *   node examples/programmatic.mjs "https://v.douyin.com/xxxx/" "https://v.douyin.com/yyyy/"
 */

import path from 'node:path';
import { download, inspect } from '../src/index.js';

const urls = process.argv.slice(2);
if (urls.length === 0) {
  console.error('用法: node examples/programmatic.mjs <链接> [更多链接...]');
  process.exit(2);
}

const outDir = path.resolve('./downloads');

for (const url of urls) {
  try {
    // 先看一眼有哪些档位，再决定下哪个
    const info = await inspect(url);
    console.log(`\n== ${info.meta.author} · ${info.meta.title.slice(0, 40)}`);
    for (const s of info.streams) {
      console.log(`   ${String(s.width + 'x' + s.height).padEnd(10)} ${s.codec.padEnd(5)} ${(s.size / 1048576).toFixed(2)} MB  ${s.gear ?? s.label}`);
    }

    const res = await download(url, { outDir, quality: 'best' });
    const f = res.files[0];
    console.log(`   -> ${path.basename(f.path)}  ${(f.bytes / 1048576).toFixed(2)} MB  MD5 ${f.verified ? 'OK' : '未校验'}`);
  } catch (e) {
    console.error(`   !! ${url} 失败: ${e.message}`);
  }
}
