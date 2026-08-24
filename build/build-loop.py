#!/usr/bin/env python3
"""
定向构建循环
============
跑构建 → 只看第一个 403 的 URL → 用 git clone 造等价本地包 → 只改引用它的那个文件 → 再跑。

上一版的教训：不要递归扫描所有依赖里的 URL。openfst 之类的包里带着 Hunter
包管理器的配置，里面列了几百个不相关的仓库，会把脚本带进无底洞。
只处理构建真正卡住的那一个，稳。
"""
import hashlib, os, re, shutil, subprocess, sys, tarfile, zipfile, glob

SO = '/home/claude/work/so'
BUILD = f'{SO}/build-wasm-simd-kws'
DL = '/root/Downloads'
LOG = '/home/claude/work/build.log'
FETCH = '/home/claude/work/fetch-dep.sh'
OUT = f'{BUILD}/install/bin/wasm'

FAIL_RE = re.compile(r"error: downloading '(https://github\.com/[^']+)' failed")
ARCH_RE = re.compile(r'https://github\.com/([^/]+/[^/]+)/archive/(.+?)\.(tar\.gz|zip)$')


def sha(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()


def run_build():
    shutil.rmtree(BUILD, ignore_errors=True)
    with open(LOG, 'w') as f:
        subprocess.run(['/home/claude/work/run-build.sh'], stdout=f, stderr=f)
    return os.path.isdir(OUT)


def fetch(repo, ref, top, out):
    r = subprocess.run([FETCH, repo, ref, top, out], capture_output=True, text=True)
    p = os.path.join(DL, out)
    return (p, sha(p)) if os.path.exists(p) else (None, None)


def tar_members(p):
    if p.endswith('.zip'):
        with zipfile.ZipFile(p) as z:
            return z.namelist()
    with tarfile.open(p) as t:
        return t.getnames()


def repack_with(tarball, relpath, content):
    """把改好的文件写回源头 tarball（_deps 每次配置都会重解，不写回就白改）"""
    tmp = '/tmp/_rp'
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    with tarfile.open(tarball) as t:
        t.extractall(tmp)
        top = t.getnames()[0].split('/')[0]
    dst = os.path.join(tmp, top, relpath)
    if not os.path.exists(os.path.dirname(dst)):
        return False
    open(dst, 'w', encoding='utf-8').write(content)
    os.remove(tarball)
    with tarfile.open(tarball, 'w:gz') as t:
        t.add(os.path.join(tmp, top), arcname=top)
    return True


def sync_hash_for(tarball):
    h = sha(tarball)
    for f in glob.glob(f'{SO}/cmake/*.cmake'):
        s = open(f, encoding='utf-8').read()
        if tarball not in s:
            continue
        new = re.sub(r'(_HASH\s+")SHA256=[0-9a-fA-F]+(")', r'\1SHA256=' + h + r'\2', s)
        if new != s:
            open(f, 'w', encoding='utf-8').write(new)
            print(f"      同步哈希 → {os.path.basename(f)}")


for rnd in range(1, 21):
    print(f"\n=== 第 {rnd} 轮 ===", flush=True)
    if run_build():
        print("构建成功！", flush=True)
        for f in sorted(os.listdir(OUT)):
            print("   ", f, os.path.getsize(os.path.join(OUT, f)))
        sys.exit(0)

    log = open(LOG, errors='ignore').read()
    m = FAIL_RE.search(log)
    if not m:
        print("不是下载失败，是别的问题：", flush=True)
        print('\n'.join([l for l in log.splitlines() if 'rror' in l][-12:]))
        sys.exit(1)

    url = m.group(1)
    am = ARCH_RE.match(url)
    if not am:
        print("这个 URL 不是 /archive/ 形式，处理不了：", url)
        sys.exit(1)
    repo, refpart, ext = am.group(1), am.group(2), am.group(3)
    ref = refpart.replace('refs/tags/', '')
    name = repo.split('/')[1]
    top = f"{name}-{ref.lstrip('v')}"
    out = f"local-{name}-{ref.replace('/', '_')}.{ext}"
    print(f"  缺 {repo} @ {ref}", flush=True)

    if os.path.exists(os.path.join(DL, out)):
        path, h = os.path.join(DL, out), sha(os.path.join(DL, out))
        print("    本地已有")
    else:
        path, h = fetch(repo, ref, top, out)
        if not path:
            print(f"    ❌ clone 不到 {repo}@{ref}")
            sys.exit(1)
        print(f"    ✅ {out}  {h[:12]}…")

    targets = []
    for root, _, files in os.walk(SO):
        for f in files:
            if not f.endswith('.cmake'):
                continue
            p = os.path.join(root, f)
            try:
                s = open(p, encoding='utf-8', errors='ignore').read()
            except Exception:
                continue
            if url in s:
                targets.append((p, s))
    if not targets:
        print("    ❌ 找不到引用它的 cmake")
        sys.exit(1)

    for p, s in targets:
        new = s.replace(url, path)
        new = re.sub(r'(_HASH\s+")SHA256=[0-9a-fA-F]+(")', r'\1SHA256=' + h + r'\2', new)
        open(p, 'w', encoding='utf-8').write(new)
        print(f"    改 {p.replace(SO + '/', '')}")
        # 若在 _deps 里，写回它来自的那个源头 tarball
        mm = re.search(r'_deps/([^/]+)-src/(.+)$', p)
        if mm:
            rel = mm.group(2)
            for tb in glob.glob(f'{DL}/*.tar.gz'):
                try:
                    names = tar_members(tb)
                except Exception:
                    continue
                if any(n.split('/', 1)[-1] == rel for n in names):
                    if repack_with(tb, rel, new):
                        print(f"      写回 {os.path.basename(tb)}")
                        sync_hash_for(tb)
                    break

print("轮次用尽")
sys.exit(1)
