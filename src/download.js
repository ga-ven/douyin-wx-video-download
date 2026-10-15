/**
 * 下载：支持断点续传、退避重试、进度回调、MD5 校验。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { withRetry, sleep } from './util.js';

export const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function partPath(dest) { return `${dest}.part`; }

async function statSize(p) {
  try { return (await fs.promises.stat(p)).size; } catch { return 0; }
}

/**
 * 把 url 的内容下到 dest。
 *
 * 先写 `dest.part`，全部成功后原子改名 —— 中断时不会留下一个"看起来完整"的坏文件，
 * 而且下次调用能接着 `dest.part` 续传。
 *
 * @returns {Promise<{path:string, bytes:number, md5:string, resumedFrom:number, attempts:number}>}
 */
export async function downloadFile(url, dest, {
  headers = {},
  onProgress = null,
  resume = true,
  retries = 3,
  timeoutMs = 120000,
  logger = null,
} = {}) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const part = partPath(dest);

  let attempts = 0;
  await withRetry(async () => {
    attempts++;
    let start = resume ? await statSize(part) : 0;
    const reqHeaders = { ...headers };
    if (start > 0) reqHeaders.Range = `bytes=${start}-`;

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, { headers: reqHeaders, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

    // 服务器忽略了 Range（回了 200 而不是 206）——只能从头来
    let append = res.status === 206 && start > 0;
    if (start > 0 && !append) {
      if (logger) logger.info('服务器不支持续传，从头下载');
      start = 0;
    }

    const contentLen = Number(res.headers.get('content-length') || 0) || 0;
    const total = contentLen ? start + contentLen : 0;

    const ws = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
    let got = start;
    const source = Readable.fromWeb(res.body);
    source.on('data', (chunk) => {
      got += chunk.length;
      if (onProgress) onProgress(got, total);
    });

    await pipeline(source, ws);
    if (total && got !== total) throw new Error(`下载不完整：${got}/${total} 字节`);

    return { got, start, total };
  }, {
    retries,
    delay: 1000,
    onRetry: async (err, n, wait) => {
      if (logger) logger.warn(`下载中断（${err.message}），${(wait / 1000).toFixed(1)}s 后第 ${n} 次重试（已存 ${await statSize(part)} 字节，将续传）`);
      await sleep(0);
    },
  });

  await fs.promises.rename(part, dest);
  const bytes = await statSize(dest);
  const md5 = await md5File(dest);
  return { path: dest, bytes, md5, attempts };
}

export function md5File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('md5');
    fs.createReadStream(p).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/**
 * 接口给的 play_addr.file_hash 就是这个文件的 MD5，
 * 所以下完可以直接对 —— 这是本项目的免费完整性校验。
 */
export function verifyAgainstHash(actualMd5, expectedHash) {
  if (!expectedHash) return { ok: true, skipped: true };
  return { ok: actualMd5.toLowerCase() === String(expectedHash).toLowerCase(), expected: expectedHash, actual: actualMd5 };
}
