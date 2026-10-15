/**
 * 集成测试：起一个本地 HTTP 服务器冒充抖音 CDN，
 * 用注入的 inspector 喂假数据，把「下载编排」整条链路跑通 —— 不联网。
 *
 *   node --test test/integration.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { download } from '../src/index.js';
import { downloadFile, md5File } from '../src/download.js';

function makeBody(size, seed = 1) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (i * seed) % 251;
  return buf;
}

const MP4 = makeBody(4096, 7);
const IMG1 = makeBody(512, 3);
const IMG2 = makeBody(768, 5);

/** 起一个假 CDN，支持 Range，也能按需装成"不支持 Range" */
async function startServer({ supportRange = true } = {}) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const table = {
      '/v-h264.mp4': { body: MP4, type: 'video/mp4' },
      '/v-265.mp4': { body: makeBody(2048, 9), type: 'video/mp4' },
      '/img1.jpeg': { body: IMG1, type: 'image/jpeg' },
      '/img2.jpeg': { body: IMG2, type: 'image/jpeg' },
    };
    const hit = table[u.pathname];
    if (!hit) { res.writeHead(404).end('nope'); return; }

    const range = supportRange ? req.headers.range : null;
    if (range) {
      const m = range.match(/bytes=(\d+)-/);
      const start = m ? Number(m[1]) : 0;
      const slice = hit.body.subarray(start);
      res.writeHead(206, {
        'Content-Type': hit.type,
        'Content-Length': slice.length,
        'Content-Range': `bytes ${start}-${hit.body.length - 1}/${hit.body.length}`,
      });
      res.end(slice);
      return;
    }
    res.writeHead(200, { 'Content-Type': hit.type, 'Content-Length': hit.body.length });
    res.end(hit.body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function videoInspector(base) {
  const streams = [
    { url: `${base}/v-h264.mp4`, all_urls: [], width: 576, height: 1024, quality_height: 576, size: MP4.length, file_hash: crypto.createHash('md5').update(MP4).digest('hex'), codec: 'h264', label: '默认流', gear: null, definition: null, vmaf: null },
    { url: `${base}/v-265.mp4`, all_urls: [], width: 720, height: 1280, quality_height: 720, size: 2048, file_hash: null, codec: 'hevc', label: '720_1_1', gear: '720_1_1', definition: '720p', vmaf: 97.7 },
  ];
  return async () => ({
    id: '1234567890123456789',
    platform: 'douyin',
    source: 'app_feed',
    source_host: 'mock',
    meta: {
      id: '1234567890123456789', platform: 'douyin', title: '集成测试作品', author: 'tester',
      duration_sec: 12.5, created_at: '2026-10-15T00:00:00.000Z', is_image_post: false, image_count: 0,
    },
    streams,
    images: [],
    watermarked: null,
  });
}

function imageInspector(base) {
  return async () => ({
    id: '9876543210987654321',
    platform: 'douyin',
    source: 'app_feed',
    source_host: 'mock',
    meta: {
      id: '9876543210987654321', platform: 'douyin', title: '图文作品', author: 'tester',
      duration_sec: null, created_at: null, is_image_post: true, image_count: 2,
    },
    streams: [],
    images: [
      { index: 0, url: `${base}/img1.jpeg`, ext: 'jpeg' },
      { index: 1, url: `${base}/img2.jpeg`, ext: 'jpeg' },
    ],
    watermarked: null,
  });
}

test('视频：下载落盘 + MD5 与 file_hash 一致', async (t) => {
  const { server, base } = await startServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvd-int-'));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const res = await download('x', { outDir: dir, inspector: videoInspector(base) });
  assert.equal(res.type, 'video');
  assert.equal(res.files.length, 1);
  assert.equal(res.files[0].verified, true);
  assert.equal(res.files[0].md5, crypto.createHash('md5').update(MP4).digest('hex'));
  assert.ok(!fs.existsSync(`${res.files[0].path}.part`), '成功后会清掉 .part');
  assert.ok(res.files[0].path.endsWith('.mp4'));
});

test('视频：换档位后同名文件会被识别为"档位不同"', async (t) => {
  const { server, base } = await startServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvd-int-'));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  await download('x', { outDir: dir, quality: 'auto', inspector: videoInspector(base) });
  const second = await download('x', { outDir: dir, quality: 'hevc', inspector: videoInspector(base) });
  assert.equal(second.files[0].skipped, true);
  assert.equal(second.files[0].same_as_chosen, false, '720 档与已有的 576 档不是同一个文件');
  assert.ok(second.warnings.some((w) => /档位不同/.test(w)));

  // 加 --force 就应该真的覆盖
  const forced = await download('x', { outDir: dir, quality: 'hevc', force: true, inspector: videoInspector(base) });
  assert.equal(forced.files[0].skipped, undefined);
  assert.equal(forced.files[0].bytes, 2048);
});

test('视频：--no-verify 时不校验', async (t) => {
  const { server, base } = await startServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvd-int-'));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const res = await download('x', { outDir: dir, verify: false, inspector: videoInspector(base) });
  assert.equal(res.files[0].verified, null);
});

test('图集：全部原图落盘并编号', async (t) => {
  const { server, base } = await startServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvd-int-'));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const res = await download('x', { outDir: dir, inspector: imageInspector(base) });
  assert.equal(res.type, 'images');
  assert.equal(res.files.length, 2);
  const names = res.files.map((f) => path.basename(f.path)).sort();
  assert.deepEqual(names, ['01.jpeg', '02.jpeg']);
  assert.equal(fs.readFileSync(res.files[0].path).length, IMG1.length);
  assert.equal(fs.readFileSync(res.files[1].path).length, IMG2.length);
  // 应在同名子目录里
  assert.equal(path.dirname(res.files[0].path), path.dirname(res.files[1].path));
});

test('图集：第二次跑跳过已存在的图', async (t) => {
  const { server, base } = await startServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvd-int-'));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  await download('x', { outDir: dir, inspector: imageInspector(base) });
  const again = await download('x', { outDir: dir, inspector: imageInspector(base) });
  assert.ok(again.files.every((f) => f.skipped === true));
});

test('downloadFile：断点续传（服务器支持 Range）', async (t) => {
  const { server, base } = await startServer({ supportRange: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvd-int-'));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const dest = path.join(dir, 'resumed.mp4');
  // 预置一个只下了一半的 .part，模拟上次中断
  fs.writeFileSync(`${dest}.part`, MP4.subarray(0, 1000));

  const r = await downloadFile(`${base}/v-h264.mp4`, dest, {});
  assert.equal(r.bytes, MP4.length);
  assert.deepEqual(fs.readFileSync(dest), MP4, '续传拼出来的内容必须和源文件逐字节一致');
  assert.ok(!fs.existsSync(`${dest}.part`));
});

test('downloadFile：服务器不支持 Range 时自动从头下', async (t) => {
  const { server, base } = await startServer({ supportRange: false });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvd-int-'));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const dest = path.join(dir, 'restarted.mp4');
  fs.writeFileSync(`${dest}.part`, MP4.subarray(0, 1000));

  const r = await downloadFile(`${base}/v-h264.mp4`, dest, {});
  assert.equal(r.bytes, MP4.length);
  assert.deepEqual(fs.readFileSync(dest), MP4, '要重下成完整文件，不能接着追加成两倍长');
});

test('downloadFile：404 要抛错且不留下目标文件', async (t) => {
  const { server, base } = await startServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvd-int-'));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const dest = path.join(dir, 'missing.mp4');
  await assert.rejects(() => downloadFile(`${base}/nope.mp4`, dest, { retries: 0 }), /HTTP 404/);
  assert.ok(!fs.existsSync(dest), '失败时不应生成目标文件');
});

test('md5File 与 node:crypto 一致', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvd-int-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, 'x.bin');
  fs.writeFileSync(p, MP4);
  assert.equal(await md5File(p), crypto.createHash('md5').update(MP4).digest('hex'));
});
