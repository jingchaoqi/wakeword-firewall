# 参与贡献

先看 [README](README.md) 把它跑起来。这份文档讲的是「代码为什么长这样、
现在缺什么、怎么改不会踩坑」。

---

## 目录

- [项目现在在哪](#项目现在在哪)
- [最需要帮忙的三件事](#最需要帮忙的三件事)
- [先理解这个架构为什么长这样](#先理解这个架构为什么长这样)
- [仓库结构](#仓库结构)
- [开发环境](#开发环境)
- [跑测试](#跑测试)
- [两个已经踩过的坑](#两个已经踩过的坑)
- [六个能卡住一整天的技术细节](#六个能卡住一整天的技术细节)
- [待办清单](#待办清单)
- [提 Issue 之前](#提-issue-之前)
- [提 PR 的约定](#提-pr-的约定)

---

## 项目现在在哪

**P0（离线验证）已完成**，结论是这个项目该做——算法侧的不确定性已经清零：
模型认得出、认得准、跑得够快，变体盲区也找到了成本可接受的补法。

剩下的风险全部集中在浏览器媒体栈的工程细节上，那些是可以一条条排查的已知问题。
唯一的例外是 MSE-in-Workers，而它只需要三行代码就能证伪。

| 阶段 | 状态 | 内容 |
|---|---|---|
| P0 | ✅ 完成 | 离线验证：召回 94.9%、误报 0 次/32 分钟、21x 实时，真实视频 9/9 |
| P1 | 🚧 进行中 | 预扫描 MVP。全链路已在真实 Chromium 里跑通（含严格 CSP 页面）；fMP4 解析有单测，但 AAC 解码那一环仍需带 AAC 的 Chrome 验 |
| P2 | 待开始 | 去站点化 + 实时兜底 + 优雅降级 + 上架 |
| P3 | 开放式 | 社区词库、更隐蔽的处理方式、Firefox 版 |

## 最需要帮忙的三件事

**一、往词表里补唤醒词变体 —— 门槛最低，价值最高。**

P0 暴露的最大问题是：能唤醒真实设备的说法，比我们以为的多得多。测试视频里
8 处唤醒词，检测模型只认出 3 处标准的「小爱同学」，「小菜同学」「小坏同学」
「小被同学」一个没抓到——而真实音箱对这些大概率会响应。

变体是长尾的、地域性的、会随梗变化的，中心化维护不现实，但众包很合适。
格式和生成方法见 [README 的自定义唤醒词](README.md#自定义唤醒词)。
**提 PR 时请说明你是在哪台设备上验证过这个变体真的能唤醒它的。**

**二、在更大的真实素材集上复测误报率。**

目前的「0 次 / 32 分钟」是在合成语料上测的。真实视频有背景音乐、多人说话、
压缩失真。**误报是这类插件唯一会致死的问题**——用户被误伤两次就会卸载。

```bash
cd p0 && python3 scan.py 你的素材目录/ --json result.json
```

跑完把 `result.json` 和素材类型（评测/新闻/播客/游戏实况…）一起开个 issue。

**三、把拼音模糊层移植进扩展。**

`p0/fuzzy.py` 那层已经在 Python 侧验证过（变体视频 8/8 全中，且不误伤
「小明同学」「小李同学」），但**还没移植进扩展**——扩展目前只有词表方案
（实测 8 中 7）。这是 P2 的主要待办，需要一份中文拼音表和浏览器端 ASR。

## 先理解这个架构为什么长这样

**死结：检测必然滞后。** 实时 KWS 认出唤醒词时，声音已经播出去了。P0 实测：
唤醒词在 0.64–1.24 秒，KWS 到 1.80 秒才报警，**滞后 0.56 秒**。

如果坚持实时处理，唯一出路是让播放比检测慢一步——缓冲 300–1000 ms 再放出去。
对播客可以，对视频不行：ITU 的音画同步可感知阈值在音频滞后约 45 ms 附近，
300 ms 已经是明显的口型对不上，1 秒就不能看了。

**解法：不要在播放链上检测，去读缓冲区。** 视频有个实时音频流没有的性质——
它是提前下载好的。你现在看到的画面，播放器早在几十秒前就把对应音频段拿到手了，
正躺在 `SourceBuffer` 里等着被播。

把那份缓冲截下来、提前解码、提前跑一遍检测，就拿到了一张时间戳表。剩下的事
只是播到那一刻把音量拉到 0，再拉回来。

这带来三个附带好处，实测都已兑现：

1. **零延迟、零音画不同步** —— 播放链上什么都没插，只有一条 gain 自动化曲线
2. **可以用重得多的判断** —— 离线扫描的时间预算是实时的几十倍。变体检测那一层
   就是靠这个预算才可能存在，实时路径根本跑不起全片 ASR
3. **静音窗口可以算准** —— ASR 字级时间戳给出的精确区间是 1.20 秒；没有它就
   只能用 1.9 秒的固定回退量，白白多切掉 0.7 秒

**关于站点兼容性**，两条已经调研清楚的结论：

- **YouTube 的 SABR 打不到这个方案**。SABR/UMP 改的是取数据的方式，不是喂给
  解码器的格式——UMP 解包必须在页面 JS 里完成，解包结果必须是标准 fMP4/WebM
  才能塞进 `SourceBuffer`。这个方案站在 yt-dlp 被打死的那道防线之后。
- **B 站同样没问题**。点播已全面 DASH（fMP4/.m4s，音视频分离），FLV 已下线；
  直播走 HLS-fMP4。三条路径最终都汇入 `appendBuffer`，一个 hook 通吃。

## 仓库结构

```
extension/              Chrome MV3 扩展本体
  manifest.json         两个 content_scripts：MAIN(hook) + ISOLATED(桥+UI)
  keywords.txt          默认唤醒词表
  src/
    main-world.js       ★ 核心：hook appendBuffer + WebCodecs 解码 + GainNode 静音
    mp4-demux.js        fMP4 解封装（moov/mdhd/esds、moof/tfdt/trun）
    webm-demux.js       WebM 解封装（EBML，有状态，容忍分段边界劈开元素）
    content.js          ISOLATED world 桥接 + 页面提示条
    kws-worker.js       Worker 里跑 sherpa-onnx KWS
    engine-loader.js    引擎加载：优先包内，其次用户自装
    engine-store.js     引擎存储（chrome.storage.local + base64）
    offscreen.html/js   ★ 检测宿主：扩展源，绕开页面 CSP，多标签页共用一个 wasm
    background.js       安装即开引导页；按需创建 offscreen；按标签页/按词记账与徽标
    popup.html/js       设置面板：本页/历史的按词统计、总开关、静音时长、
                        两个提示开关、词表编辑
    welcome.html/js     安装引导页（自动检测 / 拖拽装引擎 / 自检）
    text2token.js       中文 → 模型 token 序列（让用户能直接输中文加词）
    pinyin-data.js      上面那个的数据（20840 字 / 72KB），由 build/ 的脚本生成
    node-shim.js        给 npm 版胶水补的 require("path") 垫片
    ui.css
  vendor/
    sherpa-onnx-kws.js  KWS 的 JS 封装（来自 npm sherpa-onnx，纯 JS，与环境无关）
    build-wasm.sh       编浏览器版 wasm 引擎的脚本
  tools/
    build-all.sh        ★ 一条命令走完全流程，每步都跳过已完成的
    fetch-models.sh     取模型与自检素材（sherpa-onnx 官方发布，Apache-2.0）
    embed-engine.sh     把编好的引擎打进包（分发前跑这一次）
    pack.sh             出 .zip（商店）+ .crx（企业策略）；引擎不在时会拒绝打包
    site-probe.js       站点兼容性探针，粘进控制台跑
  test/
    e2e-selftest.js     ★ 端到端：hook → 解封装 → 解码 → KWS → 实测增益
    mp4-demux-test.js   fMP4 解析单测（28 项，纯 Node，不用浏览器）
    text2token-test.js  中文转 token 单测（31 项，纯 Node，不用浏览器）
    bundled-test.js     引导页：引擎已内置时该自动判定通过
    onboarding-test.js  引导页：引擎未装时该说清楚差什么（自己造这个场景）
    stats-test.js       统计与徽标：按词计数、换页清零、DRM 出叹号（16 项）
    util.js             找浏览器 / 造素材 / 起静态服务
  package.json          只声明测试依赖（playwright）；扩展本身不需要 npm

p0/                     P0 阶段的研究工具链（Python）
  wakeword.py           两级检测核心：KWS 找候选 + ASR 复核给精确时间戳
  scan.py               扫描视频，输出命中时间戳和建议静音区间
  mute.py               把视频处理成屏蔽后的版本（含近音变体检测）
  fuzzy.py              ★ 拼音模糊匹配：抓「小菜同学」这类 KWS 认不出的变体
  corpus.py gen.py      合成测试语料
  tts.py tts2.py
  eval.py sweep2.py     评测与诊断
  breakdown.py
  recall2.py diagnose.py
  setup.sh              装依赖 + 下模型
  keywords.txt

build/                  辅助脚本
  gen-pinyin-data.py    生成 src/pinyin-data.js（需要 pip install pypinyin）
  build-loop.py 等      出网受限环境下编 wasm 用，见下
```

> `build/` 里那几个脚本用于**出网受限**的环境：有些代理会禁掉 GitHub 的
> `/archive/` 打包下载（CMake 的 FetchContent 只会走这个），但普通 `git clone`
> 是通的。`build-loop.py` 的做法是——跑一次构建，只看第一个下载失败的 URL，
> 用 clone 造一个等价包，放到 sherpa 自己的 `possible_file_locations`
> （`$HOME/Downloads`）里，同步哈希，再跑一次。**只处理卡住的那一个**，
> 不递归扫描所有依赖的 URL（openfst 里带着 Hunter 的几百个仓库配置，
> 递归会进无底洞）。
>
> 网络正常的话用不到这些，直接 `build-wasm.sh` 即可。
> 实测在受限环境里 9 轮跑完，产出 12 MB wasm + 13 MB 模型预加载包。
> 用法：`WW_WORK=/tmp/ww-build python3 build/build-loop.py`（路径全部走环境变量，
> 见各脚本头部注释）。

## 数据存在哪

改统计或设置之前先看这张表——三处存储的生命周期不一样，选错了会出微妙的 bug。

| 键 | 存哪 | 活多久 | 内容 |
|---|---|---|---|
| `keywords` `enabled` `muteTail` `showBanner` `showBlind` | `storage.local` | 永久 | 用户设置，面板里能改 |
| `score` `threshold` `muteLead` | `storage.local` | 永久 | 全局灵敏度，**没有 UI**，只能从控制台设（默认 2.0 / 0.25 / 1.55）|
| `statsAll` | `storage.local` | 永久 | 历史累计 `{words:{词:次数}, total, since}` |
| `tabStats` | `storage.**session**` | 到浏览器关闭 | 按标签页 `{[tabId]:{n, words, blind}}` |
| `eng_glue` `eng_wasm` `eng_data` | `storage.local` | 永久 | 用户自装的引擎（base64） |

两个容易踩的点：

**统计不能只放在 service worker 的内存里。** MV3 的 SW 闲置约 30 秒就被回收，
而徽标是浏览器状态、活得比它久——原来就出现过「徽标显示 5，再命中一次变回 1」。
所以按标签页的账走 `storage.session`：SW 重启后能接着数，浏览器关掉才清。

**读设置的时机比想象中早。** `content.js` 里 `showBlind` 是在模块顶层单独读的，
没有跟着 `bootWorker()`——因为「本页挡不住」的信号可能比检测器起得还早
（DRM 是 `setMediaKeys` 一调用就报），而 `enabled === false` 时 `bootWorker`
直接 `return`，根本不会读配置。加新的 UI 开关时留意走哪条路。

## 开发环境

编引擎、装扩展的完整步骤见 [README 的安装教程](README.md#安装扩展完整教程)，
这里只补开发相关的：

改完 `extension/src/` 下的任何文件，去 `chrome://extensions` 点扩展卡片上的
**刷新**图标，然后**刷新视频页**。`main-world.js` 是 `document_start` 注入的，
不刷新页面不会重新跑。

调试各层：

| 想看哪一层 | 去哪看 |
|---|---|
| MAIN world 的 hook、解码、静音 | 视频页的 DevTools Console |
| ISOLATED world 的桥接、提示条 | 同上（注意切 context） |
| Worker 里的检测 | DevTools → Sources → Threads |
| service worker、徽标 | `chrome://extensions` → 点「服务工作进程」 |

## 跑测试

**先跑这个**——素材自给自足，不需要任何私人视频：

```bash
cd extension
npm install                        # 只装 playwright，扩展本身不需要 npm
npx playwright install chromium    # 再装一个浏览器
npm test                           # 全套：单测 + 端到端 + 引导页
```

单跑其中一组：`npm run test:unit`（纯 Node，秒级）/ `npm run test:e2e` / `npm run test:ui`。

它用 `extension/assets/selftest.wav`（`fetch-models.sh` 取的官方测试音频）现场转成
WebM/Opus、切成 7 段投喂，跑完整条链路：hook `appendBuffer` → WebM 解封装 →
WebCodecs 解码 → 重采样 → KWS → GainNode 静音。顺便压了 `webm-demux.js`
跨分段边界的有状态解析。前提是引擎已经内置（跑过 `build-all.sh`）。

**它有两个独立判定，别只看第一个**：

- *全链路打通* —— 日志里出现了命中和排程
- *增益实测* —— 在测试页 hook `AudioContext.prototype.createGain` 截住扩展建的
  那个节点，播放时按 50ms 采样它的**实际值**，确认静音区间内掉到 0、区间外回到 1

第二条是必要的：日志那句「已排程静音」只证明排了程。做过负向对照——
把 `linearRampToValueAtTime(0.0001, t0)` 去掉，日志**照样是绿的**，
只有增益实测变红（区间内最大增益 1）；把恢复那一步去掉，则是区间后最小增益
停在 0.0001。改静音逻辑时请照这个方式验。

环境变量：`WW_CHROME` 指定浏览器，`WW_EXT` 指定扩展目录，`WW_MEDIA` 指定素材缓存目录。

**再跑这两个** —— 纯 Node，秒级，不用浏览器也不用引擎：

```bash
node extension/test/mp4-demux-test.js
node extension/test/text2token-test.js
```

`text2token-test.js` 的标准答案不是编的：用 `extension/keywords.txt` 里那 9 条
逐条比对。那些 token 序列当初由官方 `sherpa-onnx-cli text2token` 生成，
且 P0 阶段在真实音频上验证过能命中——所以这个测试实际在验「浏览器里这套转换
和官方工具是否等价」。同样做过变异检验（4 处），其中「拆不出时硬返回」那条
一开始漏了：数据表只收了能拆的字，走 convert() 永远碰不到 null 分支，
补了直接调 splitSyllable 的用例才盖住。

`mp4-demux.js` 那 220 行一直没法测：B 站主力是 fMP4+AAC，而开源版 Chromium
不带 AAC，端到端测试根本走不到那一环。但解封装器只认字节结构、不解码，
所以可以手搓 fMP4 喂给它。28 项断言覆盖 timescale（mdhd v0/v1 两条偏移）、
声道/采样率、esds 里的 AudioSpecificConfig、样本切分与时间戳推进、
tfdt v1 的 64 位读取、一个缓冲里多个 moof+mdat 对、以及两种越界防线。

**这个测试做过变异检验**：把源码改坏 8 处（偏移错位、版本分支写死、
游标不推进、越界检查去掉…），8 处全被抓住。其中「越界检查」那条一开始
漏了——原本的截断用例走不到那个分支，是变异检验暴露出来的，补了用例才盖住。
改这个文件时请保持这个习惯：先把测试改坏，确认它会红。

它测不到 WebCodecs 那一环（`description` 给对了没、能不能真解出声音），
那部分仍需带 AAC 的正式版 Chrome 跑 `e2e-selftest.js`。

---

下面这几个是原有的测试，**需要一段含唤醒词的视频，仓库里没有**：

```bash
cd extension/test
ffmpeg -i 你的视频.mp4 -vn -c:a libopus -f dash -seg_duration 2 \
  -use_template 0 -use_timeline 0 -init_seg_name 'init.m4s' \
  -media_seg_name 'seg-$Number$.m4s' dash.mpd
python3 -m http.server 8848 &
```

然后：

```bash
node run.js             # 端到端：拦截 → 解码 → 检测 → 静音
node selftest.js        # 分项检查每个环节
node onboarding-test.js # 引导流程
node bundled-test.js    # 引擎已内置时的引导页分支
```

`run.js` 里的 `executablePath` 目前是硬编码的 Chromium 路径，本地跑可能要改。

## 两个已经踩过的坑

**一、KWS 有变体盲区，而且调参救不了。**

第二段测试视频里有 8 处唤醒词，KWS 只认出 3 处——全是标准的「小爱同学」。
「小菜同学」「小坏同学」「小被同学」这些**足以唤醒真实设备**的近音变体一个没抓到。

**放宽阈值不解决问题**：从 0.25 一路放到 0.02、加权从 2.0 提到 5.0，命中数只在
3–4 之间漂移，而且抓到的还不是同一批。放宽阈值只是让模型在错误的方向上更激进，
并不会让它突然理解「菜」和「爱」发音相近。

解法是 `p0/fuzzy.py` 的拼音模糊匹配：转写 → 转拼音 → 按音节做带容错的比对。
固定音节必须完全一致（xiao / tong / xue），可变音节只要韵母落在目标韵母的
近邻集合里就算命中。

| 候选 | 拼音 | 相似度 | 判定 |
|---|---|---|---|
| 小爱同学 | xiao ai tong xue | 1.000 | 屏蔽 |
| 小菜/小蔡同学 | xiao cai tong xue | 0.963 | 屏蔽 |
| 小坏同学 | xiao huai tong xue | 0.900 | 屏蔽 |
| 小被同学 | xiao bei tong xue | 0.900 | 屏蔽 |
| 小明同学 | xiao ming tong xue | 0.750 | 放行 |
| 小李同学 | xiao li tong xue | 0.750 | 放行 |

阈值 0.85 干净地把两类分开。

两条路都能走，速度差 4 倍：词表方案 7/8、21x 实时，但变体要人工枚举；
全片 ASR + 模糊匹配 8/8、4.7x 实时，能自动泛化到没见过的变体。
**建议两层都上**——词表兜住常见变体（快、便宜、可社区订阅），模糊层兜住长尾。
慢 4 倍无所谓：前瞻窗口是 10–60 秒，4.7x 实时意味着扫完 30 秒缓冲只要 6 秒。

**二、合成语料可能是假的。**

第一版用 aishell3 的 VITS 合成「小爱同学」，模型把它念成了「小艾同学」
「小安同学」「小赖同学」——**35% 的样本连 ASR 都听不出唤醒词**。用这批数据
测出来的召回率只有 42%，差点让人误判模型能力不行。换 TTS 并加上
「ASR 确认发音正确才纳入统计」这道闸之后是 94.9%。

**合成语料必须先验证它合成对了**，否则测的是 TTS 不是模型。这一条对任何
语音任务的评测都成立。

## 六个能卡住一整天的技术细节

1. **必须用 `audioSB.buffered`，不能用 `video.buffered`。** 按 MSE 规范，后者是
   所有 active SourceBuffer 缓冲区间的**交集**。音视频分离时视频轨字节大、
   缓冲慢，会系统性低估实际拥有的音频前瞻。

2. **WebCodecs 的 `description` 语义是反直觉的。** fMP4 里的裸 AAC **必须**给
   `description`（AudioSpecificConfig），否则会被当成 ADTS 解析；而 Opus 恰恰
   **不能**给。搞反了直接解不出声音。

3. **`timestampOffset` 要跟着算。** `tfdt` 是 media timeline，实际呈现时间还要
   叠加 `SourceBuffer.timestampOffset` 并受 `appendWindowStart/End` 裁剪。
   这三个属性的 setter 也得 hook，否则算出的秒数和 `currentTime` 对不上。

4. **扩展页里 `fetch` 不存在的资源是抛异常，不是返 404。** 可选文件（如 `.data`）
   必须单独包 try，否则会把整个「引擎已内置」误判成没装。

5. **两种 emscripten 胶水形态。** 官方构建是非 MODULARIZE（全局 `var Module` +
   `onRuntimeInitialized`），npm 那份是 MODULARIZE（工厂函数返 Promise）。
   前者**必须在胶水执行之前**配置好 `Module`，而且要用**间接 eval**
   （`(0, eval)(glue)`）走全局作用域，否则 `var Module` 会变成局部变量。
   `kws-worker.js` 里两种形态都已支持。

6. **`manifest.json` 必须显式声明 `wasm-unsafe-eval`。** 默认 CSP 只有
   `script-src 'self'`，扩展**页**拿得到 `wasm-unsafe-eval` 但**Worker 拿不到**，
   于是 `WebAssembly.instantiate` 报 "Refused to compile or instantiate"。
   这个坑很隐蔽：胶水能加载、报错却出在 wasm 实例化那一步。

7. **扩展页里不能用 blob worker 跑引擎。** `(0, eval)(glue)` 和
   `importScripts(blobURL)` 在 MV3 扩展页的 CSP 下都会被拦，只有
   `new Worker(chrome.runtime.getURL('src/kws-worker.js'))` +
   `importScripts(扩展内 URL)` 走得通。`kws-worker.js` 现在两种都支持：
   给 `glueUrl` 就走 importScripts，给 `glue` 文本才回退到 eval。
   顺序不能错——`shimUrl`/`kwsUrl` 先加载，`self.Module` 配好之后才能加载胶水。

8. **`chrome.runtime` 的消息是 JSON 序列化的，不是结构化克隆。** 实测：
   `ArrayBuffer` 传过去变成 `{}`，`Int16Array` 退化成带数字键的普通对象，
   只有普通 `Array` 能原样过去。跨上下文传音频必须自己编码（本项目走 base64）。

9. **offscreen 文档拿不到 `chrome.storage`。** 它的 API 面比普通扩展页窄，
   `chrome.storage` 是 `undefined`。配置得由内容脚本读好、随消息带进去。

10. **官方构建没把 `FS` 放进 `EXPORTED_RUNTIME_METHODS`。** 带 `.data` 的构建
   不需要 FS（模型已由 `--preload-file` 预加载），别写死校验。

> **注意 `extension/vendor/README.md` 有一段已经过时**：它说编完官方 wasm 之后
> 要手动删掉 `kws-worker.js` 里 `FS.writeFile` 那几行。**现在不需要了**——
> `kws-worker.js` 已经同时支持「`.data` 预加载」和「手动写入模型」两条路径，
> 会根据传进来的东西自动选。

## 待办清单

### 高优先级

- [x] ~~**内容脚本在严格 CSP 的站点上跑不起来**~~ —— **已解决，改成 offscreen 文档**。
      问题：内容脚本建的 Worker 继承页面的源和 CSP。实测（Chromium 1194）：

      | 场景 | blob worker + eval | 扩展 URL 建 worker |
      |---|---|---|
      | 扩展页 | ❌ CSP 拦 | ✅ 通 |
      | 内容脚本 @ 无 CSP 页面 | ✅ 通 | ❌ 跨源拦 |
      | 内容脚本 @ `script-src 'self'` 页面 | ❌ CSP 拦 | ❌ 跨源拦 |

      大站基本都在最后一行，两条路全死，而 MV3 不允许把 `unsafe-eval` 写进
      manifest，没有扩展侧的开关能解开。

      解法：检测搬进 `src/offscreen.html` / `offscreen.js`。offscreen 是**扩展源**，
      不受页面 CSP 管，能直接 `new Worker(chrome.runtime.getURL(...))`。
      链路变成 `内容脚本 --Port--> offscreen --> kws-worker`。
      两个要点：全扩展只能有一个 offscreen 文档，所以它按连接分流（一个 wasm
      实例、每条音轨一条 stream）；`chrome.runtime` 的消息是 JSON 序列化的，
      ArrayBuffer 传过去会变成 `{}`，所以 PCM 走 base64（约 43 KB/s）。
      已在严格 CSP 页面上端到端验证通过（`extension/test/e2e-selftest.js`）。
- [ ] **跑站点探测**，确认 B 站 / YouTube 没中 MSE-in-Workers。这是唯一可能
      推翻整个架构的未知数：

      ```js
      document.querySelector('video')?.src        // blob:… → 方案成立
      document.querySelector('video')?.srcObject  // MediaSourceHandle → 抓不到
      ```

      中招不会静默失败：`main-world.js` 认出来就报 `ww:blind`，工具栏图标角上
      出现 `!`。想批量查站点用 `extension/tools/site-probe.js`（粘进控制台跑）
      ——它以前也做成过引导页的一步，后来撤了，那是开发者工具，对普通用户没意义。
      **即便中招也有救**：在 MAIN world 覆盖 `window.Worker`，用
      `importScripts` 把补丁前置注入 worker（Chromium 官方认可这是 dedicated
      worker 的可行手段），但复杂度会明显上升。
- [ ] **在更大的真实素材集上复测误报率**（见[上文](#最需要帮忙的三件事)）
- [ ] **把 `p0/fuzzy.py` 的拼音模糊层移植进扩展**（见[上文](#最需要帮忙的三件事)）

### 中优先级

- [ ] 实时兜底路径（`chrome.tabCapture` + offscreen 文档），覆盖直播和预扫描
      够不到的内容。
      **注意**：在 content script 的 ISOLATED world 里建 `AudioContext` 会命中
      Chromium 的已知缺陷（issue 40885587）导致音频被静音，官方解法就是放进
      offscreen 文档
- [ ] DRM / 杜比音轨 / worker-MSE 的检测与优雅降级（探针已有，降级逻辑还没写）
- [ ] 去站点化：只要用 MSE 就能工作，不再针对单个播放器适配
- [ ] 上架 Chrome 应用商店。**MV3 禁止远程托管代码，wasm 也算**，引擎必须内置。
      首个版本建议只声明 `*://*.bilibili.com/*` 和 `*://*.youtube.com/*`，
      审核阻力小得多。`tabCapture` 是敏感权限，但主线路径不需要它，可以做成
      按需申请。全程本地推理、零网络请求是很强的辩护材料

### 低优先级

- [ ] 社区维护的唤醒词与变体库（类似 uBlock 的过滤规则订阅）——变体是长尾且
      会随梗变化的，这可能是项目最有生命力的部分
- [ ] 比全静音更隐蔽的处理：−15 dB + 频谱涂抹，保留可懂度、破坏声学特征。
      需实测验证有效性，别放在第一版
- [ ] Firefox 版本（没有 `tabCapture`，但 MSE 拦截主线路通）

## 提 Issue 之前

先确认不是[已知边界](README.md#做不到什么)——DRM、杜比音轨、WebRTC、
浏览器之外、移动端，这些是结构性做不到的，不是 bug。

报检测问题请附上：

- 站点和视频链接（如果是公开的）
- 工具栏图标显示什么（数字 / `!` / `3!` / 无），以及鼠标停上去的那句提示
- 设置面板顶部那两栏（本页 / 历史累计）分别记到了什么词
- 视频页控制台的完整输出
- 如果能复现，最好跑一遍 `p0/scan.py` 看看 Python 侧认不认得出——
  这能立刻区分「模型不行」和「浏览器侧管线有问题」

## 提 PR 的约定

- **代码风格跟着现有文件走**：中文注释，注释解释「为什么」而不是「做了什么」，
  踩过的坑就地写清楚
- **改检测逻辑必须附复测数据**。用 `p0/` 的工具跑，至少给出召回和误报两个数字，
  说明测量条件。这个项目里「感觉更准了」不算证据
- **加唤醒词变体请说明验证方式**：你在哪台设备上确认过它真的能唤醒
- **别引入非商用许可的模型**。选型时排除 openWakeWord 的一个主要原因就是它的
  预训练模型是 CC-BY-NC-SA。本项目及其依赖保持 Apache-2.0
- **不要提交**：wasm 引擎二进制、模型文件、测试音视频素材、`.pem` 签名私钥。
  这些都已经在 `.gitignore` 里
