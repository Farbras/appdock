from pathlib import Path
import zipfile
import zlib
root=Path(__file__).resolve().parent.parent
archives=root/'.tools/build-archives'
for src in archives.iterdir():
    if src.suffix not in ['.vsix','.zip']: continue
    dest=root/'.tools/portable-msvc' if src.suffix=='.vsix' else root/'.tools'/src.stem
    dest.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(src) as z:
        for info in z.infolist():
            # Keep extracted paths inside the dedicated archive directory.
            target=(dest/info.filename).resolve()
            if not target.is_relative_to(dest.resolve()): raise ValueError('Archive path traversal')
            if target.is_file() and target.stat().st_size==info.file_size and zlib.crc32(target.read_bytes())==info.CRC:
                continue
            z.extract(info,dest)
        print(src.name, 'extracted', len(z.infolist()), 'files')
