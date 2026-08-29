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
- [增减屏蔽词](#增减屏蔽词)
- [屏蔽词的边界](#屏蔽词的边界)
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
    → offscreen 文档里的 Worker 跑检测 → 时间戳表 → GainNode 静音（10ms 升余弦升降沿）
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

> **不想自己编？** [Releases](https://github.com/jingchaoqi/wakeword-firewall/releases)
> 里的 zip 引擎已内置，下载解压就能加载，跳过第 3–5 步。
> 那个包由 GitHub Actions 编出来，流程和下面完全一致。

### 第 3 步 · 编检测引擎（20–40 分钟，一次性）

**一条命令走完全流程**（编引擎 → 取模型和自检素材 → 打进包 → 出 zip），
每一步都会跳过已经完成的：

```bash
./extension/tools/build-all.sh
```

只想把本地的 `extension/` 弄成可加载状态、不要 zip：`BUILD_ONLY=1 ./extension/tools/build-all.sh`

下面是分步版，想看清楚每步在干什么再往下读。



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

> **第一次跑要先准备自检素材**（仓库里不带二进制）：
>
> ```bash
> ./extension/tools/fetch-models.sh
> ```
>
> 它会从 sherpa-onnx 官方模型包（Apache-2.0，可再分发）取一段测试音频放到
> `extension/assets/`，顺便把 `extension/models/` 也准备好（引擎不带 `.data`
> 预加载包时要用）。这段音频认的是「文森特卡索」而不是唤醒词——自检要验的是
> 引擎链路通不通，用哪个词无所谓。想换成自己录的「小爱同学」，替换
> `selftest.wav` 并删掉同目录的 `selftest.json` 即可。

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

## 增减屏蔽词

词表存在 `extension/keywords.txt`，装好之后在**工具栏图标 → 设置面板**里改，
不用碰文件。每行的格式是**拼音 token 序列 + `@显示名`**：

```
x iǎo ài t óng x ué @小爱同学
n ǐ h ǎo x iǎo n à @你好小娜
x iǎo d ù x iǎo d ù @小度小度
```

声母和**带声调**的韵母分开写。这不是给人手写的格式——所以下面这些都不用你写。

### 加词

打开设置面板，在「唤醒词表」上方的输入框里**直接输中文**，回车或点「添加」。

扩展本地把中文转成 token 序列追加进词表，并把转换结果显示出来给你核对：

```
已加入「天猫精灵」→ t iān m āo j īng l íng
```

再点「**保存词表**」，然后**刷新视频页**才对新命中生效。

转换全程离线，不联网，覆盖 20840 个汉字（含繁体）。转不了的字会指名道姓告诉你
是哪个、为什么。

### 删词

设置面板的词表框就是纯文本，**删掉那一行、点「保存词表」、刷新页面**，就没了。

**想恢复出厂词表**：把框里内容**全部清空**再保存。扩展检测到自定义词表为空
就会回落到内置的 `keywords.txt`。

### 微调灵敏度

每行末尾可以挂两个可选后缀：

| 后缀 | 作用 | 例 |
|---|---|---|
| `:score` | 加权，越大越容易触发 | `x iǎo ài t óng x ué :2.5 @小爱同学` |
| `#threshold` | 单条阈值，越大越难触发 | `r uò q í #0.4 @若琪` |

两字词容易被正常语音蹭中，用 `#threshold` 收紧；四字词一般不用动。
全局默认是 `score 2.0` / `threshold 0.25`。

> **注意别把整行注释留在词表框里。** 引擎按 `#` 切阈值，`# 这是注释` 这样的整行
> 会让它解析失败。扩展在送进引擎前会自动剔除，你自己写脚本生成词表时要留意。

### 命令行生成（可选）

不想开浏览器的话，官方工具也能生成同样的 token 行：

```bash
pip install sherpa-onnx
sherpa-onnx-cli text2token --help        # --tokens-type 要选带声调的拼音
```

---

## 屏蔽词的边界

**模型不需要动。** sherpa-onnx 的 KWS 是开放词表的：词表在运行时编译成前缀树去
匹配解码格，加什么词都不用重新训练。词条数量也不是瓶颈——实测 1 条和 1001 条
的推理速度没有差别（都是 8 秒音频 0.21 秒跑完）。

所以「任何汉语词汇」这句话**基本成立**，但有四条边界，其中第一条会实际咬人。

### 1. 多音字取默认读音，而且是静默错的 ⚠️

拼音表是**按字**存的，一个字只留一个读音，没有词级消歧。于是：

```
重庆  →  zh òng q ìng     ✗  应该是 ch óng q ìng
银行  →  y ín  x íng      ✗  应该是 y ín  h áng
```

转错了**不报错**，只是永远匹配不上——你以为加成功了，实际是条死词。

**补救**：转换结果就显示在你眼前，觉得读音不对就直接在词表框里改那一行的 token，
格式是「声母 空格 带声调韵母」，改完保存即可。同一个词也可以写多行覆盖多种读法，
`@` 后面的显示名写成一样的就行。

### 2. 只能是这 194 个 token 拼得出的音

模型的 token 表是普通话的 194 个声母 + 带声调韵母，覆盖 1339 种音节。

- ✅ 中文唤醒词都没问题：小爱同学 / 天猫精灵 / 小度小度 / 你好问问 / 叮咚叮咚 / 若琪
- ❌ **外语唤醒词加不了**：`Hey Siri`、`OK Google`、`Alexa` —— 拼音表里没有拉丁字母
- ❌ 方言、外来音同理

CJK 基本区 20902 个汉字里，转不出来的只有 62 个：

```
乼兙兡兯呣哘嗧嚡垊壭夐尡忄恷慐懳抣掵掹揼敻桛椦橵橺櫵欟氞氵潈瀮炞烪焸煷燝爳
瓧瓰瓱瓼甅硘穃穝籖粌粏繧罀脌螁螩裄詗诇鎆鏲鑦閖鮘鵤
```

全是和制汉字、偏旁部首（氵、忄）和生僻异体字，没有一个是能说出口的词。

### 3. 加的是「一个确切读音」，不是「这个词」

加了「小爱同学」，视频里念成「小**菜**同学」「小**坏**同学」是拦不住的。这是 KWS
的机制决定的，调阈值没用（实测 threshold 从 0.25 降到 0.02，命中数只在 3–4 之间挪）。

要覆盖变体只能把变体也加进词表——内置词表最后三行「小菜/小蔡同学」「小坏同学」
「小被同学」就是干这个的。真实设备的容错度比模型宽得多：视频里说「小菜同学」，
你的音箱大概率会醒，所以这些变体值得补。变体是长尾的、会随梗变化的，
欢迎提 PR，见 [CONTRIBUTING.md](CONTRIBUTING.md)。

### 4. 短词误报风险高

两字词只有两个音节，被正常语音蹭中的概率明显高于四字词。**四字词最稳。**
非要加短词就用上面的 `#threshold` 收紧。

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

引擎不在时它会**拒绝打包**并告诉你该跑什么。否则会产出一个看着正常、装上却
完全不工作的 104 KB zip（干净 clone 之后直接跑就会踩到）。确实要打不含引擎的
包用 `--allow-no-engine`。

**CI 也能出包**。仓库里带了一份现成的 workflow，装上即可：

```bash
mkdir -p .github/workflows
cp build/github-actions-build.yml .github/workflows/build.yml
git add .github/workflows/build.yml && git commit -m "加 CI 构建" && git push
```

（放在 `build/` 而不是直接就位，是因为创建 workflow 需要 token 的 `workflow`
权限，当初协助提交的会话没有。）

装上之后：打 `v*` tag 自动编译并发 Release，手动触发（workflow_dispatch）
则把 zip 挂在 Actions 产物里。emsdk 和 sherpa 的构建走 `actions/cache`，
命中时几分钟就能出包。

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
| **没进词表的近音变体** | 模型只认词表里那条确切读音，见[屏蔽词的边界](#屏蔽词的边界) |
| **非普通话的唤醒词**（Hey Siri 等） | 模型的 token 表是 194 个普通话声母/韵母，拼不出外语音 |

前四种**都会在页面上提示、徽标变 `—`，不会静默失效**。

最后两种是**静默的**——防护正常跑着，只是这个词不在它认识的范围里，页面上
不会有任何提示。这也是[屏蔽词的边界](#屏蔽词的边界)那一节值得读完的原因。

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
