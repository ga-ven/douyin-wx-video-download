# douyin-video-download

**零依赖的抖音视频 / 图集下载器。一条 HTTP 请求搞定，免 cookie、免签名、无水印。**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/Node-%3E%3D18.17-339933.svg)](https://nodejs.org)

```bash
node bin/cli.js "https://v.douyin.com/9154AvnKE6w/"
```

不需要装 Python、不需要扫码登录、不需要浏览器插件、不需要 `ffmpeg`。
项目本身**零第三方依赖**，只用 Node 内置模块。

---

## 为什么不用现成方案

| 路线 | 结果 |
| --- | --- |
| 网页版接口 `douyin.com/aweme/v1/web/aweme/detail/` | 403 `Blocked by ArgusSecurityPlugin`，要 a_bogus 签名 + cookie |
| 移动端分享页 `iesdouyin.com/share/video/<id>/` | 页面已经不带视频数据（只剩配置），整条路线失效 |
| 老接口 `/web/api/v2/aweme/iteminfo/` | 返回 200 但 body 为空，早已下线 |
| **抖音 App 客户端 Feed 接口** | ✅ **本项目采用** —— 免 cookie、免签名、毫秒级返回 |

本项目走的是最后一条：**抖音手机客户端自己在用的接口**。调用方是抖音自己的 App，
所以既没有网页版的签名风控，也不需要登录态。

### 实测拿到的档位比网页版多

| 来源 | 分辨率 | 码率 | 体积 | 编码 |
| --- | --- | --- | --- | --- |
| 无头浏览器读网页版 `<video>` | 576x1024 | 620 kb/s | 1.14 MB | h264 |
| **本项目 `play_addr`** | 576x1024 | **1185 kb/s** | 2.37 MB | h264 |
| **本项目 `play_addr_265`** | **720x1280** | 703 kb/s | 1.37 MB | HEVC |

同一支 15 秒视频，网页版只给一份 620 kb/s 的流；客户端接口把**全部 7 个档位**都交出来了。
两个版本都**无水印**（抽帧确认过）。

---

## 特性

- **零依赖** —— 只用 Node 内置模块，clone 下来就能跑
- **免 cookie / 免签名** —— 不用扫码、不用登小号、不用抓 cookie
- **全档位可选** —— `auto` / `best` / `h264` / `hevc` / `720` / `540` / 精确档位名
- **无水印** —— 默认取干净流；带水印的方图版要显式 `--watermarked` 才给
- **图集支持** —— 图文作品自动下载全部原图（取不带 `~tplv-` 缩放后缀的那份）
- **免费完整性校验** —— 接口返回的 `file_hash` 就是文件 MD5，下完自动核对
- **断点续传** —— 网络中断下次接着下，靠 `.part` 临时文件 + Range 请求
- **原子落盘** —— 先写 `.part` 再改名，不会留下「看起来完整」的坏文件
- **多接入点降级** —— 5 个同源域名逐个重试
- **可编程** —— 既能当 CLI 用，也能 `import` 进你自己的项目

---

## 快速开始

需要 **Node >= 18.17**（用到内置 `fetch`）。

```bash
git clone https://github.com/ga-ven/douyin-video-download.git
cd douyin-video-download

# 方式一：直接跑
node bin/cli.js "https://v.douyin.com/9154AvnKE6w/"

# 方式二：装成本地命令
npm link
douyin-video-download "https://v.douyin.com/9154AvnKE6w/"   # 或者短别名 dygrab
```

跑测试：

```bash
npm test                  # 离线单测 + 集成测试，不联网
LIVE=1 npm run test:live  # 在线联调，会真的下载
```

---

## 用法

```
douyin-video-download <链接|作品id> [选项]
```

`<链接>` 可以是抖音分享短链、网页链接、纯数字作品 id，甚至整段「复制链接」文案——
程序会自己从里面把链接和 id 抠出来。链接里的尾部汉字、`&`、空格都不影响。

### 选项

| 选项 | 说明 |
| --- | --- |
| `-o, --out <文件>` | 指定输出文件路径 |
| `-d, --out-dir <目录>` | 输出目录，默认当前目录 |
| `-q, --quality <档>` | 画质偏好，默认 `auto`（见下） |
| `--template <模板>` | 文件名模板，默认 `{author}_{title}_{id}`，可用 `{author} {title} {id} {date}` |
| `--watermarked` | 下载带水印的方图版（默认下无水印版） |
| `--info` | 只看信息和档位表，不下载 |
| `--json` | 以 JSON 输出结果，便于脚本消费 |
| `--no-verify` | 跳过 MD5 校验 |
| `--no-resume` | 关闭断点续传 |
| `--no-browser` | 禁用无头浏览器兜底 |
| `--host <地址>` | 只用某一个接入点 |
| `--timeout <秒>` | 单次请求超时，默认 10 |
| `--force` | 目标文件已存在时覆盖 |
| `--quiet` | 只输出错误 |

退出码：`0` 成功 · `2` 参数错误 · `3` 链接解析失败 · `4` 接口取数失败 · `5` 下载失败 · `6` 校验失败

### 画质偏好 `-q`

| 取值 | 含义 |
| --- | --- |
| `auto`（默认） | 优先 H.264，选其中码率最高的 —— 兼容性最好，微信/剪辑软件都能吃 |
| `best` | 像素最多的档位（通常是 720p H.265） |
| `h264` / `hevc` | 限定编码，再挑最高 |
| `720` / `540` / `1080` | 按清晰度挑；取不超过该高度的最大档，没有就退最低档 |
| `720_1_1` | 精确指定档位名（用 `--info` 可以看到有哪些） |

> **竖屏视频的「多少 P」指短边。** 576x1024 是 540p，720x1280 是 720p —— 本工具按短边判断，
> 不会把 1024 当成「1024p」。

### 例子

```bash
# 先看看有哪些档位
douyin-video-download "https://v.douyin.com/9154AvnKE6w/" --info

# 最高分辨率的备份
douyin-video-download "https://v.douyin.com/9154AvnKE6w/" -q best -o ./archive.mp4

# 批量 + 最高画质，输出成 JSON 给脚本用
douyin-video-download 7694602355278543542 --json -d ./out

# 只拿链接和元信息，做自己的流程
douyin-video-download "https://v.douyin.com/9154AvnKE6w/" --json --info
```

---

## 作为库使用

```js
import { inspect, download } from 'douyin-video-download';

// 只看元信息和档位
const info = await inspect('https://v.douyin.com/9154AvnKE6w/');
console.log(info.meta.author, info.meta.title);
for (const s of info.streams) {
  console.log(s.width, 'x', s.height, s.codec, s.size, s.file_hash);
}

// 下载
const res = await download('https://v.douyin.com/9154AvnKE6w/', {
  outDir: './downloads',
  quality: 'best',
});
console.log(res.files[0].path, res.files[0].md5, res.files[0].verified);
```

完整示例见 [`examples/programmatic.mjs`](./examples/programmatic.mjs)。

导出的东西：

```
download(input, opts)     完整流程：解析 → 取数 → 选档 → 下载 → 校验
inspect(input, opts)      只取元信息与档位表
resolveAwemeId(input)     从任意输入解析出 aweme_id
enumerateStreams(item)    枚举去重后的档位
enumerateImages(item)     枚举图集原图
pickStream(streams, pref) 按偏好挑档
downloadFile(url, dest)   带续传/重试/进度的单文件下载
md5File(path)             算文件 MD5
```

---

## 工作原理

```
分享短链 / 任意输入
   │  resolve.js   跟一次 302，抠出 aweme_id
   ▼
aweme_id
   │  feed.js      GET /aweme/v1/feed/?aweme_id=<id>   带客户端 UA
   ▼
作品 JSON（含全部档位、图集原图、作者、文案、统计数据）
   │  streams.js   按 file_hash 去重 → 按偏好选档
   ▼
已签名的 mp4 直链
   │  download.js  续传下载 → MD5 与 file_hash 核对 → 原子改名
   ▼
本地文件 + .info 结果
```

### 唯一的门槛是 User-Agent

这是整件事的关键，实测过三种情况：

| 请求的 UA | 返回体大小 |
| --- | --- |
| 不带 UA | 60 字节（空壳 JSON） |
| 普通浏览器 UA | 83 字节（空壳 JSON） |
| **`com.ss.android.ugc.aweme/290101 (...)`** | **数百 KB 真实数据** |

HTTP 状态码都是 200。所以判断成功不能只看状态码，得看 body 长度——
本工具用 500 字节作为阈值来识别「被空壳糊弄了」。

### 关于 MD5 校验

接口返回的 `play_addr.file_hash` **就是该文件的 MD5**。下载完成后直接核对，
不一致就报警并以退出码 `6` 结束。这让「下到一半的文件」和「被 CDN 缓存的旧版本」无处藏身。

---

## 常见问题

**Q：为什么 `auto` 默认选 576p 而不是 720p？**
因为那一档是 H.264 且码率最高（1185 kb/s vs 703 kb/s），画质更扎实、兼容性也最好。
想要分辨率就 `-q best`（会给你 720p H.265）。H.265 在部分老播放器、微信内置播放器里可能打不开。

**Q：为什么拿不到 1080P/4K？**
取决于**这条作品本身有没有**那个档位——抖音按上传源和账号权限决定转码档位。
先 `--info` 看档位表，别看别人说「能拿 1080P」就以为所有视频都有。

**Q：同名文件已存在会怎样？**
默认跳过，但会**核对内容**：如果现有文件其实是你选的**另一个档位**，
会明确告诉你是哪一档，并提示加 `--force` 覆盖。跳过不等于校验失败，退出码仍是 0。

**Q：接口哪天被改了怎么办？**
`feed.js` 里写了 5 个同源接入点逐个降级。全挂了还能开无头浏览器兜底
（`--no-browser` 可关掉）。兜底需要 Node >= 22 和本机装有 Chrome，而且慢很多、画质只有 620 kb/s。

**Q：Windows 上 `-d /d/proj/out` 这种 git-bash 路径会出错吗？**
不会。`/d/proj/out` 这类 MSYS 风格路径会在落盘前自动还原成 `D:\proj\out`。
（不加这层处理的话，Node 会把 `/d/...` 当成「当前盘符 + `\d\...`」，
静默在盘根多建一层 `d\` 目录——文件下下来了但位置不对，很难发现。）
非盘符的绝对路径（`/tmp`、`/usr`）和原生路径 `D:\proj\out` 一律原样透传。

**Q：图片作品（图集）怎么处理？**
自动下载全部原图到 `<文件名>_imgs/` 目录，按 `01.jpeg`、`02.jpeg` 编号。
每个 image 的 `url_list` 里有多个 CDN 变体，会挑不带 `~tplv-` 缩放后缀的那份原图。

**Q：要下某个账号的全部作品？**
不支持，这是有意为之。本项目只做单条（视频/图集），保持小而稳。
批量抓主页是另一类需求，涉及分页与风控，建议用
[jiji262/douyin-downloader](https://github.com/jiji262/douyin-downloader)。

---

## 开发

```
bin/cli.js            命令行入口
src/
  index.js            对外 API：inspect / download
  resolve.js          输入 → aweme_id
  feed.js             App Feed 接口客户端（多接入点、重试、空壳识别）
  streams.js          档位枚举、去重、按偏好挑选
  download.js         续传下载、原子落盘、MD5 校验
  browser.js          无头 Chrome 兜底（CDP）
  util.js             日志、进度条、文件名安全化、重试
test/
  unit.test.js        离线单测
  integration.test.js 起本地 mock CDN 跑完整下载编排
  live.test.js        在线联调（默认跳过）
```

约定：保持**零运行时依赖**；新增解析逻辑先补一个 fixture 和一条断言。

---

## 免责声明

本项目仅用于**个人学习、研究与备份自己有权访问的内容**。

- 下载内容的版权归原作者所有，请勿用于商业用途或二次传播。
- 请遵守抖音的用户协议与相关法律法规。
- 请勿高频请求；接口本身有速率限制，滥用可能导致 IP 被限流。
- 使用者对自己的行为负全部责任。

---

## English

A zero-dependency Douyin (抖音) video / image-post downloader for Node.js.
It talks to Douyin's **mobile app feed endpoint**, which needs no cookies and no request
signatures — the only requirement is sending the client User-Agent.

```bash
git clone https://github.com/ga-ven/douyin-video-download.git
cd douyin-video-download
node bin/cli.js "https://v.douyin.com/9154AvnKE6w/" -q best
```

```js
import { download } from 'douyin-video-download';
const res = await download('https://v.douyin.com/9154AvnKE6w/', { quality: 'best' });
```

Downloads are watermark-free, resumable, and verified against the MD5 the API returns.
Run `npm test` for the offline suite. Requires Node >= 18.17.

## License

[MIT](./LICENSE)
