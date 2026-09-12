from pathlib import Path
import sys, zipfile, hashlib
root=Path(__file__).resolve().parents[1]
destination=Path(sys.argv[1]).resolve()
destination.parent.mkdir(parents=True,exist_ok=True)
paths=[root/'Install.cmd',root/'Install.command',root/'docs/STUDY-APP.md',root/'docs/STUDY-APP-VALIDATION.md',root/'docs/CONTEXT-INDEX-PLAN.md',root/'docs/history/STUDY-APP-V02-VALIDATION.md']
for name in ('app','connection-plugin','skills'):
    paths.extend(p for p in (root/name).rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.suffix!='.pyc')
with zipfile.ZipFile(destination,'w',zipfile.ZIP_DEFLATED) as archive:
    for p in paths:
        rel=p.relative_to(root).as_posix()
        info=zipfile.ZipInfo(rel)
        info.external_attr=((0o100755 if p.suffix in ('.sh','.command') else 0o100644)<<16)
        info.compress_type=zipfile.ZIP_DEFLATED
        archive.writestr(info,p.read_bytes())
print(f'{destination}\nfiles={len(paths)}\nsha256={hashlib.sha256(destination.read_bytes()).hexdigest()}')
