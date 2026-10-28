from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import zipfile


root = Path(__file__).resolve().parent.parent
version = json.loads((root / 'src-tauri/tauri.conf.json').read_text(encoding='utf-8'))['version']
out = root / 'releases' / f'AppDock-{version}'
installer_name = f'AppDock_{version}_x64-setup.exe'
exe = root / 'src-tauri/target/release/appdock.exe'
installer = root / 'src-tauri/target/release/bundle/nsis' / installer_name

for binary in (exe, installer):
    if not binary.is_file():
        raise SystemExit(f'Missing {binary}. Run npm run bundle first.')
    if binary.read_bytes()[:2] != b'MZ':
        raise SystemExit(f'Not a Windows executable: {binary}')

out.mkdir(parents=True, exist_ok=True)
shutil.copy2(exe, out / 'AppDock.exe')
shutil.copy2(installer, out / installer_name)
shutil.copy2(root / 'README.md', out / 'README.md')
shutil.copytree(root / 'docs', out / 'docs', dirs_exist_ok=True)

quick_start = f'''AppDock {version} — Windows 11 x64

ЗАПУСК БЕЗ УСТАНОВКИ
1. Распакуйте весь ZIP в отдельную папку.
2. Откройте AppDock.exe двойным щелчком.

Node.js, Rust и инструменты сборки для запуска не нужны.
Если отсутствует Microsoft Edge WebView2 Runtime, используйте установщик:
https://github.com/Farbras/appdock/releases/download/v{version}/{installer_name}
Он скачает WebView2 Runtime при необходимости.

Для установки программ из каталога нужен WinGet / App Installer и интернет.
Перед запуском очереди AppDock покажет план и запросит подтверждение.

Все файлы выпуска:
https://github.com/Farbras/appdock/releases/tag/v{version}
'''
(out / 'START-HERE.txt').write_text(quick_start, encoding='utf-8-sig')

portable = out / f'AppDock-{version}-windows-x64.zip'
with zipfile.ZipFile(portable, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    archive.write(out / 'AppDock.exe', 'AppDock.exe')
    archive.write(out / 'START-HERE.txt', 'START-HERE.txt')
    archive.write(root / 'public/icons/LICENSE.txt', 'THIRD-PARTY-NOTICES.txt')

sources = out / f'AppDock-{version}-source.zip'
tracked = subprocess.run(
    ['git', 'ls-files', '-z'], cwd=root, check=True, capture_output=True
).stdout.decode('utf-8').split('\0')
with zipfile.ZipFile(sources, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for name in sorted(filter(None, tracked)):
        archive.write(root / name, name)

assets = [out / installer_name, out / 'AppDock.exe', portable, sources]
checks = []
for path in assets:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    checks.append(f'{digest}  {path.name}')
    print(f'{path.name}: {path.stat().st_size:,} bytes')
(out / 'SHA256SUMS.txt').write_text('\n'.join(checks) + '\n', encoding='utf-8')
print(out)
