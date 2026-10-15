/**
 * 离线单测：不联网，全部走 fixture。
 *   node --test test/
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sanitizeFilename, buildFilename, formatBytes, withRetry, trimUnbalancedTail, truncateKeepingTail, toNativePath } from '../src/util.js';
import { extractUrl, extractIdFromString, resolveAwemeId } from '../src/resolve.js';
import { enumerateStreams, enumerateImages, pickStream, watermarkedStream } from '../src/streams.js';
import { describeAweme, isImagePost } from '../src/feed.js';
import { verifyAgainstHash } from '../src/download.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const videoFixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/aweme-video.json'), 'utf-8'));
const imageFixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/aweme-images.json'), 'utf-8'));

// ---------------- util ----------------

test('formatBytes 走对单位', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.00 KB');
  assert.equal(formatBytes(2485417), '2.37 MB');
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(null), '?');
});

test('toNativePath 把 git-bash 风格路径还原成盘符路径', () => {
  if (process.platform === 'win32') {
    assert.equal(toNativePath('/d/coding/dy'), 'D:\\coding\\dy');
    assert.equal(toNativePath('/c/Users/PC'), 'C:\\Users\\PC');
    assert.equal(toNativePath('/d'), 'D:\\');
    // 不是盘符挂载的绝对路径（/tmp、/usr）保持原样，交给 Node 处理
    assert.equal(toNativePath('/tmp/out'), '/tmp/out');
    // 已经是原生路径 / 相对路径，一律不动
    assert.equal(toNativePath('D:\\coding\\dy'), 'D:\\coding\\dy');
    assert.equal(toNativePath('relative/out'), 'relative/out');
  } else {
    // 非 Windows 平台是恒等函数
    assert.equal(toNativePath('/d/coding/dy'), '/d/coding/dy');
    assert.equal(toNativePath('./out'), './out');
  }
  assert.equal(toNativePath(null), '');
});

test('sanitizeFilename 干掉各平台非法字符', () => {
  assert.equal(sanitizeFilename('a<b>c:d/e\\f|g?h*i'), 'a b c d e f g h i');
  assert.equal(sanitizeFilename('  前后空白  '), '前后空白');
  assert.equal(sanitizeFilename('结尾有点...'), '结尾有点');
  assert.equal(sanitizeFilename('CON'), '_CON', 'Windows 保留名要加前缀');
  assert.equal(sanitizeFilename(''), 'douyin', '空值走 fallback');
  assert.equal(sanitizeFilename('x'.repeat(200)).length, 80, '超长要截断');
});

test('sanitizeFilename 不会把代理对切成半个字符', () => {
  const s = sanitizeFilename('🎵'.repeat(100), { maxLen: 10 });
  assert.equal([...s].length, 10);
  assert.ok(!s.includes('\ufffd'), '不应出现替换字符');
});

test('buildFilename 套模板并各自限长', () => {
  const name = buildFilename({
    author: '元宝✨',
    title: '测试用作品 #hashtag 带/非法:字符*？和很长的尾巴用来验证文件名截断逻辑是否生效',
    awemeId: '7694602355278543542',
  });
  assert.ok(name.startsWith('元宝✨_'));
  assert.ok(name.endsWith('_7694602355278543542.mp4'));
  assert.ok(!/[<>:"/\\|?*]/.test(name), '不应含非法字符');
  assert.ok([...name].length <= 100, '总长要收敛');

  const custom = buildFilename({ author: 'a', title: 'b', awemeId: '123' }, { template: '{id}-{date}', ext: 'jpeg' });
  assert.equal(custom, '123-.jpeg');
});

test('trimUnbalancedTail 切掉没闭合的左括号', () => {
  assert.equal(trimUnbalancedTail('前半（完整）后半'), '前半（完整）后半', '配对的不动');
  assert.equal(trimUnbalancedTail('主题（无不良引导，审核'), '主题', '没闭合就切到括号前');
  assert.equal(trimUnbalancedTail('主题（a）尾（b'), '主题（a）尾', '切的是最后一个没配对的');
  assert.equal(trimUnbalancedTail('（开头就没闭合'), '（开头就没闭合', '从 0 开始就不切，避免全空');
});

test('buildFilename 长标题不会留半截括号', () => {
  const name = buildFilename({
    author: '元宝✨',
    title: '跳完力竭了（无不良引导，不是吊带袜，审核自己有辨别能力吗）',
    awemeId: '7694602355278543542',
  });
  const open = (name.match(/（/g) || []).length;
  const close = (name.match(/）/g) || []).length;
  assert.equal(open, close, `括号应成对：${name}`);
  assert.ok(!/（[^）]*_7694/.test(name), '不应在括号内部直接接 id');
});

test('buildFilename 修括号时绝不能把 aweme_id 弄丢', () => {
  // 标题被截断后留下没闭合的括号，修括号时很容易把后面的 _{id} 一起切掉
  const name = buildFilename({
    author: '元宝✨',
    title: '跳完力竭了（无不良引导，不是吊带袜，审核自己有辨别能力吗）',
    awemeId: '7694602355278543542',
  });
  assert.ok(name.includes('7694602355278543542'), `id 必须保留：${name}`);
  assert.ok(name.endsWith('_7694602355278543542.mp4'));

  // 超长标题同样要保住 id 尾巴
  const long = buildFilename({ author: 'a', title: 'x'.repeat(300), awemeId: '7694602355278543542' });
  assert.ok(long.endsWith('_7694602355278543542.mp4'), `超长也不许丢 id：${long}`);
  assert.ok([...long].length <= 100, '总长仍要收敛');
});

test('truncateKeepingTail 保住尾巴', () => {
  assert.equal(truncateKeepingTail('abcdefghij', 20, '123'), 'abcdefghij', '没超长就不动');
  assert.equal(truncateKeepingTail('abcdefghij', 6, '123'), 'ab_123');
  assert.equal(truncateKeepingTail('abcdefghij', 3, '123'), '123');
});

test('withRetry 最终成功 / 最终抛出', async () => {
  let n = 0;
  const v = await withRetry(async () => {
    n++;
    if (n < 3) throw new Error('boom');
    return 'ok';
  }, { retries: 3, delay: 1 });
  assert.equal(v, 'ok');
  assert.equal(n, 3);

  await assert.rejects(
    () => withRetry(async () => { throw new Error('always'); }, { retries: 2, delay: 1 }),
    /always/,
  );
});

// ---------------- resolve ----------------

test('extractUrl 能从分享文案里抠链接', () => {
  assert.equal(
    extractUrl('7.85 复制打开抖音 https://v.douyin.com/9154AvnKE6w/ 09/25 R@X.ZM'),
    'https://v.douyin.com/9154AvnKE6w/',
  );
  assert.equal(extractUrl('看这个 v.douyin.com/abc123/ 挺好'), 'https://v.douyin.com/abc123/');
  assert.equal(extractUrl('没有链接'), '');
});

test('extractIdFromString 认各种形态', () => {
  assert.equal(extractIdFromString('https://www.douyin.com/video/7694602355278543542'), '7694602355278543542');
  assert.equal(extractIdFromString('https://www.douyin.com/note/7694602355278543542?x=1'), '7694602355278543542');
  assert.equal(extractIdFromString('https://www.iesdouyin.com/share/video/7694602355278543542/'), '7694602355278543542');
  assert.equal(extractIdFromString('https://example.com/nothing'), '');
});

test('resolveAwemeId：纯 id 和自带 id 的链接不联网', async () => {
  const a = await resolveAwemeId('7694602355278543542', { fetchImpl: () => { throw new Error('不该联网'); } });
  assert.deepEqual(a, { awemeId: '7694602355278543542', resolvedFrom: 'raw-id' });

  const b = await resolveAwemeId('https://www.douyin.com/video/7694602355278543542', { fetchImpl: () => { throw new Error('不该联网'); } });
  assert.equal(b.resolvedFrom, 'url-path');
});

test('resolveAwemeId：短链走跳转', async () => {
  const fakeFetch = async () => ({ url: 'https://www.iesdouyin.com/share/video/7694602355278543542/?x=1', text: async () => '' });
  const r = await resolveAwemeId('https://v.douyin.com/9154AvnKE6w/', { fetchImpl: fakeFetch });
  assert.deepEqual(r, { awemeId: '7694602355278543542', resolvedFrom: 'redirect' });
});

test('resolveAwemeId：链接失效要给出人话', async () => {
  const fakeFetch = async () => ({ url: 'https://www.douyin.com/', text: async () => '<html>nothing</html>' });
  await assert.rejects(() => resolveAwemeId('https://v.douyin.com/deadlink/', { fetchImpl: fakeFetch }), /已删除|私密|失效/);
});

// ---------------- streams ----------------

test('enumerateStreams 按 file_hash 去重', () => {
  const s = enumerateStreams(videoFixture);
  const hashes = s.map((x) => x.file_hash);
  assert.equal(new Set(hashes).size, hashes.length, 'file_hash 不应重复');

  // play_addr / play_addr_h264 / play_addr_lowbr 是同一个文件，只能出现一次
  const h264 = s.filter((x) => x.codec === 'h264');
  assert.equal(h264.length, 1);
  assert.equal(h264[0].size, 2485417);

  // play_addr_265 与 bit_rate[0] 同一个文件，也只能出现一次
  const topHevc = s.filter((x) => x.codec === 'hevc' && x.size === 1431413);
  assert.equal(topHevc.length, 1);

  assert.equal(s.length, 4, `期望 4 条去重后的档位（1 个 h264 + 3 个 hevc），实际 ${s.length}`);
});

test('enumerateStreams 给出"算多少 P"（竖屏按短边）', () => {
  const s = enumerateStreams(videoFixture);
  const byGear = Object.fromEntries(s.filter((x) => x.gear).map((x) => [x.gear, x]));
  assert.equal(byGear['720_1_1'].quality_height, 720, '接口给了 definition 就用它');
  assert.equal(byGear['720_1_1'].height, 1280);
  assert.equal(byGear['540_1_1'].quality_height, 540);
  const h264 = s.find((x) => x.codec === 'h264');
  assert.equal(h264.quality_height, 576, '没有 definition 时取短边，不能取 1024');
});

test('enumerateStreams 排除带水印的 download_addr', () => {
  const s = enumerateStreams(videoFixture);
  assert.ok(!s.some((x) => x.url.includes('watermarked')), '默认候选里不应有带水印版本');
  const w = watermarkedStream(videoFixture);
  assert.ok(w.url.includes('watermarked'));
  assert.equal(w.width, 720);
});

test('enumerateStreams 对图集返回空', () => {
  assert.deepEqual(enumerateStreams(imageFixture), []);
});

test('pickStream: auto 优先 h264 且码率最高', () => {
  const { stream, reason } = pickStream(enumerateStreams(videoFixture), 'auto');
  assert.equal(stream.codec, 'h264');
  assert.equal(stream.width, 576);
  assert.match(reason, /h264/);
});

test('pickStream: best 拿像素最多', () => {
  const { stream } = pickStream(enumerateStreams(videoFixture), 'best');
  assert.equal(stream.width, 720);
  assert.equal(stream.height, 1280);
});

test('pickStream: hevc / h264 限定编码', () => {
  const s = enumerateStreams(videoFixture);
  assert.equal(pickStream(s, 'hevc').stream.codec, 'hevc');
  assert.equal(pickStream(s, 'h264').stream.codec, 'h264');
});

test('pickStream: 按清晰度挑，不超过所要求的高度', () => {
  const s = enumerateStreams(videoFixture);
  const p540 = pickStream(s, '540').stream;
  assert.equal(p540.height, 1024, '540 应命中 576x1024 那档');

  const p720 = pickStream(s, '720').stream;
  assert.equal(p720.height, 1280);

  const p360 = pickStream(s, '360').stream;
  assert.equal(p360.height, 1024, '没有 <=360 的档位时退回最低的那档');
});

test('pickStream: 精确指定 gear_name', () => {
  const { stream } = pickStream(enumerateStreams(videoFixture), '720_2_1');
  assert.equal(stream.gear, '720_2_1');
  assert.equal(stream.size, 1235088);
});

test('pickStream: 空列表不炸', () => {
  assert.equal(pickStream([], 'auto').stream, null);
});

test('enumerateImages 取不带 tplv 缩放后缀的原图', () => {
  const imgs = enumerateImages(imageFixture);
  assert.equal(imgs.length, 2);
  assert.equal(imgs[0].url, 'https://example.invalid/img1.jpeg');
  assert.equal(imgs[0].ext, 'jpeg');
  assert.equal(imgs[0].index, 0);
});

// ---------------- feed ----------------

test('describeAweme 抽出常用元信息', () => {
  const m = describeAweme(videoFixture, '7694602355278543542');
  assert.equal(m.author, '元宝✨');
  assert.equal(m.duration_sec, 15.034);
  assert.equal(m.is_image_post, false);
  assert.equal(m.stats.digg, 154000);
  assert.match(m.page_url, /douyin\.com\/video\//);
});

test('isImagePost 区分视频与图集', () => {
  assert.equal(isImagePost(videoFixture), false);
  assert.equal(isImagePost(imageFixture), true);
});

// ---------------- download ----------------

test('verifyAgainstHash: 有 hash 就对，没有就跳过', () => {
  assert.deepEqual(verifyAgainstHash('ABC', null).skipped, true);
  assert.equal(verifyAgainstHash('abc123', 'ABC123').ok, true);
  assert.equal(verifyAgainstHash('abc123', 'deadbeef').ok, false);
});
