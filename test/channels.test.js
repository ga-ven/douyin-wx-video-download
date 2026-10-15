/**
 * 视频号（微信视频号）链路的离线单测：不联网，全部走注入的 fetch 与 fixture。
 *
 *   node --test test/channels.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractSphId, isBareSphId, SPH_PREVIEW_URL } from '../src/channels/resolve.js';
import {
  parseShareUrl,
  fetchFeedInfo,
  fetchChannelsFeed,
  extractTokenAndEid,
  generateRid,
  ChannelsError,
  ChannelsUnavailableError,
} from '../src/channels/feed.js';
import {
  enumerateChannelsStreams,
  enumerateChannelsImages,
  pickChannelsStream,
  channelsBgmUrl,
  describeChannelsFeed,
  stripSnsVideoFlag,
} from '../src/channels/streams.js';
import { detectPlatform, download } from '../src/index.js';
import { loadCookie, maskCookie, looksLikeYuanbaoCookie } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', n), 'utf-8'));

const parseFixture = fx('channels-parse.json');
const feedFixture = fx('channels-feed.json');
const unavailableFixture = fx('channels-unavailable.json');
const imagesFixture = fx('channels-images.json');

/** 造一个只认识固定路由的假 fetch。响应对象只需要 status / text()。 */
function mockFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    for (const [re, handler] of routes) {
      if (re.test(url)) return handler(url, init);
    }
    throw new Error(`测试没有为这个地址准备响应：${url}`);
  };
  fn.calls = calls;
  return fn;
}

const json = (obj, status = 200) => ({ status, text: async () => JSON.stringify(obj) });

// ---------------- resolve ----------------

test('extractSphId: 分享短链 / 预览页 / 裸 id / 整段文案', () => {
  assert.equal(extractSphId('https://weixin.qq.com/sph/A6e7uGh8J8').sphId, 'A6e7uGh8J8');
  assert.equal(extractSphId('https://channels.weixin.qq.com/finder-preview/pages/sph?id=A6e7uGh8J8').sphId, 'A6e7uGh8J8');
  assert.equal(extractSphId('A6e7uGh8J8').sphId, 'A6e7uGh8J8');
  const shared = '6.69 复制打开抖音，看看【某某】的作品 https://weixin.qq.com/sph/A6e7uGh8J8 11/06 vSL:/';
  assert.equal(extractSphId(shared).sphId, 'A6e7uGh8J8', '分享文案里夹着链接也要认得出来');
  // 解析出来的预览页地址要带上 id
  assert.equal(extractSphId('A6e7uGh8J8').url, `${SPH_PREVIEW_URL}?id=A6e7uGh8J8`);
});

test('extractSphId: 认不出来的输入返回 null', () => {
  assert.equal(extractSphId('https://www.douyin.com/video/123'), null);
  assert.equal(extractSphId(''), null);
  assert.equal(extractSphId('https://example.com/sph/abc'), null, '域名不对不能认');
  assert.equal(extractSphId('123'), null, '纯数字归抖音，不是 sph id');
});

test('isBareSphId 不把纯数字当 sph id', () => {
  assert.equal(isBareSphId('A6e7uGh8J8'), true);
  assert.equal(isBareSphId('7694602355278543542'), false);
  assert.equal(isBareSphId('abc'), false, '太短的不算');
});

// ---------------- 平台路由 ----------------

test('detectPlatform 按域名/形态分流', () => {
  assert.equal(detectPlatform('https://v.douyin.com/9154AvnKE6w/'), 'douyin');
  assert.equal(detectPlatform('https://www.douyin.com/video/7694602355278543542'), 'douyin');
  assert.equal(detectPlatform('7694602355278543542'), 'douyin');
  assert.equal(detectPlatform('https://weixin.qq.com/sph/A6e7uGh8J8'), 'channels');
  assert.equal(detectPlatform('https://channels.weixin.qq.com/finder-preview/pages/sph?id=A6e7uGh8J8'), 'channels');
  assert.equal(detectPlatform('A6e7uGh8J8'), 'channels');
  assert.equal(detectPlatform('随便一段没有链接的话'), null);
});

// ---------------- 元宝解析 ----------------

test('extractTokenAndEid: 从 playable_url 抠 token 与 eid', () => {
  const r = extractTokenAndEid(parseFixture.data.playable_url);
  assert.equal(r.generalToken, 'TESTTOKEN0123456789');
  assert.equal(r.exportId, 'export/UzFfBgAAxMWEBFM6OEyok8zT4DCsIoDrWQYsQCdTa31hAD4Ba1iVs2AqQA');
  assert.deepEqual(extractTokenAndEid(''), { generalToken: '', exportId: '' });
  assert.deepEqual(extractTokenAndEid('not a url'), { generalToken: '', exportId: '' });
});

