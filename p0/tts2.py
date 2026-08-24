import os, sys, sherpa_onnx, soundfile as sf
M = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "sherpa-onnx-vits-zh-ll")
cfg = sherpa_onnx.OfflineTtsConfig(
    model=sherpa_onnx.OfflineTtsModelConfig(
        vits=sherpa_onnx.OfflineTtsVitsModelConfig(
            model=f"{M}/model.onnx", lexicon=f"{M}/lexicon.txt",
            tokens=f"{M}/tokens.txt", dict_dir=f"{M}/dict"),
        provider="cpu", num_threads=2),
    rule_fsts=f"{M}/phone.fst,{M}/date.fst,{M}/number.fst", max_num_sentences=1)
assert cfg.validate()
tts = sherpa_onnx.OfflineTts(cfg)
def synth(text, path, sid=0):
    a = tts.generate(text, sid=sid, speed=1.0)
    sf.write(path, a.samples, samplerate=a.sample_rate, subtype="PCM_16")
if __name__ == "__main__":
    synth(sys.argv[2], sys.argv[1], int(sys.argv[3]) if len(sys.argv)>3 else 0)
