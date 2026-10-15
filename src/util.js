/**
 * 通用工具：日志、字节格式化、文件名安全化、重试。
 */

export const EXIT = {
  OK: 0,
  GENERIC: 1,
  USAGE: 2,
  RESOLVE_FAILED: 3,
  FETCH_FAILED: 4,
  DOWNLOAD_FAILED: 5,
  VERIFY_FAILED: 6,
  NEED_COOKIE: 7,
};

/** 业务错误码（字符串）→ 进程退出码。 */
export const EXIT_BY_CODE = {
  RESOLVE_FAILED: 3,
  NEED_COOKIE: 7,
  COOKIE_INVALID: 7,
  FEED_UNAVAILABLE: 4,
  UPSTREAM: 4,
  TIMEOUT: 4,
  NETWORK: 4,
  CHANNELS_ERROR: 4,
  USAGE: 2,
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 把 git-bash / MSYS2 风格路径还原成 Windows 原生路径。
 *
 * `-d /d/proj/out` 这种写法在 bash 里很自然，但 MSYS 的自动转换并不总是生效
 * （实测本机就没转），于是 `/d/proj/out` 会被 Node 当成「当前盘符 + \d\proj\out」，
 * 静默在 D: 底下多出一层 `d\` 目录 —— 不报错、文件也确实下下来了，只是位置不对，
 * 非常难发现。这里统一在落盘前归一化一次。
 *
 * 只认 `/<单字母>/...`（也就是挂载盘符）这一种形状；`/tmp`、`/usr/bin` 之类
 * 保持原样，交给 Node 自己处理。
 */
export function toNativePath(p) {
  const s = String(p ?? '');
  if (process.platform !== 'win32') return s;
  const m = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(s);
  if (!m) return s;
  const drive = m[1].toUpperCase();
  const rest = (m[2] || '').replace(/\//g, '\\');
  return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
}

export function formatBytes(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '?';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 2)} ${units[i]}`;
}

export function formatDuration(sec) {
  if (!sec && sec !== 0) return '?';
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * 把任意标题变成各平台都能落盘的文件名主干。
 * 处理：非法字符、Windows 保留名、结尾点/空格、超长、全空。
 */
export function sanitizeFilename(name, { maxLen = 80, fallback = 'douyin' } = {}) {
  let s = String(name ?? '')
    .replace(ILLEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows 不允许结尾是点或空格
    .replace(/[. ]+$/, '')
    .trim();

  if (s.length > maxLen) {
    // 按字符（而非字节）截断，避免切断代理对
    s = [...s].slice(0, maxLen).join('').replace(/[. ]+$/, '').trim();
  }
  if (!s) s = fallback;
  if (RESERVED.test(s)) s = `_${s}`;
  return s;
}

const PAIRS = { ')': '(', '）': '（', ']': '[', '】': '【', '}': '{', '》': '《', '>': '<' };
const OPENERS = new Set(Object.values(PAIRS));

/**
 * 截断后常留下一个没闭合的左括号（"…（无不良引导，审核"），
 * 看着很脏。这里找到最后一个没配对的左括号，从它前面切掉。
 */
export function trimUnbalancedTail(s) {
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (OPENERS.has(c)) stack.push(i);
    else if (PAIRS[c] && stack.length && s[stack[stack.length - 1]] === PAIRS[c]) stack.pop();
  }
  if (stack.length === 0) return s;
  const cut = stack[0];
  return cut > 0 ? s.slice(0, cut).replace(/[\s、,，。:：;；\-_]+$/, '') : s;
}

/**
 * 超长时截断，但保住结尾的 tail（通常是 aweme_id + 扩展名）。
 * 从尾部硬截会把 id 切掉，那样两条不同的视频就可能撞名。
 */
export function truncateKeepingTail(s, maxLen, tail = '') {
  const chars = [...s];
  if (chars.length <= maxLen) return s;
  const tailChars = [...tail];
  const budget = maxLen - tailChars.length - 1;
  if (budget <= 0) return tailChars.slice(-maxLen).join('');
  return `${chars.slice(0, budget).join('').replace(/[. ]+$/, '')}_${tailChars.join('')}`;
}

/**
 * 按模板生成文件名。可选占位符: {author} {title} {id} {date}
 *
 * id 在抖音那边是 aweme_id、视频号那边是 sph 短 id，统一叫 id；
 * `awemeId` 保留为旧字段名的兼容别名。
 */
export function buildFilename({ author, title, id, awemeId, date }, { template, maxLen = 100, ext = 'mp4' } = {}) {
  // 每个占位符单独清洗 + 单独修括号，避免"整串修括号"把 id 一起切掉
  const cleanPart = (raw, limit, fallback) => trimUnbalancedTail(sanitizeFilename(raw, { maxLen: limit, fallback }));
  const safe = {
    author: cleanPart(author, 24, 'unknown'),
    title: cleanPart(title, 40, 'video'),
    id: String(id ?? awemeId ?? ''),
    date: date || '',
  };

  const tpl = template || '{author}_{title}_{id}';
  const base = tpl.replace(/\{(author|title|id|date)\}/g, (_, k) => safe[k]);

  // 模板里没有 {id} 时，构不出 id 尾巴，就退回整串兜底修括号
  const trimmed = tpl.includes('{id}') ? base : trimUnbalancedTail(base);
  const final = truncateKeepingTail(trimmed, maxLen, tpl.includes('{id}') ? safe.id : '');

  return `${sanitizeFilename(final, { maxLen: maxLen + 40, fallback: safe.id || 'douyin' })}.${ext}`;
}

/**
 * 带退避的重试。fn 返回 Promise，抛错即重试。
 */
export async function withRetry(fn, { retries = 2, delay = 800, factor = 2, onRetry } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      if (attempt === retries) break;
      const wait = delay * Math.pow(factor, attempt);
      if (onRetry) onRetry(e, attempt + 1, wait);
      await sleep(wait);
    }
  }
  throw lastErr;
}

