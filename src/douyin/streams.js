/**
 * 从作品对象里枚举所有可下载的流（视频档位 / 图集原图），以及按偏好挑选。
 *
 * 抖音一条视频通常同时给好几份编码，实测（2026-10）：
 *   play_addr / play_addr_h264 / play_addr_lowbr  -> 同一个文件（file_hash 相同），h264
 *   play_addr_265                                 -> 与 bit_rate[0] 同文件，HEVC
 *   bit_rate[]                                    -> 其余 HEVC 档位
 *   download_addr                                 -> 方图 + 带水印，永远不选
 *
 * 所以必须先按 file_hash 去重，否则用户会看到一堆重复项。
 */

const DEFINITION_RANK = { '360p': 1, '480p': 2, '540p': 3, '720p': 4, '1080p': 5, '2k': 6, '4k': 7 };

function parseExtra(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

/**
 * 这条流"算多少 P"。
 *
 * 注意：竖屏视频（1080x1920 那种）标称 720p 指的是**短边**，
 * 所以不能直接拿 height 比 —— 否则 576x1024 会被当成"1024p"。
 * 优先用接口给的 definition，没有就取短边。
 */
function qualityHeight(addr, extra) {
  const def = extra?.definition;
  if (def) {
    const m = String(def).match(/(\d{3,4})/);
    if (m) return Number(m[1]);
  }
  const w = addr.width || 0;
  const h = addr.height || 0;
  if (!w || !h) return 0;
  return Math.min(w, h);
}

function normalizeAddr(addr, { codec, label, gear, extra }) {
  if (!addr || !Array.isArray(addr.url_list) || addr.url_list.length === 0) return null;
  return {
    url: addr.url_list[0],
    all_urls: addr.url_list,
    width: addr.width || 0,
    height: addr.height || 0,
    quality_height: qualityHeight(addr, extra),
    size: addr.data_size || 0,
    file_hash: addr.file_hash || null,
    codec,
    label,
    gear: gear || null,
    definition: extra?.definition || null,
    vmaf: extra?.u_vmaf ?? null,
  };
}

/**
 * 用 file_hash 去重（没有 hash 时退化成 尺寸+体积+编码）。
 *
 * 同一个文件可能以多种身份出现：`play_addr_265` 和 `bit_rate[0]` 是同一份，
 * 但后者带着 gear_name / definition / vmaf 这些**更有用的元信息**。
 * 所以不能简单地"先到先得"，要按信息量打分，留信息最全的那条。
 */
function score(s) {
  let n = 0;
  if (s.gear) n += 4;
  if (s.definition) n += 2;
  if (s.vmaf != null) n += 2;
  if (s.codec === 'h264') n += 1; // 同分时优先 h264（兼容性更好）
  return n;
}

function dedupe(list) {
  const seen = new Map();
  for (const s of list) {
    if (!s) continue;
    const key = s.file_hash || `${s.width}x${s.height}|${s.size}|${s.codec}`;
    const prev = seen.get(key);
    if (!prev || score(s) > score(prev)) seen.set(key, s);
  }
  return [...seen.values()];
}

/**
 * @returns {Array} 去重后的候选流，体积降序
 */
export function enumerateStreams(item) {
  const v = item?.video || {};
  if (item && Array.isArray(item.images) && item.images.length) return [];

  const out = [];
  out.push(normalizeAddr(v.play_addr, { codec: 'h264', label: '默认流', extra: null }));
  out.push(normalizeAddr(v.play_addr_h264, { codec: 'h264', label: 'H.264 专用流', extra: null }));
  out.push(normalizeAddr(v.play_addr_lowbr, { codec: 'h264', label: '低码率流', extra: null }));
  out.push(normalizeAddr(v.play_addr_265, { codec: 'hevc', label: 'H.265 最高清', extra: null }));

  for (const b of v.bit_rate || []) {
    const extra = parseExtra(b.video_extra);
    out.push(normalizeAddr(b.play_addr, {
      codec: b.is_h265 ? 'hevc' : 'h264',
      label: b.gear_name ? `${b.gear_name}${b.is_h265 ? '' : ' · h264'}` : 'bit_rate',
      gear: b.gear_name,
      extra,
    }));
  }

  const streams = dedupe(out);
  streams.sort((a, b) => (b.width * b.height - a.width * a.height) || (b.size - a.size));
  return streams;
}

/** 带水印的那份单独暴露出来，默认不选，但允许用户显式要。 */
export function watermarkedStream(item) {
  return normalizeAddr(item?.video?.download_addr, { codec: 'h264', label: '带水印', extra: null });
}

/**
 * 图集原图。抖音每个 image 给多个 CDN 变体，
 * 不带 `~tplv-` 缩放后缀的那个才是原图。
 */
export function enumerateImages(item) {
  const imgs = Array.isArray(item?.images) ? item.images : [];
  return imgs.map((img, i) => {
    const urls = Array.isArray(img?.url_list) ? img.url_list : [];
    const original = urls.find((u) => !/~tplv-/.test(u)) || urls[urls.length - 1] || urls[0] || '';
    const probe = original || urls[0] || '';
    const m = probe.match(/\.(jpe?g|png|webp|heic)(?:\?|$)/i);
    return {
      index: i,
      url: original,
      all_urls: urls,
      ext: (m ? m[1] : 'jpeg').toLowerCase().replace('jpg', 'jpeg'),
      width: img?.width || 0,
      height: img?.height || 0,
    };
  }).filter((x) => x.url);
}

/**
 * 按偏好挑一条流。
 *
 * preference:
 *   'auto'  优先 h264（兼容性好），其中挑码率最高    —— 默认
 *   'best'  挑像素最多，同像素挑码率最高
 *   'h264' / 'hevc'  指定编码后按像素和码率挑最高
 *   '720' / '1080' / '540p'  按清晰度挑（取不超过该高度的最大档；都没有就取最接近的）
 *   '720_1_1'  精确匹配 gear_name
 *
 * @returns {{ stream: object|null, reason: string }}
 */
export function pickStream(streams, preference = 'auto') {
  if (!streams || streams.length === 0) return { stream: null, reason: '没有可用档位' };
  const pref = String(preference || 'auto').toLowerCase();

  const byBitrate = (a, b) => (b.size || 0) - (a.size || 0) || (b.width * b.height - a.width * a.height);
  const byPixels = (a, b) => (b.width * b.height - a.width * a.height) || (b.size - a.size);

  if (pref === 'best') {
    return { stream: [...streams].sort(byPixels)[0], reason: 'best：像素最多的档位' };
  }

  if (pref === 'h264' || pref === 'hevc') {
    const pool = streams.filter((s) => s.codec === pref);
    if (pool.length) return { stream: [...pool].sort(byPixels)[0], reason: `指定编码 ${pref}` };
  }

  const exact = streams.find((s) => s.gear && s.gear.toLowerCase() === pref);
  if (exact) return { stream: exact, reason: `精确匹配档位 ${pref}` };

  const m = pref.match(/^(\d{3,4})p?$/);
  if (m) {
    const want = Number(m[1]);
    // 按"算多少 P"排，不是按 height —— 竖屏短边才是标称值
    const sorted = [...streams].sort((a, b) => (a.quality_height || 0) - (b.quality_height || 0));
    const notAbove = sorted.filter((s) => s.quality_height && s.quality_height <= want);
    if (notAbove.length) {
      const h = notAbove[notAbove.length - 1].quality_height;
      const same = notAbove.filter((s) => s.quality_height === h).sort(byPixels);
      const best = same.find((s) => s.codec === 'h264') || same[0];
      return { stream: best, reason: `按 ${want}p 挑，命中 ${best.width}x${best.height} / ${best.codec}` };
    }
    return { stream: sorted[0], reason: `没有 ≤${want}p 的档位，退回最低的 ${sorted[0].width}x${sorted[0].height}` };
  }

  // auto
  const h264 = streams.filter((s) => s.codec === 'h264');
  if (h264.length) {
    return { stream: [...h264].sort(byBitrate)[0], reason: 'auto：优先 h264，选其中码率最高的' };
  }
  return { stream: [...streams].sort(byPixels)[0], reason: 'auto：没有 h264 档，退回像素最多的' };
}

/** 给 CLI 打印用的档位表 */
export function describeStreams(streams) {
  return streams.map((s) => ({
    gear: s.gear,
    codec: s.codec,
    width: s.width,
    height: s.height,
    quality_height: s.quality_height,
    size: s.size,
    vmaf: s.vmaf,
    file_hash: s.file_hash,
  }));
}
