/**
 * 配置与凭证。
 *
 * 抖音那条链路不需要任何登录态；但**微信视频号**这条路走不通：
 * 视频号自己的预览页只会显示「可扫码前往微信观看此内容」，取流要借
 * 腾讯元宝的解析服务换一个授权 token，而那个接口必须要登录 Cookie。
 * （实测：不带 Cookie → 401 `20000 未知错误`；带一个无效 token → 401 `20001 token无效`。）
 *
 * 所以这里只做一件事：把元宝 Cookie 从三个地方按优先级找出来。
 *   1. 调用方显式传入（CLI `--cookie` / API `cookie`）
 *   2. 环境变量 `YUANBAO_COOKIE`
 *   3. 配置文件 `~/.dwvd.json` 的 `yuanbaoCookie`
 *
 * 安全约定：Cookie 只在本机内存里传递，不写日志、不外发、不落盘（除非用户自己填进配置文件）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_PATH = path.join(os.homedir(), '.dwvd.json');
export const ENV_COOKIE = 'YUANBAO_COOKIE';
export const ENV_CONFIG = 'DWVD_CONFIG';

/** 读配置文件；不存在或格式不对都返回空对象，不抛错。 */
export function readConfigFile(file = process.env[ENV_CONFIG] || CONFIG_PATH) {
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const json = JSON.parse(raw);
    return json && typeof json === 'object' ? json : {};
  } catch {
    return {};
  }
}

/** 把 Cookie 打码，用于日志/报错，避免整条凭据漏进终端或 CI 日志。 */
export function maskCookie(cookie) {
  if (!cookie) return '';
  const s = String(cookie);
  const keep = (part) => (part.length <= 8 ? part[0] + '***' : part.slice(0, 4) + '***' + part.slice(-4));
  return s
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf('=');
      return i < 0 ? p : `${p.slice(0, i)}=${keep(p.slice(i + 1))}`;
    })
    .join('; ');
}

/** 判断一条 Cookie 里有没有元宝真正的登录凭据（避免用户只贴了设备 cookie）。 */
export function looksLikeYuanbaoCookie(cookie) {
  const s = String(cookie || '');
  // 元宝的登录态以 hy_* 系列为主；只贴 _qimei_* 这类设备指纹是过不了的。
  return /(^|;\s*)hy_[a-z0-9_]+\s*=/i.test(s);
}

/**
 * 解析「元宝 Cookie」。
 *
 * @param {object} o
 *   cookie      直接给的 Cookie 串；以 @ 开头表示从文件读
 *   cookieFile  从文件读
 *   configPath  自定义配置文件路径
 *   required    true 时找不到就抛错（用于视频号链路）
 * @returns {{cookie: string, from: string}} cookie 为空串表示没配；from 说明来源，便于提示用户
 */
export function loadCookie({
  cookie = null,
  cookieFile = null,
  configPath = process.env[ENV_CONFIG] || CONFIG_PATH,
  required = false,
} = {}) {
  let value = '';
  let from = '';

  const fromFile = (p) => {
    try {
      return fs.readFileSync(p, 'utf-8').trim();
    } catch {
      return '';
    }
  };

  if (cookie) {
    value = String(cookie).startsWith('@') ? fromFile(String(cookie).slice(1)) : String(cookie);
    from = '参数';
  }
  if (!value && cookieFile) {
    value = fromFile(cookieFile);
    from = `文件 ${cookieFile}`;
  }
  if (!value && process.env[ENV_COOKIE]) {
    value = process.env[ENV_COOKIE].trim();
    from = `环境变量 ${ENV_COOKIE}`;
  }
  if (!value) {
    const cfg = readConfigFile(configPath);
    if (cfg && typeof cfg.yuanbaoCookie === 'string' && cfg.yuanbaoCookie.trim()) {
      value = cfg.yuanbaoCookie.trim();
      from = `配置文件 ${configPath}`;
    }
  }

  value = value.trim();
  if (required && !value) {
    const e = new Error(
      '视频号需要「腾讯元宝」的登录 Cookie，但没有找到。\n'
      + '  三种给法（任选其一）：\n'
      + `    1) 命令行：--cookie "hy_user=...; hy_token=..."\n`
      + `    2) 环境变量：set ${ENV_COOKIE}=...\n`
      + `    3) 配置文件：${configPath} → {"yuanbaoCookie": "..."}\n`
      + '  怎么拿：浏览器登录 yuanbao.tencent.com，F12 → Network → 任一 api 请求 → 复制完整 Cookie 头。',
    );
    e.code = 'NEED_COOKIE';
    throw e;
  }
  return { cookie: value, from };
}