const COLORS = {
  reset: '\u001b[0m', dim: '\u001b[2m', red: '\u001b[31m',
  green: '\u001b[32m', yellow: '\u001b[33m', cyan: '\u001b[36m', bold: '\u001b[1m',
};

/**
 * 极简 logger。quiet 只留错误；json 模式下把人类可读输出全部静音，
 * 只把结构化结果写 stdout，方便管道消费。
 */
export function createLogger({ quiet = false, json = false, color = process.stderr.isTTY } = {}) {
  const paint = (c, s) => (color ? COLORS[c] + s + COLORS.reset : s);
  const human = !json && !quiet;

  return {
    json,
    step: (msg) => human && process.stderr.write(`${paint('cyan', '›')} ${msg}\n`),
    info: (msg) => human && process.stderr.write(`  ${paint('dim', msg)}\n`),
    ok: (msg) => human && process.stderr.write(`${paint('green', '✓')} ${msg}\n`),
    warn: (msg) => !json && process.stderr.write(`${paint('yellow', '!')} ${msg}\n`),
    error: (msg) => process.stderr.write(`${paint('red', '✗')} ${msg}\n`),
    raw: (msg) => process.stderr.write(`${msg}\n`),
    paint,
  };
}

/** 极简进度条，只在 TTY 且非静音时绘制。 */
export function createProgress({ total, label = '', enabled = process.stderr.isTTY, logger } = {}) {
  if (!enabled) return { update() {}, done() {} };
  let last = 0;
  const render = (got, extra = '') => {
    if (total) {
      const pct = Math.min(100, (got / total) * 100);
      const width = 24;
      const filled = Math.round((pct / 100) * width);
      const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
      process.stderr.write(`\r  ${label}${bar} ${pct.toFixed(1)}% ${formatBytes(got)}${extra}   `);
    } else {
      process.stderr.write(`\r  ${label}${formatBytes(got)}${extra}   `);
    }
  };
  return {
    update(got) {
      const now = Date.now();
      if (now - last < 100 && got !== total) return;
      last = now;
      render(got);
    },
    done(extra = '') {
      if (total) render(total, extra);
      process.stderr.write('\n');
    },
  };
}
