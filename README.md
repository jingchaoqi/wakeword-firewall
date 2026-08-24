# 唤醒词防火墙 · wakeword-firewall

> 看视频时视频里说了一句「小爱同学」，桌上的手机亮了。

一个 Chrome 扩展，在唤醒词播出去**之前**把它静音掉，
别让视频唤醒你身边的设备。**全程本地推理，零网络请求。**

Block wake words ("小爱同学", "小度小度", "天猫精灵", …) in browser video
before they reach your devices. 100% on-device inference, no network requests.

---

## 目录

- [它怎么做到零延迟](#它怎么做到零延迟)
- [实测数据](#实测数据)
- [环境要求](#环境要求)
- [五分钟先看效果（不用装扩展）](#五分钟先看效果不用装扩展)
- [安装扩展（完整教程）](#安装扩展完整教程)
- [装好之后怎么用](#装好之后怎么用)
- [自定义唤醒词](#自定义唤醒词)
- [打包分发给别人](#打包分发给别人)
- [做不到什么](#做不到什么)
- [出问题了怎么查](#出问题了怎么查)
- [参与贡献](#参与贡献)

---

## 它怎么做到零延迟

不在播放链上做检测——那样必然滞后，等认出唤醒词声音早出去了。
而是**去读播放器的缓冲区**：你现在看到的画面，播放器早在几十秒前
就把对应音频段下载好放在 `SourceBuffer` 里了。

```
拦截 appendBuffer → 解封装(fMP4/WebM) → WebCodecs 解码 → 重采样 16k
    → Worker 里跑唤醒词检测 → 时间戳表 → GainNode 静音（10ms 升余弦升降沿）
```

零延迟，零音画不同步。播放链上只多了一条增益曲线。

## 实测数据

| 指标 | 结果 |
|---|---|
| 真实视频召回 | 9 / 9 处 |
| 合成语料召回 | 94.9%（312 片段，六种声学增强） |
| 误报 | 0 次 / 32 分钟普通中文语音 |
| 扫描速度 | 21x 实时（单核 CPU，int8 量化） |
| 含全片 ASR 复核 | 4.7x 实时 |

判据是「误报 < 0.1 次/小时且召回 > 90%」，两项都过。
测量条件与完整方法见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 环境要求

| | |
|---|---|
| 浏览器 | Chrome 或 Edge **94+**（要用 WebCodecs `AudioDecoder`），建议用最新版 |
| 系统 | macOS / Linux / Windows（WSL）都行 |
| 编引擎需要 | `git`、`cmake`、`python3`，以及能跑 emscripten 的环境 |
| Python 工具链需要 | `python3` + `ffmpeg` |
| 磁盘 | 编译过程约 3 GB，最终产物约 16 MB |

---

## 五分钟先看效果（不用装扩展）

想先确认「它到底认不认得出」，走这条路最快——纯 Python，不用编 WebAssembly。

```bash
git clone https://github.com/jingchaoqi/wakeword-firewall.git
cd wakeword-firewall/p0
./setup.sh          # 装 sherpa-onnx + numpy，下载模型（约 75 MB，来自 GitHub Releases）
```

`setup.sh` 会检查 `ffmpeg` 是否存在。没有的话：

```bash
sudo apt install ffmpeg      # Debian / Ubuntu
brew install ffmpeg          # macOS
```

**扫描一个视频，看看里面有没有唤醒词、在第几秒：**

```bash
python3 scan.py 你的视频.mp4
```

输出长这样：

```
▸ 你的视频.mp4  [11.6s 音频, 扫描 0.6s = 21x 实时]  1 处命中
    1.80s  「小爱同学」  ✓已复核
             静音 0.49–1.69s (1.20s)  精确区间 0.49–1.69s
             上下文: …小爱同学，打开卧室灯…
```

常用参数：

```bash
python3 scan.py 视频目录/                  # 批量扫一个目录
python3 scan.py 视频.mp4 --no-verify       # 只跑一级 KWS，最快
python3 scan.py 视频.mp4 --threshold 0.45  # 收紧阈值，减少误报
python3 scan.py 视频.mp4 --json out.json   # 机器可读输出
```

**直接产出屏蔽后的视频：**

```bash
python3 mute.py 输入.mp4 -o 输出.mp4
```

这一步会完整跑一遍扩展里预扫描要做的事——一级 KWS 找候选、全片 ASR 转写 +
拼音模糊匹配捞近音变体、两路结果合并、按时间戳给音频加增益包络
（10 ms 升降沿防爆音），视频流原样复制。

---

## 安装扩展（完整教程）

一共六步。**只有第 3 步费时间（20–40 分钟），而且一辈子只用做一次。**

### 第 1 步 · 拿到代码

```bash
git clone https://github.com/jingchaoqi/wakeword-firewall.git
cd wakeword-firewall
```

### 第 2 步 · 把扩展装进浏览器

1. 地址栏输入 `chrome://extensions`
2. 打开右上角的**开发者模式**
3. 点**加载已解压的扩展程序**
4. 选中仓库里的 `extension/` 目录

装完会**自动弹出引导页**。后面几步跟着引导页走就行，下面是同一件事的文字版。

> 现在扩展还不能工作——检测引擎还没有。引导页第 1 步会显示「未检测到引擎」。

### 第 3 步 · 编检测引擎（20–40 分钟，一次性）

**这一步没有捷径，原因得说清楚：**

k2-fsa 官方只为语音识别、语音合成、静音检测、说话人分离发布了浏览器版
WebAssembly，**唯独没有关键词检测**（可核对 sherpa-onnx 仓库的
`.github/workflows/wasm-simd-hf-space-*.yaml`，十个里没有 kws）。
npm 包里那份是 `-sNODERAWFS=1` 构建的 Node 专用版，浏览器里一加载就抛
`NODERAWFS is currently only supported on Node.js environment`。

所以只能自己编一次。仓库里有脚本，一条命令：

```bash
./extension/vendor/build-wasm.sh
```

它会依次做四件事：装 emsdk 4.0.23（**别用其它版本**，sherpa 官方指定）、
拉 sherpa-onnx、下载 KWS 模型放进构建目录、编译。

> **CPU 核心少的机器**：脚本里的并行编译可能 OOM，把 `-j8` 调小再跑。
>
> **想把中间产物放别处**：`./extension/vendor/build-wasm.sh /path/to/workdir`，
> 默认是 `~/ww-build`。

编完产物在 `~/ww-build/sherpa-onnx/build-wasm-simd-kws/install/bin/wasm/`：

```
sherpa-onnx-wasm-kws-main.js
sherpa-onnx-wasm-kws-main.wasm
sherpa-onnx-wasm-kws-main.data     # 模型预加载包，可能有也可能没有
```

脚本最后会自动把这三个文件拷进 `extension/vendor/`。

### 第 4 步 · 把引擎交给扩展

**如果第 3 步的脚本跑完了**，引擎已经在 `extension/vendor/` 里了。
回到 `chrome://extensions` 点一下扩展卡片上的**刷新**图标，引导页第 1 步
就会变成「引擎已随扩展内置，无需任何操作」。

**如果你是在另一台机器上编的**，不用重新打包扩展——把那三个文件
**直接拖进引导页第 1 步的虚线框**即可，引擎会存进扩展的本地存储。

### 第 5 步 · 自检

引导页第 2 步点**运行自检**。它会用一段真实音频跑一遍完整检测链路，
确认引擎真的能认出「小爱同学」。

> **这一步需要 `extension/assets/selftest.wav`，仓库里没有**——原素材是一段
> 私人视频里截的，不适合放进公开仓库。自己用任意一段含唤醒词的音频生成：
>
> ```bash
> mkdir -p extension/assets
> ffmpeg -i 你的素材.mp4 -t 3 -ac 1 -ar 16000 -c:a pcm_s16le \
>   extension/assets/selftest.wav
> ```

### 第 6 步 · 兼容性探测

引导页第 3 步。先打开一个视频页（B 站或 YouTube），回到引导页点
**探测当前打开的视频页**。

它在查一件事：这个站点有没有把 `MediaSource` 放进 Worker 里。
如果放了，主线程上的 hook 一个字节也抓不到——**这是唯一可能让整个方案
失效的情况**。探测会明确告诉你结果，不会让你蒙在鼓里。

---

## 装好之后怎么用

打开任意视频页自动生效，不需要任何操作。

**工具栏图标上的徽标**：

| 徽标 | 含义 |
|---|---|
| 数字（青色） | 这个标签页已经静音了几次唤醒词 |
| `—`（红棕色） | **抓不到音频**——DRM、杜比音轨，或播放器把 MSE 放在了 Worker 里 |
| 无 | 这个页面还没有检测到需要处理的音频 |

不会静默失效：抓不到数据时页面上会有提示条。

**点图标打开设置面板**，能调三样东西：

- **总开关** —— 临时关掉
- **静音时长**（默认 0.3 秒）—— 唤醒词之后再多静音多久。
  面板里有实时说明：小于 0.6 秒只静音唤醒词本身，设备不会醒，但视频里紧跟
  其后的指令仍会播出；1–3 秒能挡掉「打开卧室灯」这类短指令；再长几乎能挡住
  所有指令注入，代价是每次命中多切掉一段正常内容。
- **唤醒词表** —— 直接编辑，保存后刷新页面生效

---

## 自定义唤醒词

词表在 `extension/keywords.txt`，也可以在设置面板里直接改。格式是
**拼音 token 序列 + `@显示名`**：

```
x iǎo ài t óng x ué @小爱同学
n ǐ h ǎo x iǎo n à @你好小娜
x iǎo d ù x iǎo d ù @小度小度
t iān m āo j īng l íng @天猫精灵
x iǎo y ì x iǎo y ì @小艺小艺
x iǎo b ù x iǎo b ù @小布小布
x iǎo c ài t óng x ué @小菜/小蔡同学
x iǎo h uài t óng x ué @小坏同学
x iǎo b èi t óng x ué @小被同学
```

每行还能加 `:score` 调加权（越大越容易触发）、`#threshold` 调单条阈值
（越大越难触发）。

**加新词**用 sherpa-onnx 官方的转换工具生成 token 序列：

```bash
pip install sherpa-onnx
sherpa-onnx-cli text2token --help        # 先看一眼参数，--tokens-type 要选带声调的拼音
```

`--tokens` 指向模型目录里的 `tokens.txt`（`p0/setup.sh` 下载的那份就在
`p0/models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/`）。

> 注意后三行「小菜同学」「小坏同学」「小被同学」——这些是**近音变体**。
> 唤醒词检测模型只认它训练过的那条序列，但真实设备的容错度宽得多：
> 视频里说「小菜同学」，你的音箱大概率会醒。变体是长尾的、会随梗变化的，
> 欢迎往词表里补，见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 打包分发给别人

上面第 3、4 步对普通用户还是太重。如果你要把扩展分发出去，先把引擎打进包里，
之后所有用户零配置：

```bash
# 把编好的引擎嵌进扩展包
./extension/tools/embed-engine.sh ~/ww-build/sherpa-onnx/build-wasm-simd-kws/install/bin/wasm

# 出 .zip（传应用商店 / 加载已解压）+ .crx（企业策略部署）
./extension/tools/pack.sh
```

`pack.sh` 会剔掉 `test/`、`tools/` 和所有 `.md`，产物默认落在仓库根目录的
`dist/`。第一次跑会生成 `.pem` 私钥——**它决定扩展 ID，务必保存，且不要提交进仓库**。

> 上架 Chrome 应用商店要注意：**MV3 禁止远程托管代码，wasm 也算**
> （transformers.js 的官方示例就因此被驳回）。引擎必须内置，不能做成运行时下载。

---

## 做不到什么

第一屏就写清楚，省得开无效 issue。

| 场景 | 为什么 |
|---|---|
| **DRM 内容**（Netflix 等） | EME 下 `appendBuffer` 拿到的就是密文，解密在 CDM 内部完成，JS 永远看不到明文样本。结构性无解 |
| **杜比音轨** | E-AC-3，标准 Chrome 构建不带解码器 |
| **WebRTC 通话** | 零缓冲，没有前瞻可用。（直播有 2–5 秒缓冲，对 1.2 秒的唤醒词仍够用） |
| **浏览器之外的一切** | 本地播放器、微信视频、系统提示音、别人手机外放。扩展只有标签页范围的权限 |
| **手机上看视频** | 移动端浏览器基本不支持扩展。本方案保护的是「电脑放视频 → 旁边的手机/音箱被唤醒」 |
| **页面 CSP 禁止 blob: worker** | 检测线程起不来 |
| **没进词表也不够像的变体** | 模糊层靠韵母近邻集合判定，覆盖面取决于这张表 |

以上情况**都会在页面上提示、徽标变 `—`，不会静默失效**。

---

## 出问题了怎么查

**徽标一直是 `—`**
播放器可能把 `MediaSource` 放进了 Worker。在视频页的控制台跑这三行：

```js
document.querySelector('video')?.src        // blob:… → 主线程 MSE，方案成立 ✅
document.querySelector('video')?.srcObject  // MediaSourceHandle → 在 Worker 里 ❌
MediaSource.canConstructInDedicatedWorker   // 仅能力探测，true 不代表站点在用
```

**引导页第 1 步一直显示「未检测到引擎」**
确认 `extension/vendor/` 下有 `sherpa-onnx-wasm.js` 和 `sherpa-onnx-wasm.wasm`，
然后去 `chrome://extensions` 点扩展卡片上的刷新图标重新加载。

**自检报「wasm 运行时缺 KWS 导出」**
胶水和引擎不是同一份构建。确认 `.js` 和 `.wasm` 来自同一次
`build-wasm-simd-kws.sh` 的产物目录。

**自检报「NODERAWFS is currently only supported on Node.js」**
用成 npm 包里的 wasm 了。那份是 Node 专用构建，必须自己编，见第 3 步。

**扫描到了但没静音**
设置面板里确认总开关是开的。另外唤醒词已经播过的那一段是救不回来的——
预扫描要求播放器有前瞻缓冲，刚打开视频的头几秒可能来不及。

**能认出「小爱同学」但认不出「小菜同学」**
这是已知的变体盲区，不是 bug。把变体加进词表即可，见上一节。

---

## 参与贡献

这是个开源项目，最需要帮忙的是**唤醒词表**——变体是长尾的、地域性的、会随梗
变化的，中心化维护不现实。门槛最低、价值最高。

架构说明、开发环境、测试怎么跑、待办清单、以及六个能卡住一整天的技术细节，
全在 **[CONTRIBUTING.md](CONTRIBUTING.md)**。

## 致谢

检测引擎基于 [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)（Apache-2.0），
模型为 sherpa-onnx-kws-zipformer-wenetspeech-3.3M（Apache-2.0）。

## 许可

Apache-2.0
