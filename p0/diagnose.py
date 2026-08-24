#!/usr/bin/env python3
"""决定性诊断：漏检到底是「TTS 发音不像」还是「模型真的弱」。

对每个 clean 正样本：
  1) 用 ASR 转写 —— ASR 能不能听出「小爱同学」？
  2) 量 RMS 电平
  3) 归一化到 -20 dBFS 后重测 KWS
ASR 听得出而 KWS 听不出 → 模型弱；ASR 也听不出 → 测试集是假的。
"""
import os, json
import numpy as np
import sherpa_onnx
from detect import make_spotter, detect, ZH

ROOT = os.path.dirname(os.path.abspath(__file__))
DS = os.path.join(ROOT, "dataset")
KWF = os.path.join(DS, "kw_xiaoai.txt")
ASR_M = os.path.join(ROOT, "models",
                     "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20")


def get_asr():
    return sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=f"{ASR_M}/tokens.txt",
        encoder=f"{ASR_M}/encoder-epoch-99-avg-1.int8.onnx",
        decoder=f"{ASR_M}/decoder-epoch-99-avg-1.onnx",
        joiner=f"{ASR_M}/joiner-epoch-99-avg-1.int8.onnx",
        num_threads=2, provider="cpu", enable_endpoint_detection=False)


def transcribe(rec, a):
    s = rec.create_stream()
    s.accept_waveform(16000, a)
    s.input_finished()
    while rec.is_ready(s):
        rec.decode_stream(s)
    return rec.get_result(s)


def norm(a, target_dbfs=-20.0):
    rms = np.sqrt(np.mean(a ** 2)) + 1e-9
    return np.clip(a * (10 ** (target_dbfs / 20) / rms), -1.0, 1.0).astype(np.float32)


def main():
    rows = [r for r in json.load(open(f"{DS}/manifest.json"))
            if r["kind"] == "pos" and r["variant"] == "clean"]
    z = np.load(f"{DS}/cache.npz", allow_pickle=True)
    cache = {k: z["arrs"][i] for i, k in enumerate(z["keys"])}

    sp = make_spotter(ZH, keywords_file=KWF, score=2.0, threshold=0.25, num_threads=2)
    rec = get_asr()

    stats = {"asr_ok_kws_ok": 0, "asr_ok_kws_no": 0,
             "asr_no_kws_ok": 0, "asr_no_kws_no": 0}
    norm_gain = [0, 0]
    print(f"{'RMS dBFS':>9} {'ASR听到':>7} {'KWS原始':>8} {'KWS归一化':>10}  转写")
    print("-" * 100)
    for r in rows:
        a = cache[r["path"]]
        rms_db = 20 * np.log10(np.sqrt(np.mean(a ** 2)) + 1e-9)
        txt = transcribe(rec, a)
        asr_ok = "小爱同学" in txt.replace(" ", "")
        kws_ok = bool(detect(sp, a))
        kws_n = bool(detect(sp, norm(a)))
        norm_gain[0] += kws_n
        norm_gain[1] += 1
        k = f"asr_{'ok' if asr_ok else 'no'}_kws_{'ok' if kws_ok else 'no'}"
        stats[k] += 1
        print(f"{rms_db:>9.1f} {'✓' if asr_ok else '✗':>7} "
              f"{'✓' if kws_ok else '✗':>8} {'✓' if kws_n else '✗':>10}  {txt[:44]}")

    n = len(rows)
    print(f"\n共 {n} 条 clean 正样本")
    print(f"  ASR听到 & KWS命中 : {stats['asr_ok_kws_ok']}")
    print(f"  ASR听到 & KWS漏检 : {stats['asr_ok_kws_no']}   ← 模型弱的证据")
    print(f"  ASR没听到 & KWS命中: {stats['asr_no_kws_ok']}")
    print(f"  ASR没听到 & KWS漏检: {stats['asr_no_kws_no']}   ← 测试集假的证据")
    print(f"\n归一化到 -20dBFS 后召回: {norm_gain[0]}/{norm_gain[1]} "
          f"= {norm_gain[0]/max(norm_gain[1],1)*100:.1f}%  (原始 "
          f"{(stats['asr_ok_kws_ok']+stats['asr_no_kws_ok'])/n*100:.1f}%)")


if __name__ == "__main__":
    main()
