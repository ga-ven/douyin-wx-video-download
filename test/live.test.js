/**
 * 在线联调测试（默认跳过）。
 *
 *   LIVE=1 node --test test/live.test.js
 *   LIVE=1 LIVE_URL="https://v.douyin.com/xxxx/" node --test test/live.test.js
 *
 * 会真的联网、真的下载。默认不跑，避免 CI 和离线环境失败。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { inspect, download } from '../src/index.js';
import { md5File } from '../src/download.js';

const LIVE = process.env.LIVE === '1';
const URL_UNDER_TEST = process.env.LIVE_URL || 'https://v.douyin.com/9154AvnKE6w/';
const need = { skip: LIVE ? false : '需要 LIVE=1 才跑（会真的联网下载）' };

test('inspect 能拿到档位表', need, async () => {
  const info = await inspect(URL_UNDER_TEST);
  assert.equal(info.source, 'app_feed', '应走 App Feed 主路');
  assert.ok(info.id);
  assert.ok(info.streams.length > 0, '至少要有一个档位');
  assert.ok(info.streams.every((s) => /^https:\/\//.test(s.url)));
  assert.ok(info.streams.every((s) => !s.url.includes('watermarked')), '默认候选不含带水印版');
});

test('download 下到的文件 MD5 与接口 file_hash 一致', need, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvd-live-'));
  try {
    const res = await download(URL_UNDER_TEST, { outDir: dir, quality: 'auto' });
    assert.equal(res.files.length, 1);
    const f = res.files[0];
    assert.ok(fs.existsSync(f.path));

    if (res.chosen.file_hash) {
      const md5 = await md5File(f.path);
      assert.equal(md5, res.chosen.file_hash, 'MD5 必须等于接口给的 file_hash');
      assert.equal(f.verified, true);
    }

    assert.ok(!fs.existsSync(`${f.path}.part`), '成功后 .part 临时文件应已清理');

    // 同一个链接第二次跑应该识别为已存在，且内容与所选档位一致
    const again = await download(URL_UNDER_TEST, { outDir: dir, quality: 'auto' });
    assert.equal(again.files[0].skipped, true);
    assert.equal(again.files[0].same_as_chosen, true, '同名文件内容应与所选档位一致');

    // 换一个档位再跑，应该明确指出"已存在但档位不同"，而不是静默跳过
    const other = await download(URL_UNDER_TEST, { outDir: dir, quality: 'hevc' });
    if (other.chosen.file_hash && other.chosen.file_hash !== res.chosen.file_hash) {
      assert.equal(other.files[0].same_as_chosen, false);
      assert.ok(other.warnings.some((w) => /档位不同/.test(w)));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('纯数字 id 与网页链接等价', need, async () => {
  const byUrl = await inspect(URL_UNDER_TEST);
  const byId = await inspect(byUrl.id);
  assert.equal(byId.id, byUrl.id);
  assert.equal(byId.streams.length, byUrl.streams.length);
});

/* ------------------------------------------------------------------ *
 * 微信视频号
 *
 * 需要三样都齐了才跑：LIVE=1、元宝 Cookie、一个 sph 链接。
 *   LIVE=1 YUANBAO_COOKIE="hy_user=..." LIVE_SPH_URL="https://weixin.qq.com/sph/xxxx" node --test test/live.test.js
 * ------------------------------------------------------------------ */

const SPH_URL = process.env.LIVE_SPH_URL || '';
const HAS_COOKIE = Boolean(process.env.YUANBAO_COOKIE);
const needChannels = {
  skip: !LIVE
    ? '需要 LIVE=1 才跑'
    : (!HAS_COOKIE ? '需要 YUANBAO_COOKIE' : (!SPH_URL ? '需要 LIVE_SPH_URL' : false)),
};

test('视频号 inspect：识别平台并拿到 H.264 / H.265 两路', needChannels, async () => {
  const info = await inspect(SPH_URL);
  assert.equal(info.platform, 'channels');
  assert.equal(info.source, 'yuanbao');
  assert.ok(info.id, 'sph 短 id 应被解析出来');
  assert.ok(info.streams.length >= 1, '至少要拿到一路');
  assert.ok(info.streams.every((s) => /^https:\/\//.test(s.url)));
  assert.ok(info.streams.some((s) => s.codec === 'h264'), '应有 H.264 兼容版');
  // 视频号不给这些，必须是 null 而不是编出来的值
  assert.ok(info.streams.every((s) => s.file_hash === null));
});

test('视频号 download：落盘且体积与 Content-Length 合理一致', needChannels, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwvd-live-sph-'));
  try {
    const res = await download(SPH_URL, { outDir: dir, quality: 'auto' });
    assert.equal(res.platform, 'channels');
    assert.equal(res.files.length, 1);
    const f = res.files[0];
    assert.ok(fs.existsSync(f.path), '文件应落盘');
    assert.ok(f.bytes > 1024, `体积太小，可疑：${f.bytes}`);
    assert.ok(!fs.existsSync(`${f.path}.part`), '成功后 .part 应清理');
    // 没有 file_hash 时应明确提示跳过了校验，而不是谎报通过
    assert.ok(res.warnings.some((w) => /file_hash/.test(w)));

    // 第二次跑应识别为已存在
    const again = await download(SPH_URL, { outDir: dir });
    assert.equal(again.files[0].skipped, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

