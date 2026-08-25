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

# 路径全部可配置——写死成某台机器的绝对路径的话，这个脚本对别人就是废的。
HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.environ.get('WW_WORK', os.path.expanduser('~/ww-build'))
SO = os.environ.get('SHERPA_DIR', os.path.join(WORK, 'sherpa-onnx'))
DL = os.environ.get('WW_DL', os.path.join(WORK, 'dl'))
BUILD = f'{SO}/build-wasm-simd-kws'
LOG = os.path.join(WORK, 'build.log')
FETCH = os.path.join(HERE, 'fetch-dep.sh')
RUN = os.path.join(HERE, 'run-build.sh')
OUT = f'{BUILD}/install/bin/wasm'
ROUNDS = int(os.environ.get('WW_ROUNDS', '20'))
os.makedirs(DL, exist_ok=True)

FAIL_RE = re.compile(r"error: downloading '(https://github\.com/[^']+)' failed")
ARCH_RE = re.compile(r'https://github\.com/([^/]+/[^/]+)/archive/(.+?)\.(tar\.gz|zip)$')


def sha(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()


def run_build():
    shutil.rmtree(BUILD, ignore_errors=True)
    with open(LOG, 'w') as f:
        subprocess.run([RUN], stdout=f, stderr=f, env={**os.environ,
                       'WW_WORK': WORK, 'SHERPA_DIR': SO})
    return os.path.isdir(OUT)


def fetch(repo, ref, top, out):
    subprocess.run([FETCH, repo, ref, top, out], capture_output=True, text=True,
                   env={**os.environ, 'WW_WORK': WORK, 'WW_DL': DL})
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
    tmp = os.path.join(WORK, '_repack')
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


def place_in_downloads(tarball, cmake_text):
    """按 cmake 里 possible_file_locations 期望的文件名，把包放到 ~/Downloads。

    sherpa 的 cmake 会优先用这个位置的本地文件，并把 URL2 清空——这是上游
    支持的离线路径，比改 URL 稳。返回落地路径，没法判定文件名时返回 None。
    """
    m = re.search(r'Downloads/([A-Za-z0-9._-]+\.(?:tar\.gz|zip))', cmake_text)
    if not m:
        return None
    dst = os.path.join(os.path.expanduser('~/Downloads'), m.group(1))
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copyfile(tarball, dst)
    return dst


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
        # 关键：repack 之后包的内容和哈希都变了，~/Downloads 里那份必须一起换掉。
        # 否则 sherpa 优先用旧的那份，跟刚同步的哈希对不上，直接 SHA256 校验失败。
        d = place_in_downloads(tarball, new)
        if d:
            print(f"      刷新 {d}")


for rnd in range(1, ROUNDS + 1):
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

    # 优先走 sherpa 自己的离线机制：它的 cmake 里有一段 possible_file_locations，
    # 会去 $HOME/Downloads 等处找预下载的包，找到就用本地文件并把 URL2 清空。
    # 这条路是上游支持的，比改 URL 稳——只要文件名对得上。
    for p, s in targets:
        dst = place_in_downloads(path, s)
        if dst:
            print(f"    放到 {dst}（走 sherpa 的 possible_file_locations）")

    # 保险起见仍然改一遍 URL，并且**必须同时把 URL2 清空**：
    # CMake 对多元素 URL 列表会报 "At least one entry of URL is a path
    # (invalid in a list)"，列表只剩一个元素时这个检查才不触发。
    for p, s in targets:
        new = s.replace(url, path)
        new = re.sub(r'(set\(\s*\w+_URL2\s+)"[^"]*"', r'\1', new)
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
