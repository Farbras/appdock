from pathlib import Path
import hashlib, shutil, zipfile
root=Path(__file__).resolve().parent.parent
out=root/'releases'/'AppDock-0.1.0'
out.mkdir(parents=True,exist_ok=True)
shutil.copy2(root/'src-tauri/target/release/appdock.exe',out/'AppDock.exe')
shutil.copy2(root/'src-tauri/target/release/bundle/nsis/AppDock_0.1.0_x64-setup.exe',out/'AppDock_0.1.0_x64-setup.exe')
shutil.copy2(root/'README.md',out/'README.md')
shutil.copytree(root/'docs',out/'docs',dirs_exist_ok=True)
folders=['src','src-tauri/src','src-tauri/capabilities','src-tauri/icons','catalog','docs','public','scripts','tests','.github']
files=['package.json','package-lock.json','index.html','tsconfig.json','tsconfig.app.json','tsconfig.node.json','vite.config.ts','.gitignore','README.md','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/build.rs','src-tauri/tauri.conf.json']
sources=out/'AppDock-0.1.0-source.zip'
with zipfile.ZipFile(sources,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
    for name in folders:
        for path in sorted((root/name).rglob('*')):
            if path.is_file():z.write(path,path.relative_to(root))
    for name in files:z.write(root/name,name)
checks=[]
for path in sorted(out.iterdir()):
    if path.suffix in ['.exe','.zip']:
        digest=hashlib.sha256(path.read_bytes()).hexdigest()
        checks.append(f'{digest}  {path.name}')
        print(f'{path.name}: {path.stat().st_size:,} bytes')
(out/'SHA256SUMS.txt').write_text('\n'.join(checks)+'\n',encoding='utf-8')
print(out)
