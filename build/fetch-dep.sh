#!/usr/bin/env bash
# 用 git clone 造出等价于 GitHub /archive/ 的包
# ==============================================
# 有些网络环境（公司代理、受限容器）禁掉了 GitHub 的 /archive/ 打包下载，
# 但普通 git clone 是通的。CMake 的 FetchContent 只会走 /archive/，于是卡死。
# 这个脚本 clone 下来自己打包，产物和官方 /archive/ 的内容一致（同 tag 同源码），
# 只是校验和不同——所以调用方拿到新哈希后要去同步 cmake 里的 _HASH。
#
#   用法： ./fetch-dep.sh <owner/repo> <ref> <解包后的顶层目录名> <输出文件名>
#   输出： 打包文件落在 $WW_DL（默认 $WW_WORK/dl），stdout 打印它的 sha256
set -e
REPO=$1; REF=$2; TOP=$3; OUT=$4
: "${REPO:?用法: fetch-dep.sh <owner/repo> <ref> <top-dir> <out-file>}"

WORK="${WW_WORK:-$HOME/ww-build}"
DL="${WW_DL:-$WORK/dl}"
mkdir -p "$DL"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"

# 先试带 --branch 的浅克隆；ref 是裸 commit sha 时它不work，退回 fetch 那条路
if git clone --depth 1 --branch "$REF" -q "https://github.com/$REPO.git" t 2>/dev/null; then :
else
  rm -rf t
  git init -q t && cd t && git remote add origin "https://github.com/$REPO.git"
  git fetch --depth 1 -q origin "$REF" >/dev/null 2>&1 && git checkout -q FETCH_HEAD
  cd ..
fi
[ -d t ] || { echo "CLONE_FAILED $REPO@$REF" >&2; exit 1; }

rm -rf "$TOP" && mv t "$TOP" && rm -rf "$TOP/.git"
case "$OUT" in
  *.zip) zip -qr "$DL/$OUT" "$TOP" ;;
  *)     tar czf "$DL/$OUT" "$TOP" ;;
esac
sha256sum "$DL/$OUT" | cut -d' ' -f1
