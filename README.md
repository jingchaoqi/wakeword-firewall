# 唤醒词防火墙 · wakeword-firewall

> 看视频时视频里说了一句「小爱同学」，桌上的手机亮了。

一个 Chrome 扩展，在唤醒词播出去**之前**把它静音掉，
别让视频唤醒你身边的设备。**全程本地推理，零网络请求。**

Block wake words ("小爱同学", "Hey Siri", …) in browser video before they
reach your devices. 100% on-device inference, no network requests.

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

## 实测

| 指标 | 结果 |
|---|---|
| 真实视频召回 | 9 / 9 处 |
| 合成语料召回 | 94.9%（六种声学增强） |
| 误报 | 0 次 / 32 分钟普通语音 |
| 扫描速度 | 21x 实时（单核） |

## 快速开始

```bash
# 1. 编 wasm 引擎（一次性，20–40 分钟；官方没有发布浏览器版）
./extension/vendor/build-wasm.sh

# 2. 打进扩展包
./extension/tools/embed-engine.sh <构建产物目录>

# 3. chrome://extensions → 开发者模式 → 加载已解压 → 选 extension/
```

装完会自动弹引导页，跟着走完即可。

详细说明见 **[HANDOFF.md](HANDOFF.md)** —— 包含完整目录说明、
P0 实测数据、已知边界、待办清单，以及几个能卡住一整天的技术细节。

## 做不到什么

- **DRM 内容**（Netflix 等）：音频是密文，结构性无解
- **杜比音轨**：Chrome 不带 E-AC-3 解码器
- **WebRTC 直播**：零缓冲，没有前瞻可用
- **浏览器之外**：本地播放器、系统提示音一律不管
- **移动端**：基本不支持扩展

遇到时页面上会有提示，**不会静默失效**。

## 致谢

检测引擎基于 [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)（Apache-2.0），
模型为 sherpa-onnx-kws-zipformer-wenetspeech-3.3M。

## 许可

Apache-2.0
