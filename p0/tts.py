#!/usr/bin/env python3
"""合成测试语料。用法: tts.py <out.wav> <text> [speaker_id]"""
import sys, os
import sherpa_onnx
import soundfile as sf

M = os.path.join(os.path.dirname(__file__), "models", "vits-icefall-zh-aishell3")

_tts = None
def get_tts():
    global _tts
    if _tts is None:
        cfg = sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(
                vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                    model=f"{M}/model.onnx",
                    lexicon=f"{M}/lexicon.txt",
                    tokens=f"{M}/tokens.txt",
                ),
                provider="cpu",
                num_threads=4,
            ),
            rule_fsts=f"{M}/phone.fst,{M}/date.fst,{M}/number.fst",
            max_num_sentences=1,
        )
        assert cfg.validate(), "TTS config invalid"
        _tts = sherpa_onnx.OfflineTts(cfg)
    return _tts

def synth(text, path, sid=0, speed=1.0):
    tts = get_tts()
    a = tts.generate(text, sid=sid, speed=speed)
    sf.write(path, a.samples, samplerate=a.sample_rate, subtype="PCM_16")
    return len(a.samples) / a.sample_rate

if __name__ == "__main__":
    out, text = sys.argv[1], sys.argv[2]
    sid = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    d = synth(text, out, sid)
    print(f"{out}  {d:.2f}s  sid={sid}  «{text}»")
