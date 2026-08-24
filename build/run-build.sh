#!/usr/bin/env bash
export PATH="/home/claude/work/em/emscripten:$PATH"
export EMSCRIPTEN=/home/claude/work/em/emscripten
export EM_CONFIG=/root/.emscripten
cd /home/claude/work/so
./build-wasm-simd-kws.sh
