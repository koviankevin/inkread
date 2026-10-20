"""Package the built, offline website and source without node_modules or credentials."""
from pathlib import Path
import sys
import zipfile

root = Path(__file__).resolve().parent.parent
output = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'packages'
output.mkdir(parents=True, exist_ok=True)

instructions = '''墨閱 Inkread — 開始使用

1. 完整解壓縮 ZIP；不要直接從壓縮檔裡開啟。
2. 雙擊 index.html，以近期 Chrome 或 Edge 使用。
3. 拖入 .md 檔案，或使用「開啟文件」與「貼上 Markdown」。
4. 文件有本機圖片時，使用「匯入資料夾」，選擇文件與圖片的共同上層資料夾。

不需要安裝 Node.js，不需要連接網際網路。文件在瀏覽器內處理，不會上傳。
程式、樣式與公式字型都已附上；請保留所有資料夾與檔案的相對位置。

若公司政策限制本機 HTML，可將所有檔案放到內部網頁伺服器，以網址開啟。
內網子目錄、載入後斷網、表格、圖表公式、圖片與列印已通過瀏覽器測試。
已在 Windows Chromium 以 file:// 驗證離線開啟、圖表、公式字型及本機圖片。

完整操作說明請見「使用說明.md」。
'''
(root / 'dist' / '下載後先看.txt').write_text(instructions, encoding='utf-8-sig')
website = output / 'inkread-offline.zip'
with zipfile.ZipFile(website, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for file in sorted((root / 'dist').rglob('*')):
        if file.is_file() and file.suffix != '.zip':
            archive.write(file, file.relative_to(root / 'dist'))

source = output / 'inkread-source.zip'
with zipfile.ZipFile(source, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for file in sorted(root.rglob('*')):
        relative = file.relative_to(root)
        if any(part in {'node_modules', 'dist', 'test-results', '.git', 'packages', '.browser-cache'} for part in relative.parts):
            continue
        if file.is_file() and file.suffix != '.zip':
            archive.write(file, Path('inkread') / relative)

for filename in (website, source):
    with zipfile.ZipFile(filename) as archive:
        assert archive.testzip() is None
        print(f'{filename}: {filename.stat().st_size:,} bytes; {len(archive.namelist())} files; CRC OK')
