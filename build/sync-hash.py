import hashlib, os, re, glob
SO='/home/claude/work/so'
n_files=0
for f in glob.glob(f'{SO}/cmake/*.cmake'):
    s=open(f,encoding='utf-8').read()
    m=re.search(r'Downloads/([A-Za-z0-9._-]+\.(?:tar\.gz|zip))', s)
    if not m: continue
    p=os.path.join('/root/Downloads', m.group(1))
    if not os.path.exists(p): continue
    h=hashlib.sha256(open(p,'rb').read()).hexdigest()
    new,k=re.subn(r'(_HASH\s+")SHA256=[0-9a-fA-F]+(")', r'\1SHA256='+h+r'\2', s)
    if k:
        open(f,'w',encoding='utf-8').write(new)
        n_files+=1
        print(f"  {os.path.basename(f):32s} {m.group(1):40s} {h[:12]}")
print("同步了", n_files, "个 cmake")
