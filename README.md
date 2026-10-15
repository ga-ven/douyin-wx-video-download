# douyin-wx-video-download

**零依赖的中文短视频下载器：抖音 + 微信视频号。**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/Node-%3E%3D18.17-339933.svg)](https://nodejs.org)

```bash
# 抖音：开箱即用，不需要任何配置
node bin/cli.js "https://v.douyin.com/9154AvnKE6w/"

# 微信视频号：需要一次性配置一个「腾讯元宝」Cookie（下面有说明为什么）
node bin/cli.js "https://weixin.qq.com/sph/A6e7uGh8J8" --cookie-file ./yb.txt
```

不需要装 Python、不需要扫码登录、不需要浏览器插件、不需要 `ffmpeg`。
项目本身**零第三方依赖**，只用 Node 内置模块。

---

## 两个平台，两种难度

| 平台 | 输入形态 | 是否需要登录态 | 拿到的内容 |
| --- | --- | --- | --- |
| **抖音** | `https://v.douyin.com/xxxx/` | **不需要** | 全部 7 个档位（含 720p H.265）、无水印、图集 |
| **微信视频号** | `https://weixin.qq.com/sph/xxxx` | **需要元宝 Cookie** | H.264「兼容版」+ H.265「省空间版」、图文作品的图与 BGM |

抖音那条路之所以能免登录，是因为它直接调**抖音手机客户端自己在用的接口**；
视频号那条路绕不开登录态，原因写在[工作原理](#微信视频号为什么绕不开一个-cookie)里，不藏着。

---

## 为什么不用现成方案

### 抖音

| 路线 | 结果 |
| --- | --- |
| 网页版接口 `douyin.com/aweme/v1/web/aweme/detail/` | 403 `Blocked by ArgusSecurityPlugin`，要 a_bogus 签名 + cookie |
| 移动端分享页 `iesdouyin.com/share/video/<id>/` | 页面已经不带视频数据（只剩配置），整条路线失效 |
| 老接口 `/web/api/v2/aweme/iteminfo/` | 返回 200 但 body 为空，早已下线 |
| **抖音 App 客户端 Feed 接口** | ✅ **本项目采用** —— 免 cookie、免签名、毫秒级返回 |

调用方是抖音自己的 App，所以既没有网页版的签名风控，也不需要登录态。

**实测拿到的档位比网页版多**：

| 来源 | 分辨率 | 码率 | 体积 | 编码 |
| --- | --- | --- | --- | --- |
| 无头浏览器读网页版 `<video>` | 576x1024 | 620 kb/s | 1.14 MB | h264 |
| **本项目 `play_addr`** | 576x1024 | **1185 kb/s** | 2.37 MB | h264 |
| **本项目 `play_addr_265`** | **720x1280** | 703 kb/s | 1.37 MB | HEVC |

同一支 15 秒视频，网页版只给一份 620 kb/s 的流；客户端接口把全部档位都交出来了。
两个版本都**无水印**（抽帧确认过）。

### 微信视频号

| 路线 | 结果 |
| --- | --- |
| 分享页 `weixin.qq.com/sph/xxxx` | 302 到一个 SPA 壳，页面上只有封面 + 「可扫码前往微信观看此内容」 |
| 直接调 `finder-preview/api/feed/get_feed_info` 传 `exportId` | 返回 `{"errMsg":{"type":2,"title":"此内容暂时无法播放"}}` —— 没有授权就没有媒体地址 |
| `wx_channels_download` 的本地 MITM 代理 | ✅ 能用，但要装根证书 + 改系统代理 + 开微信 PC 端，重量级 |
| **元宝解析链路** | ✅ **本项目采用** —— 纯 HTTP 两步，不需要改系统设置 |

---

## 特性

- **零依赖** —— 只用 Node 内置模块，clone 下来就能跑
- **平台自动识别** —— 贴链接就行，不用自己说这是哪家的
- **抖音全档位可选** —— `auto` / `best` / `h264` / `hevc` / `720` / `540` / 精确档位名
- **无水印** —— 默认取干净流；带水印的方图版要显式 `--watermarked` 才给
- **图集支持** —— 抖音图文取原图；视频号图文取 `picInfo` 全部原图 + BGM
- **免费完整性校验** —— 抖音接口返回的 `file_hash` 就是文件 MD5，下完自动核对
- **断点续传** —— 网络中断下次接着下，靠 `.part` 临时文件 + Range 请求
- **原子落盘** —— 先写 `.part` 再改名，不会留下「看起来完整」的坏文件
- **多接入点降级** —— 抖音 5 个同源域名逐个重试
- **可编程** —— 既能当 CLI 用，也能 `import` 进你自己的项目

---

## 快速开始

需要 **Node >= 18.17**（用到内置 `fetch`）。

```bash
git clone https://github.com/ga-ven/douyin-wx-video-download.git
cd douyin-wx-video-download

# 方式一：直接跑
node bin/cli.js "https://v.douyin.com/9154AvnKE6w/"

# 方式二：装成本地命令（会得到 dwvd 和 douyin-wx-video-download 两个名字）
npm link
dwvd "https://v.douyin.com/9154AvnKE6w/"
```

---

## 视频号：配一次元宝 Cookie

**这一步只在下载视频号时才需要**，抖音用户可以直接跳过。

### 为什么要配

视频号自己的预览页不返回任何媒体地址（只有封面和一句「可扫码前往微信观看此内容」）。
唯一轻量的取流方式是走腾讯元宝的解析服务，而那个服务**必须带登录 Cookie**。
实测：不带 Cookie → `401 20000 未知错误`；Cookie 无效 → `401 20001 token无效`。

### 怎么拿

1. 浏览器登录 <https://yuanbao.tencent.com>
2. `F12` → **Network** 面板 → 随便点一个 `api/...` 请求
3. 在 **Request Headers** 里找到 `Cookie:`，**整条复制**（必须包含 `hy_` 开头的那几个）

### 怎么给（三种，任选其一）

```bash
# 1) 直接传
dwvd "https://weixin.qq.com/sph/xxxx" --cookie "hy_user=...; hy_token=..."

# 2) 从文件读（推荐，避免 shell 历史里留凭据）
dwvd "https://weixin.qq.com/sph/xxxx" --cookie-file ./yb.txt
dwvd "https://weixin.qq.com/sph/xxxx" --cookie @./yb.txt

# 3) 环境变量 / 配置文件
export YUANBAO_COOKIE="hy_user=...; hy_token=..."
# 或写进 ~/.dwvd.json：
#   {"yuanbaoCookie": "hy_user=...; hy_token=..."}
```

优先级：`--cookie` > `--cookie-file` > `YUANBAO_COOKIE` > `~/.dwvd.json`。

> ⚠️ **Cookie 等于你的登录态，别外传、别提交进 git。** 本项目只在本机内存里用它，
> 不写日志、不上传；出错信息里出现的 Cookie 一律打码。`.gitignore` 已经挡掉了 `*.txt` 和 `yb*`。

---

## 用法

```
dwvd <链接|作品id> [选项]
```

`<链接>` 可以是分享短链、网页链接、裸 id，甚至整段「复制链接」文案——
程序会自己从里面把链接抠出来，并按域名判断这是抖音还是视频号。

### 选项

| 选项 | 说明 |
| --- | --- |
| `-o, --out <文件>` | 指定输出文件路径（图集时作为目录前缀） |
| `-d, --out-dir <目录>` | 输出目录，默认当前目录 |
| `-q, --quality <档>` | 画质偏好，默认 `auto` |
| `--best` / `--h264` / `--hevc` | 等价于 `-q best` / `-q h264` / `-q hevc` |
| `--template <模板>` | 文件名模板，默认 `{author}_{title}_{id}`，可用 `{author} {title} {id} {date}` |
| `--cookie` / `--cookie-file` | 视频号：元宝 Cookie |
| `--platform <平台>` | 强制指定 `douyin` / `channels`（默认自动识别） |
| `--watermarked` | 下载带水印的方图版（仅抖音） |
| `--info` | 只看信息与档位表，不下载 |
| `--json` | 以 JSON 输出结果，便于脚本消费 |
| `--no-verify` | 跳过 MD5 完整性校验 |
| `--no-resume` | 关闭断点续传 |
| `--no-browser` | 禁用无头浏览器兜底（仅抖音） |
| `--host <地址>` | 抖音：只用一个接入点 |
| `--timeout <秒>` | 单次请求超时，默认 10（视频号默认 15） |
| `--force` | 目标文件已存在时覆盖 |
| `--quiet` | 只输出错误 |

退出码：`0` 成功 · `2` 参数错误 · `3` 链接解析失败 · `4` 接口取数失败 · `5` 下载失败 · `6` 校验失败 · `7` 需要凭据

### 画质偏好 `-q`

| 取值 | 抖音 | 视频号 |
| --- | --- | --- |
| `auto`（默认） | 优先 H.264，选其中码率最高的 —— 兼容性最好 | 优先 H.264 兼容版 |
| `best` | 像素最多的档位（通常是 720p H.265） | 有分辨率就取最大；视频号多数不给分辨率，退回 H.264 |
| `h264` / `hevc` | 限定编码，再挑最高 | 限定编码 |
| `720` / `540` / `1080` | 按清晰度挑 | —— |
| `720_1_1` | 精确指定档位名（`--info` 里有） | 不适用 |

> 视频号的 H.264 是**兼容版**、H.265 是**省空间版**，只有两路，
> 而且**没有码率表、没有分辨率、没有 file_hash**——接口就是不给，本项目也不编。

### 例子

```bash
# 先看看有哪些档位
dwvd "https://v.douyin.com/9154AvnKE6w/" --info

# 抖音最高分辨率
dwvd "https://v.douyin.com/9154AvnKE6w/" --best

# 视频号存到指定目录
dwvd "https://weixin.qq.com/sph/A6e7uGh8J8" --cookie-file ./yb.txt -d ./videos

# 输出成 JSON 给脚本用
dwvd "https://v.douyin.com/9154AvnKE6w/" --best --json
```

---

## 作为库使用

```js
import { inspect, download, detectPlatform } from 'douyin-wx-video-download';

detectPlatform('https://weixin.qq.com/sph/A6e7uGh8J8'); // 'channels'

const meta = await inspect('https://v.douyin.com/9154AvnKE6w/');
console.log(meta.platform, meta.id, meta.meta.author);

const res = await download('https://weixin.qq.com/sph/A6e7uGh8J8', {
  cookie: process.env.YUANBAO_COOKIE,
  outDir: './videos',
  quality: 'auto',
});
console.log(res.files[0].path, res.files[0].bytes);
```

可注入 `inspector` / `fetchImpl` 做离线测试，`test/` 下就是这么测的。

---

## 工作原理

### 抖音：客户端 Feed 接口

```
GET https://aweme.snssdk.com/aweme/v1/feed/?aweme_id=<id>
```

**唯一的门槛是 User-Agent**：必须伪装成抖音 App 客户端。同一接口换个 UA 就废了：

| User-Agent | 返回体 |
| --- | --- |
| 浏览器 UA | 83 字节的空壳 |
| 不带 UA | 60 字节 |
| **客户端 UA**（本项目用的） | **~350 KB 完整数据** |

客户端 UA 形如 `com.ss.android.ugc.aweme/290101 (Linux; U; Android 12; zh_CN; ...)`。
`FEED_HOSTS` 里有 5 个同源域名逐个降级，全挂了还能开无头浏览器兜底（慢，约 90s，画质低）。

**档位去重口径**：`play_addr` / `play_addr_h264` / `play_addr_lowbr` 三个 key 指向**同一个文件**
（`file_hash` 相同），`play_addr_265` 是 `bit_rate[0]`，才是真正的 HEVC 版。不去重会数出 7 个档位。

### 微信视频号：为什么绕不开一个 Cookie

```
① POST https://yuanbao.tencent.com/api/weixin/get_parse_result
     body: { type: "video_channel_url", url: <分享链接>, scene: 1 }
     → data.wx_export_id, data.playable_url（query 里带 token 和 eid）

② POST https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info
     body: { baseReq: { generalToken: <token> }, exportId: <eid> }
     Referer 里也要带 token / eid，否则拿不到媒体
     → data.feedInfo.h264VideoInfo.videoUrl / h265VideoInfo.videoUrl
```

第①步就是那个绕不过去的门槛——它是**元宝的接口**，必须有登录态。
第②步拿到的地址可以直接 `fetch` 下载，**视频流本身没有额外加密**
（参考实现的下载逻辑就是 `fetch(url) → blob`，没有解密步骤）。

参考实现：[`ltaoo/wx_channels_download`](https://github.com/ltaoo/wx_channels_download)
的 `internal/workers/sph/worker.js`（MIT）。本项目用 Node 复刻了这条链路，
没有引入它的本地代理 / 根证书 / WASM 解密那套重方案。

### 关于 MD5 校验

抖音接口返回的 `file_hash` **就是文件 MD5**，所以下完能免费核对完整性。
视频号接口**不提供** hash，这种情况本项目会明确跳过校验并提示，而不是假装校验过了。

---

## 常见问题

**Q：为什么视频号非要 Cookie，抖音不要？**
因为抖音的取数入口是它 App 自己在用的公开接口，视频号没有这种入口——
轻量路线只有元宝解析这一条，而那是个需要登录的服务。不想给 Cookie 的话，
只能用 `wx_channels_download` 那种本地 MITM 方案（要装根证书 + 改系统代理）。

**Q：视频号能不能不配 Cookie？**
不能。不配的话一执行就报 `NEED_COOKIE`（退出码 7）并告诉你三种配法，不会静默失败。

**Q：视频号的 Cookie 会过期吗？**
会。过期时报 `20001 token无效`，重新复制一次即可。

**Q：为什么视频号拿不到 1080p / 档位表？**
接口只给 H.264 / H.265 两路，没有码率数组也没有分辨率字段。别信「视频号能下 4K」。

**Q：Windows 上 `-d /d/proj/out` 这种 git-bash 路径会出错吗？**
不会。`/d/proj/out` 这类 MSYS 风格路径会在落盘前自动还原成 `D:\proj\out`。
（不加这层处理的话，Node 会把 `/d/...` 当成「当前盘符 + `\d\...`」，
静默在盘根多建一层 `d\` 目录——文件下下来了但位置不对，很难发现。）
非盘符的绝对路径（`/tmp`、`/usr`）和原生路径一律原样透传。

**Q：同名文件已存在会怎样？**
默认跳过，但会**核对内容**：如果现有文件其实是你选的**另一个档位**，
会明确告诉你是哪一档，并提示加 `--force` 覆盖。跳过不等于校验失败，退出码仍是 0。

**Q：接口哪天被改了怎么办？**
抖音：`src/douyin/feed.js` 里写了 5 个同源接入点逐个降级。
视频号：`src/channels/feed.js` 里两个 endpoint 都提成了一行常量，改起来只有一处。

**Q：要下某个账号的全部作品？**
不支持，这是有意为之。本项目只做单条（视频/图集），保持小而稳。
批量抓主页是另一类需求，涉及分页与风控，抖音用
[jiji262/douyin-downloader](https://github.com/jiji262/douyin-downloader)。

**Q：视频号直播回放能下吗？**
不能。本项目只做普通作品；回放要等微信生成，且往往需要本地捕获那条重路线。

---

## 开发

```
bin/cli.js              命令行入口（平台识别、参数解析）
src/
  index.js              对外 API：inspect / download / detectPlatform，按平台分流
  config.js             元宝 Cookie 的来源解析与打码
  util.js               日志、进度条、文件名安全化、重试、路径归一化
  download.js           续传下载、原子落盘、MD5 校验
  browser.js            抖音兜底：无头 Chrome + CDP
  douyin/               抖音
    resolve.js            输入 → aweme_id
    feed.js               App Feed 客户端（多接入点、重试、空壳识别）
    streams.js            档位枚举、去重、按偏好挑选
  channels/             微信视频号
    resolve.js            分享链接 → sph 短 id
    feed.js               元宝解析 → get_feed_info
    streams.js            feedInfo → streams / images
test/
  unit.test.js          抖音侧离线单测
  channels.test.js      视频号侧离线单测（注入假 fetch）
  integration.test.js   起本地 mock CDN 跑完整下载编排
  live.test.js          在线联调（默认跳过，LIVE=1 开启）
```

约定：保持**零运行时依赖**；新增解析逻辑先补一个 fixture 和一条断言；
视频号那边的测试一律注入 `fetchImpl`，**不要联网**。

```bash
npm test                   # 离线，全绿
LIVE=1 npm run test:live   # 真联网
```

---

## 免责声明

本项目仅用于**个人学习与技术研究**，以及下载你**自己有权访问和保存**的内容。

- 请勿用于批量抓取、二次分发他人作品或任何商业用途。
- 视频号链路会用到你的元宝登录凭据，**请自行保管，不要提交进任何仓库**。
- 使用者应自行遵守抖音、微信视频号及腾讯元宝的服务条款与相关法律法规。
- 因使用本项目产生的一切后果由使用者自行承担。

如果这条链路帮到了你，也请给上游
[`ltaoo/wx_channels_download`](https://github.com/ltaoo/wx_channels_download) 点个 star。

---

## English

**Zero-dependency downloader for Chinese short videos: Douyin + WeChat Channels.**

- **Douyin** — hits the same endpoint the official mobile app uses. No cookie, no signature,
  no watermark, full quality ladder.
- **WeChat Channels** — resolves through Tencent Yuanbao's parse service, which
  **requires your own Yuanbao login cookie**. Pass it via `--cookie`, `--cookie-file`,
  `YUANBAO_COOKIE`, or `~/.dwvd.json`.

```bash
node bin/cli.js "https://v.douyin.com/9154AvnKE6w/"
node bin/cli.js "https://weixin.qq.com/sph/A6e7uGh8J8" --cookie-file ./yb.txt
```

Node >= 18.17. MIT. For personal study only — respect the platforms' terms of service.

---

## License

[MIT](./LICENSE) © ga-ven
