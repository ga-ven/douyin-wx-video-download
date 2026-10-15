/**
 * 微信视频号：把 `get_feed_info` 的响应整理成和抖音那边同构的 streams / images。
 *
 * 已验证的字段（对照 ltaoo/wx_channels_download 的查询页 createPresentation()，
 * 并用真实响应核对过 data.feedInfo.authorInfo 等结构）：
 *   data.authorInfo.nickname / headImgUrl
 *   data.feedInfo.description / createtime / coverUrl / picInfo[] / bgmInfo
 *   data.feedInfo.h264VideoInfo.videoUrl   ← 兼容性好的那路
 *   data.feedInfo.h265VideoInfo.videoUrl   ← 更省流量的那路
 *   data.feedInfo.videoUrl                 ← 兜底
 *
 * 与抖音不同，这里**没有码率表**：视频号只给你「哪有」两三个地址，
 * 没有 file_hash 可校验、也没有 VMAF，所以 size/分辨率通常是缺的。
 */

/** 去掉 `X-snsvideoflag` —— 参考实现里「下载原始视频」走的就是这个变体。 */
export function stripSnsVideoFlag(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete('X-snsvideoflag');
    return u.toString();
  } catch {
    return url;
  }
}

function pickUrl(obj) {
  if (!obj || typeof obj !== 'object') return '';
  return String(obj.videoUrl || obj.url || obj.mediaUrl || '').trim();
}

/**
 * 枚举可用档位。同一地址只留一条（h264 与 h265 指向同一个 URL 的情况确实存在）。
 * @returns {Array<{url, raw_url, codec, label, gear, width, height, quality_height, size, file_hash, vmaf, definition}>}
 */
export function enumerateChannelsStreams(feedInfo) {
  const fi = feedInfo || {};
  const out = [];
  const seen = new Set();

  const push = (url, meta) => {
    const u = String(url || '').trim();
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push({
      url: u,
      raw_url: stripSnsVideoFlag(u),
      width: null,
      height: null,
      quality_height: null,
      size: null,
      file_hash: null,
      vmaf: null,
      definition: null,
      ...meta,
    });
  };

  // 带 spec 列表的版本：每档一个地址。字段名按常见几种兜一下。
  const expandSpec = (infoObj, base) => {
    const specs = [infoObj?.spec, infoObj?.specList, infoObj?.specs]
      .find((s) => Array.isArray(s) && s.length);
    if (!specs) return false;
    for (const s of specs) {
      const url = pickUrl(s);
      if (!url) continue;
      const h = Number(s.height) || null;
      const w = Number(s.width) || null;
      push(url, {
        ...base,
        width: w,
        height: h,
        quality_height: h && w ? Math.min(w, h) : (h || null),
        size: Number(s.fileSize || s.size) || null,
        definition: s.definition || null,
        gear: s.gear || null,
      });
    }
    return true;
  };

  const h264 = fi.h264VideoInfo;
  const h265 = fi.h265VideoInfo;

  if (!expandSpec(h264, { codec: 'h264', label: 'H.264 兼容版', gear: 'h264' })) {
    push(pickUrl(h264), { codec: 'h264', label: 'H.264 兼容版', gear: 'h264' });
  }
  if (!expandSpec(h265, { codec: 'hevc', label: 'H.265 省空间版', gear: 'h265' })) {
    push(pickUrl(h265), { codec: 'hevc', label: 'H.265 省空间版', gear: 'h265' });
  }
  push(pickUrl(fi), { codec: 'h264', label: '默认流', gear: null });

  for (const s of out) {
    if (!s.quality_height) {
      s.quality_height = s.height || null;
    }
  }
  return out;
}

/** 图文作品里的图。 */
export function enumerateChannelsImages(feedInfo) {
  const pics = Array.isArray(feedInfo?.picInfo) ? feedInfo.picInfo : [];
  return pics
    .map((p) => String(p?.url || '').trim())
    .filter(Boolean)
    .map((url, index) => ({ index, url, ext: extFromUrl(url) }));
}

function extFromUrl(url) {
  const m = String(url).match(/\.(jpe?g|png|webp|gif)(?:$|\?)/i);
  if (!m) return 'jpg';
  const e = m[1].toLowerCase();
  return e === 'jpeg' ? 'jpg' : e;
}

/** 背景音乐（图集作品才常带，视频作品一般没有）。 */
export function channelsBgmUrl(feedInfo) {
  const b = feedInfo?.bgmInfo || {};
  return String(b.bgmUrl || b.mediaStreamingUrl || '').trim();
}

/**
 * 按偏好挑一路。
 *   auto / best  → 优先 H.264：视频号那两路里 H.264 是「兼容版」，
 *                  H.265 是压得更狠的省流量版，老播放器还可能打不开。
 *   h264         → 只在 H.264 里挑
 *   hevc / h265  → 只在 H.265 里挑
 */
export function pickChannelsStream(streams, quality = 'auto') {
  if (!streams?.length) return { stream: null, reason: '没有可用档位' };
  const q = String(quality || 'auto').toLowerCase();

  const byCodec = (want) => streams.filter((s) => (want === 'hevc'
    ? s.codec === 'hevc'
    : s.codec === 'h264'));

  if (q === 'h264') {
    const l = byCodec('h264');
    if (l.length) return { stream: l[0], reason: '限定 H.264' };
  }
  if (q === 'hevc' || q === 'h265') {
    const l = byCodec('hevc');
    if (l.length) return { stream: l[0], reason: '限定 H.265' };
  }
  if (q === 'best') {
    const known = streams.filter((s) => s.quality_height);
    if (known.length) {
      const top = known.reduce((a, b) => (b.quality_height > a.quality_height ? b : a));
      return { stream: top, reason: '像素最多的档位' };
    }
    // 视频号大多不带分辨率，退回 H.264
    const l = byCodec('h264');
    if (l.length) return { stream: l[0], reason: 'H.264（视频号未提供分辨率，无法比较）' };
  }

  const h264 = byCodec('h264');
  if (h264.length) return { stream: h264[0], reason: '默认优先 H.264（兼容性最好）' };
  return { stream: streams[0], reason: '只有这一路可用' };
}

/** 整理 meta，字段名与抖音那边保持一致。 */
export function describeChannelsFeed(feed, sphId, url) {
  const data = feed?.data || {};
  const fi = data.feedInfo || {};
  const ai = data.authorInfo || {};
  const images = enumerateChannelsImages(fi);
  const streams = enumerateChannelsStreams(fi);

  let createdAt = null;
  const ct = Number(fi.createtime);
  if (Number.isFinite(ct) && ct > 0) createdAt = new Date(ct * 1000).toISOString();

  return {
    id: sphId,
    platform: 'channels',
    author: String(ai.nickname || '').trim(),
    author_avatar: String(ai.headImgUrl || '').trim(),
    title: String(fi.description || '').trim(),
    description: String(fi.description || '').trim(),
    duration_sec: null, // 预览接口不返回时长
    created_at: createdAt,
    is_image_post: streams.length === 0 && images.length > 0,
    image_count: images.length,
    cover_url: String(fi.coverUrl || images[0]?.url || '').trim(),
    bgm_url: channelsBgmUrl(fi),
    page_url: url || '',
    stats: {
      like: fi.likeCountFmt || null,
      fav: fi.favCountFmt || null,
      forward: fi.forwardCountFmt || null,
      comment: fi.commentCountFmt || null,
    },
    location: String(fi.jumpInfo?.wording || '').trim(),
  };
}
