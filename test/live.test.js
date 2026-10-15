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
  assert.ok(info.aweme_id);
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
  const byId = await inspect(byUrl.aweme_id);
  assert.equal(byId.aweme_id, byUrl.aweme_id);
  assert.equal(byId.streams.length, byUrl.streams.length);
});
