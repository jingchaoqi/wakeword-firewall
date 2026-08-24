import os, sys, numpy as np, sherpa_onnx
from detect import load_16k_mono
M = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models",
                 "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20")
r = sherpa_onnx.OnlineRecognizer.from_transducer(
    tokens=f"{M}/tokens.txt",
    encoder=f"{M}/encoder-epoch-99-avg-1.int8.onnx",
    decoder=f"{M}/decoder-epoch-99-avg-1.onnx",
    joiner=f"{M}/joiner-epoch-99-avg-1.int8.onnx",
    num_threads=4, provider="cpu", enable_endpoint_detection=False)
a = load_16k_mono(sys.argv[1])
s = r.create_stream()
s.accept_waveform(16000, a)
s.input_finished()
while r.is_ready(s): r.decode_stream(s)
res = r.get_result_all(s)
print("转写:", res.text)
toks = list(zip(res.tokens, res.timestamps))
print("\n前 30 个 token 及时间戳:")
for t, ts in toks[:30]:
    print(f"  {ts:6.2f}s  {t}")
