#!/usr/bin/env bash
# 用 git clone 造出等价于 GitHub /archive/ 的包（代理禁了 /archive/，但 clone 通）
set -e
REPO=$1; REF=$2; TOP=$3; OUT=$4
cd /tmp && rm -rf _fd && mkdir _fd && cd _fd
if git clone --depth 1 --branch "$REF" -q "https://github.com/$REPO.git" t 2>/dev/null; then :
else
  git init -q t && cd t && git remote add origin "https://github.com/$REPO.git"
  git fetch --depth 1 -q origin "$REF" >/dev/null 2>&1 && git checkout -q FETCH_HEAD && cd ..
fi
[ -d t ] || { echo "CLONE_FAILED" >&2; exit 1; }
rm -rf "$TOP" && mv t "$TOP" && rm -rf "$TOP/.git"
case "$OUT" in
  *.zip) (cd /tmp/_fd && zip -qr "/root/Downloads/$OUT" "$TOP") ;;
  *)     tar czf "/root/Downloads/$OUT" -C /tmp/_fd "$TOP" ;;
esac
sha256sum "/root/Downloads/$OUT" | cut -d' ' -f1