test('generateRid 形如 <秒级时间戳hex>-<8位hex>', () => {
  const rid = generateRid(1700000000000);
  assert.match(rid, /^[0-9a-f]+-[0-9a-f]{8}$/);
  assert.equal(rid.split('-')[0], Math.floor(1700000000000 / 1000).toString(16));
});

test('parseShareUrl: 成功时带回 token 与 exportId', async () => {
  const fetchImpl = mockFetch([[/get_parse_result/, () => json(parseFixture)]]);
  const r = await parseShareUrl('https://weixin.qq.com/sph/A6e7uGh8J8', { cookie: 'hy_user=x', fetchImpl });
  assert.equal(r.exportId, 'export/UzFfBgAAxMWEBFM6OEyok8zT4DCsIoDrWQYsQCdTa31hAD4Ba1iVs2AqQA');
  assert.equal(r.generalToken, 'TESTTOKEN0123456789');
  // 请求体要是元宝认的那种
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.deepEqual(body, { type: 'video_channel_url', url: 'https://weixin.qq.com/sph/A6e7uGh8J8', scene: 1 });
  assert.match(fetchImpl.calls[0].init.headers.cookie, /hy_user=x/);
});

test('parseShareUrl: 没给 cookie 直接抛 NEED_COOKIE，不发请求', async () => {
  const fetchImpl = mockFetch([]);
  await assert.rejects(
    () => parseShareUrl('https://weixin.qq.com/sph/x', { fetchImpl }),
    (e) => e instanceof ChannelsError && e.code === 'NEED_COOKIE',
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('parseShareUrl: 401/20001 → COOKIE_INVALID（且提示重新登录）', async () => {
  const fetchImpl = mockFetch([[/get_parse_result/, () => json({ error: { code: '20001', message: 'token无效' } }, 401)]]);
  await assert.rejects(
    () => parseShareUrl('https://weixin.qq.com/sph/x', { cookie: 'hy_token=bad', fetchImpl }),
    (e) => e.code === 'COOKIE_INVALID' && /重新登录/.test(e.message),
  );
});

test('parseShareUrl: 401/20000 → COOKIE_INVALID（提示 Cookie 不完整）', async () => {
  const fetchImpl = mockFetch([[/get_parse_result/, () => json({ error: { code: '20000', message: '未知错误' } }, 401)]]);
  await assert.rejects(
    () => parseShareUrl('https://weixin.qq.com/sph/x', { cookie: 'bad', fetchImpl }),
    (e) => e.code === 'COOKIE_INVALID' && /完整/.test(e.message),
  );
});

test('parseShareUrl: 返回里没有 wx_export_id 要报 UPSTREAM', async () => {
  const fetchImpl = mockFetch([[/get_parse_result/, () => json({ data: {} })]]);
  await assert.rejects(
    () => parseShareUrl('https://weixin.qq.com/sph/x', { cookie: 'hy_token=x', fetchImpl }),
    (e) => e.code === 'UPSTREAM',
  );
});

// ---------------- 取 feed ----------------

test('fetchFeedInfo: 成功，且 Referer 里带上了 token 与 eid', async () => {
  const fetchImpl = mockFetch([[/get_feed_info/, () => json(feedFixture)]]);
  const r = await fetchFeedInfo('export/AAA', 'TOK', { fetchImpl });
  assert.equal(r.errCode, 0);
  assert.equal(r.data.feedInfo.h264VideoInfo.videoUrl.length > 0, true);

  const referer = fetchImpl.calls[0].init.headers.Referer;
  assert.match(referer, /token=TOK/, 'Referer 必须带 token，否则拿不到媒体');
  assert.match(referer, /eid=export%2FAAA/);
  assert.match(fetchImpl.calls[0].url, /_rid=[0-9a-f]+-[0-9a-f]{8}/);
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.deepEqual(body, { baseReq: { generalToken: 'TOK' }, exportId: 'export/AAA' });
});

test('fetchFeedInfo: 作品不可播 → ChannelsUnavailableError（不重试）', async () => {
  const fetchImpl = mockFetch([[/get_feed_info/, () => json(unavailableFixture)]]);
  await assert.rejects(
    () => fetchFeedInfo('export/AAA', 'TOK', { fetchImpl, retries: 2 }),
    (e) => e instanceof ChannelsUnavailableError && /无法播放/.test(e.message),
  );
  assert.equal(fetchImpl.calls.length, 1, '这种是业务错误，不该重试');
});

test('fetchFeedInfo: errCode 非 0 报 UPSTREAM', async () => {
  const fetchImpl = mockFetch([[/get_feed_info/, () => json({ errCode: 10086, errMsg: 'boom' })]]);
  await assert.rejects(
    () => fetchFeedInfo('export/AAA', 'TOK', { fetchImpl }),
    (e) => e.code === 'UPSTREAM' && /10086/.test(e.message),
  );
});

test('fetchFeedInfo: 5xx 会重试', async () => {
  let n = 0;
  const fetchImpl = mockFetch([[/get_feed_info/, () => (++n < 3 ? json({}, 503) : json(feedFixture))]]);
  const r = await fetchFeedInfo('export/AAA', 'TOK', { fetchImpl, retries: 3 });
  assert.equal(r.errCode, 0);
  assert.equal(n, 3, '前两次 503 应触发重试');
});

// ---------------- 两步串起来 ----------------

test('fetchChannelsFeed: 解析 → 取 feed 全链路（假 fetch）', async () => {
  const fetchImpl = mockFetch([
    [/get_parse_result/, () => json(parseFixture)],
    [/get_feed_info/, () => json(feedFixture)],
  ]);
  const r = await fetchChannelsFeed('https://weixin.qq.com/sph/A6e7uGh8J8', { cookie: 'hy_token=x', fetchImpl });
  assert.equal(r.sphId, 'A6e7uGh8J8');
  assert.equal(r.exportId, 'export/UzFfBgAAxMWEBFM6OEyok8zT4DCsIoDrWQYsQCdTa31hAD4Ba1iVs2AqQA');
  assert.equal(r.generalToken, 'TESTTOKEN0123456789');
  assert.equal(r.feed.data.feedInfo.description.includes('范丞丞'), true);
  assert.equal(fetchImpl.calls.length, 2);
});

test('fetchChannelsFeed: 认不出的输入报 RESOLVE_FAILED', async () => {
  await assert.rejects(
    () => fetchChannelsFeed('https://www.douyin.com/video/123', { cookie: 'x', fetchImpl: mockFetch([]) }),
    (e) => e.code === 'RESOLVE_FAILED',
  );
});

// ---------------- 档位 ----------------

test('enumerateChannelsStreams: h264 / h265 各一路，videoUrl 兜底不重复', () => {
  const s = enumerateChannelsStreams(feedFixture.data.feedInfo);
  assert.equal(s.length, 2, 'videoUrl 与 h264VideoInfo 是同一个地址，不该出现第三条');
  assert.equal(s[0].codec, 'h264');
  assert.equal(s[0].label, 'H.264 兼容版');
  assert.equal(s[1].codec, 'hevc');
  assert.equal(s[1].label, 'H.265 省空间版');
  // 视频号不给 file_hash / 分辨率，这里必须老实留空，别编
  assert.equal(s[0].file_hash, null);
  assert.equal(s[0].size, null);
  assert.equal(s[0].quality_height, null);
});

test('stripSnsVideoFlag 只去掉 X-snsvideoflag，别动别的参数', () => {
  const url = 'https://finder.video.qq.com/x?encfilekey=K&token=T&X-snsvideoflag=xWT111&idx=1';
  const out = stripSnsVideoFlag(url);
  assert.equal(out.includes('X-snsvideoflag'), false);
  assert.equal(out.includes('encfilekey=K'), true);
  assert.equal(out.includes('idx=1'), true);
  assert.equal(stripSnsVideoFlag('not a url'), 'not a url');
});

test('pickChannelsStream: auto 优先 H.264，hevc 取省流量版', () => {
  const streams = enumerateChannelsStreams(feedFixture.data.feedInfo);
  assert.equal(pickChannelsStream(streams, 'auto').stream.codec, 'h264');
  assert.equal(pickChannelsStream(streams, 'h264').stream.codec, 'h264');
  assert.equal(pickChannelsStream(streams, 'hevc').stream.codec, 'hevc');
  assert.match(pickChannelsStream(streams, 'best').reason, /分辨率/, '没有分辨率时要说明退回了 H.264');
  assert.equal(pickChannelsStream([], 'auto').stream, null);
});

// ---------------- 图文 ----------------

test('enumerateChannelsImages / channelsBgmUrl', () => {
  const fi = imagesFixture.data.feedInfo;
  const imgs = enumerateChannelsImages(fi);
  assert.equal(imgs.length, 3);
  assert.equal(imgs[0].index, 0);
  assert.match(imgs[0].url, /PIC1KEY/);
  assert.match(channelsBgmUrl(fi), /BGMKEY/);
});

test('describeChannelsFeed: 图文作品不带视频流', () => {
  const m = describeChannelsFeed(imagesFixture, 'IMG123456', 'https://channels.weixin.qq.com/x');
  assert.equal(m.platform, 'channels');
  assert.equal(m.is_image_post, true);
  assert.equal(m.image_count, 3);
  assert.equal(m.title.includes('巷子口'), true);
  assert.equal(m.author, '示例摄影号');
});

test('describeChannelsFeed: 视频作品的 meta', () => {
  const m = describeChannelsFeed(feedFixture, 'A6e7uGh8J8', 'https://weixin.qq.com/sph/A6e7uGh8J8');
  assert.equal(m.id, 'A6e7uGh8J8');
  assert.equal(m.platform, 'channels');
  assert.equal(m.author, '小马扎十级磕学家');
  assert.equal(m.is_image_post, false);
  assert.equal(m.duration_sec, null, '预览接口不返回时长，不能编');
  assert.equal(m.created_at, new Date(1791885657 * 1000).toISOString());
  assert.equal(m.location, '南昌市');
  assert.equal(m.stats.like, '688');
  assert.match(m.cover_url, /COVERKEY/);
});

// ---------------- 凭据 ----------------

test('maskCookie 不把整条凭据漏出去', () => {
  const m = maskCookie('hy_user=abcdefghijklmn; hy_token=0123456789abcdef');
  assert.equal(m.includes('abcdefghijklmn'), false);
  assert.match(m, /hy_user=abcd\*\*\*klmn/);
});

test('looksLikeYuanbaoCookie 能识别只贴了设备 cookie 的情况', () => {
  assert.equal(looksLikeYuanbaoCookie('hy_user=x; hy_token=y'), true);
  assert.equal(looksLikeYuanbaoCookie('_qimei_fingerprint=abc'), false);
});

test('loadCookie: 参数 > 环境变量 > 配置文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwvd-cfg-'));
  const cfg = path.join(dir, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ yuanbaoCookie: 'from=config' }));

  assert.equal(loadCookie({ cookie: 'from=arg', configPath: cfg }).cookie, 'from=arg');
  assert.equal(loadCookie({ configPath: cfg }).cookie, 'from=config');
  assert.equal(loadCookie({ configPath: cfg }).from.includes('配置文件'), true);

  const prev = process.env.YUANBAO_COOKIE;
  try {
    process.env.YUANBAO_COOKIE = 'from=env';
    assert.equal(loadCookie({ configPath: cfg }).cookie, 'from=env', '环境变量优先级高于配置文件');
  } finally {
    if (prev === undefined) delete process.env.YUANBAO_COOKIE; else process.env.YUANBAO_COOKIE = prev;
  }

  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadCookie: @文件 写法', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwvd-ck-'));
  const f = path.join(dir, 'yb.txt');
  fs.writeFileSync(f, '  hy_token=from-file\n');
  assert.equal(loadCookie({ cookie: `@${f}` }).cookie, 'hy_token=from-file');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadCookie: required 且找不到时抛 NEED_COOKIE，且带上三种给法', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwvd-none-'));
  const prev = process.env.YUANBAO_COOKIE;
  delete process.env.YUANBAO_COOKIE;
  try {
    assert.throws(
      () => loadCookie({ required: true, configPath: path.join(dir, 'nope.json') }),
      (e) => e.code === 'NEED_COOKIE' && /--cookie/.test(e.message) && /YUANBAO_COOKIE/.test(e.message),
    );
  } finally {
    if (prev !== undefined) process.env.YUANBAO_COOKIE = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------- download() 路由 ----------------

test('download(): 视频号走 pickChannelsStream，且不因为缺 file_hash 报校验失败', async () => {
  const info = {
    id: 'A6e7uGh8J8',
    platform: 'channels',
    source: 'yuanbao',
    source_host: 'channels.weixin.qq.com',
    meta: describeChannelsFeed(feedFixture, 'A6e7uGh8J8', 'https://weixin.qq.com/sph/A6e7uGh8J8'),
    streams: enumerateChannelsStreams(feedFixture.data.feedInfo),
    images: [],
    watermarked: null,
  };
  // 只验证路由与档位选择，不真下：让 downloadFile 立刻失败
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwvd-route-'));
  try {
    await assert.rejects(
      () => download('x', {
        outDir: dir,
        inspector: async () => info,
        verify: true,
        resume: false,
      }),
      /HTTP|fetch|ENOTFOUND|EAI_AGAIN|getaddrinfo/i,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('download(): 视频号的 verified 不会被当成失败（没有 file_hash 时跳过）', async () => {
  // 用一个能被"下载"的本地 CDN 跑一遍完整的图集路径，顺带确认 platforms 字段透传
  const info = {
    id: 'IMG123456',
    platform: 'channels',
    source: 'yuanbao',
    source_host: 'channels.weixin.qq.com',
    meta: {
      id: 'IMG123456', platform: 'channels', author: '测试号', title: '图文测试',
      created_at: null, is_image_post: true, image_count: 0,
    },
    streams: [],
    images: [],
    watermarked: null,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwvd-img-'));
  try {
    await assert.rejects(
      () => download('x', { outDir: dir, inspector: async () => info }),
      /没有解析出任何图片/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
