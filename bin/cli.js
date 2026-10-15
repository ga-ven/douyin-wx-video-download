#!/usr/bin/env node
/**
 * douyin-wx-video-download —— 命令行入口
 *
 * 抖音 / 微信视频号，两条链路。抖音零配置；视频号需要一个元宝 Cookie。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { download, inspect, detectPlatform } from '../src/index.js';
import { createLogger, createProgress, formatBytes, formatDuration, EXIT, EXIT_BY_CODE } from '../src/util.js';
import { CONFIG_PATH, ENV_COOKIE } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));

const HELP = `
${pkg.name} v${pkg.version}
${pkg.description}

用法
  dwvd <链接|作品id> [选项]

平台
  抖音         https://v.douyin.com/xxxx/  ·  作品 id  ·  分享文案（零配置）
  微信视频号   https://weixin.qq.com/sph/xxxx  ·  sph 短 id（需要元宝 Cookie）

参数
  <链接>              分享短链、网页链接、纯作品 id，或整段分享文案（自动识别平台）

选项
  -o, --out <文件>      指定输出文件路径（图集时作为目录前缀）
  -d, --out-dir <目录>  输出目录，默认当前目录
  -q, --quality <档>    画质偏好，默认 auto
                          auto   抖音：优先 H.264 里码率最高的（兼容性最好）
                                 视频号：优先 H.264 兼容版
                          best   像素最多的档位（抖音通常是 720p H.265）
                          h264   只在 H.264 里挑
                          hevc   只在 H.265 里挑
                          720    按清晰度挑（540 / 720 / 1080 同理）
                          720_1_1  精确指定档位名（仅抖音，视频号没有档位名）
      --best            等价于 -q best
      --h264            等价于 -q h264
      --hevc            等价于 -q hevc
      --template <模板> 文件名模板，默认 "{author}_{title}_{id}"
                        可用占位符：{author} {title} {id} {date}
      --watermarked     下载带水印的方图版（仅抖音，默认下载无水印版）
      --cookie <串>     视频号：腾讯元宝 Cookie；以 @ 开头表示从文件读
      --cookie-file <文件>
                        视频号：从文件读元宝 Cookie
      --info            只看信息与档位表，不下载
      --json            以 JSON 输出结果（便于脚本消费）
      --no-verify       跳过 MD5 完整性校验
      --no-resume       关闭断点续传
      --no-browser      禁用无头浏览器兜底（仅抖音）
      --host <地址>     抖音：只用一个接入点
      --timeout <秒>    单次请求超时，默认 10（视频号默认 15）
      --force           目标文件已存在时覆盖
      --quiet           只输出错误
  -h, --help            显示帮助
  -V, --version         显示版本

视频号凭据（按优先级）
  1) --cookie / --cookie-file
  2) 环境变量 ${ENV_COOKIE}
  3) 配置文件 ${CONFIG_PATH} → {"yuanbaoCookie": "..."}

退出码
  0 成功   2 参数错误   3 链接解析失败   4 接口取数失败   5 下载失败   6 校验失败   7 需要凭据

示例
  dwvd "https://v.douyin.com/9154AvnKE6w/"
  dwvd "https://v.douyin.com/9154AvnKE6w/" -q best -o ./best.mp4
  dwvd "https://weixin.qq.com/sph/A6e7uGh8J8" --cookie-file ./yb.txt -d ./videos
  dwvd 7694602355278543542 --info --json
`;

function parseArgs(argv) {
  const o = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`选项 ${a} 缺少参数`);
      return v;
    };
    switch (a) {
      case '-o': case '--out': o.out = next(); break;
      case '-d': case '--out-dir': o.outDir = next(); break;
      case '-q': case '--quality': o.quality = next(); break;
      case '--best': o.quality = 'best'; break;
      case '--h264': o.quality = 'h264'; break;
      case '--hevc': case '--h265': o.quality = 'hevc'; break;
      case '--template': o.template = next(); break;
      case '--host': o.host = next(); break;
      case '--timeout': o.timeoutSec = Number(next()); break;
      case '--cookie': o.cookie = next(); break;
      case '--cookie-file': o.cookieFile = next(); break;
      case '--platform': o.platform = next(); break;
      case '--watermarked': o.watermarked = true; break;
      case '--info': case '--dry-run': o.infoOnly = true; break;
      case '--json': o.json = true; break;
      case '--no-verify': o.verify = false; break;
      case '--no-resume': o.resume = false; break;
      case '--no-browser': o.allowBrowser = false; break;
      case '--force': o.force = true; break;
      case '--quiet': o.quiet = true; break;
      case '-h': case '--help': o.help = true; break;
      case '-V': case '--version': o.version = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`未知选项 ${a}`);
        o.positional.push(a);
    }
  }
  return o;
}

const PLATFORM_LABEL = { douyin: '抖音', channels: '微信视频号' };

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`参数错误：${e.message}\n`);
    process.exit(EXIT.USAGE);
  }

  if (args.help) { process.stdout.write(HELP); process.exit(EXIT.OK); }
  if (args.version) { process.stdout.write(`${pkg.version}\n`); process.exit(EXIT.OK); }
  if (args.positional.length === 0) {
    process.stdout.write(HELP);
    process.exit(EXIT.USAGE);
  }

  const input = args.positional.join(' ').trim();
  const logger = createLogger({ quiet: args.quiet, json: args.json });
  const timeoutMs = Number.isFinite(args.timeoutSec) ? args.timeoutSec * 1000 : undefined;
  const platform = args.platform || detectPlatform(input) || 'douyin';

  // 只有视频号才需要凭据，抖音链路完全不需要——别让抖音用户被一个无关的报错挡住
  const common = {
    platform,
    cookie: args.cookie ?? null,
    cookieFile: args.cookieFile ?? null,
    host: args.host,
    timeoutMs,
    allowBrowser: args.allowBrowser,
    logger,
  };

  try {
    if (args.infoOnly) {
      logger.step(`解析 ${input}（${PLATFORM_LABEL[platform] || platform}）`);
      const info = await inspect(input, common);
      const payload = {
        id: info.id,
        platform: info.platform,
        source: info.source,
        meta: info.meta,
        streams: info.streams.map((s) => ({
          label: s.label, gear: s.gear, codec: s.codec,
          width: s.width, height: s.height, size: s.size, vmaf: s.vmaf, file_hash: s.file_hash,
        })),
        images: info.images.map((x) => ({ index: x.index + 1, url: x.url })),
      };
      if (args.json) {
        process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      } else {
        printInfo(payload, logger);
      }
      process.exit(EXIT.OK);
    }

    logger.step(`解析 ${input}（${PLATFORM_LABEL[platform] || platform}）`);
    const progress = createProgress({
      enabled: process.stderr.isTTY && !args.json && !args.quiet,
      logger,
    });

    const res = await download(input, {
      ...common,
      out: args.out,
      outDir: args.outDir,
      template: args.template,
      quality: args.quality,
      watermarked: args.watermarked,
      verify: args.verify,
      resume: args.resume,
      force: args.force,
      onProgress: (got, total) => progress.update(got, total ? ` / ${formatBytes(total)}` : ''),
    });
    progress.done();

    if (args.json) {
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    } else {
      const m = res.meta;
      logger.ok(`作品：${m.author ? m.author + ' · ' : ''}${m.title || '(无标题)'}`);
      if (m.duration_sec) logger.info(`时长 ${formatDuration(m.duration_sec)}｜数据源 ${res.source}${res.source_host ? ' (' + res.source_host.replace(/^https?:\/\//, '') + ')' : ''}`);
      if (res.chosen) {
        const size = res.chosen.size ? ` · ${formatBytes(res.chosen.size)}` : '';
        const dim = res.chosen.width && res.chosen.height ? ` · ${res.chosen.width}x${res.chosen.height}` : '';
        logger.info(`档位 ${res.chosen.label} · ${res.chosen.codec}${dim}${size}`);
      }
      for (const f of res.files) {
        let flag = '';
        if (f.skipped) {
          flag = f.same_as_chosen === false ? '已存在·档位不同（--force 可覆盖）' : '已存在·同档位';
        } else if (f.verified === true) flag = 'MD5 ✓';
        else if (f.verified === false) flag = 'MD5 ✗';
        const rel = path.relative(process.cwd(), f.path);
        const shown = rel && !rel.startsWith('..') ? rel : f.path;
        logger.raw(`  ${shown}  ${formatBytes(f.bytes)}${flag ? '  ' + flag : ''}`);
      }
      for (const w of res.warnings || []) logger.warn(w);
    }

    const bad = (res.files || []).some((f) => f.verified === false);
    process.exit(bad ? EXIT.VERIFY_FAILED : EXIT.OK);
  } catch (e) {
    const code = typeof e?.code === 'number' ? e.code : (EXIT_BY_CODE[e?.code] ?? EXIT.GENERIC);
    if (args.json) {
      process.stdout.write(JSON.stringify({ ok: false, error: e.message, code: e?.code ?? code }, null, 2) + '\n');
    } else {
      logger.error(e.message);
    }
    process.exit(code);
  }
}

function printInfo(payload, logger) {
  const m = payload.meta;
  logger.raw('');
  logger.raw(`  平台   ${PLATFORM_LABEL[payload.platform] || payload.platform || '未知'}`);
  logger.raw(`  作品   ${m.title || '(无标题)'}`);
  logger.raw(`  作者   ${m.author || '未知'}`);
  if (m.duration_sec) logger.raw(`  时长   ${formatDuration(m.duration_sec)}`);
  logger.raw(`  数据源 ${payload.source}`);
  logger.raw('');
  if (payload.images.length) {
    logger.raw(`  图集，共 ${payload.images.length} 张`);
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return;
  }
  logger.raw('  档位:');
  logger.raw('    分辨率      编码    体积        档位名      VMAF');
  for (const s of payload.streams) {
    const dim = s.width && s.height ? `${s.width}x${s.height}` : '?';
    logger.raw(`    ${dim.padEnd(11)} ${String(s.codec).padEnd(7)} ${formatBytes(s.size).padEnd(11)} ${String(s.gear || s.label).padEnd(11)} ${s.vmaf ?? ''}`);
  }
  logger.raw('');
}

main();
