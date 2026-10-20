# 墨閱 Inkread

讓 Markdown 回到好閱讀。繁體中文介面，支援本機文件、好讀的表格、Mermaid 圖表與 LaTeX 公式；所有文件在瀏覽器內處理。

## 直接使用

[開啟線上墨閱](https://koviankevin.github.io/inkread/) · [下載離線網站 ZIP](https://koviankevin.github.io/inkread/inkread-offline.zip) · [GitHub 原始碼](https://github.com/koviankevin/inkread)

下載並解壓縮 **inkread-offline.zip**，雙擊 `index.html` 即可使用。不需要 Node.js、帳號或網際網路。也可以把解壓縮後的所有檔案放到內網靜態網頁伺服器；請保留目錄結構，並確保 `.js`、`.css`、`.woff2` 字型可被讀取。

- **開啟文件**：拖曳或選取 `.md`、`.markdown`、`.txt`。可一次開啟多份文件。
- **匯入資料夾**：選擇文件與圖片的共同上層資料夾，依相對路徑顯示圖片及切換 Markdown 連結。也支援拖曳資料夾。
- **貼上文字**：點擊「貼上 Markdown」，或在閱讀區直接貼上；預覽前可修改文字與檔名。
- **閱讀調整**：左側文件清單、右側章節目錄、13–22 px 字級與亮／暗色模式。
- **程式碼**：常用語言上色與複製按鈕。
- **表格**：欄位對齊、隔行底色、長文字換行；寬表在自身區域內捲動。
- **列印／PDF**：按右上角列印圖示，使用瀏覽器列印或「另存為 PDF」。寬表格請選擇橫向紙張；列印預覽會隱藏側欄與操作介面。

鍵盤快捷鍵：`O` 開啟文件、`/` 搜尋文件、`Esc` 關閉對話框。

## 語法與圖片

支援標題、清單、引用、連結、GFM 表格、勾選清單、刪除線、程式碼區塊；以 `mermaid` 程式碼區塊繪製圖表；`$...$` 行內公式、`$$...$$` 獨立公式。隨附 `samples/` 目錄可用來驗證圖片與文件連結。

Markdown 中的原始 HTML 以文字顯示，不執行腳本。Mermaid 使用嚴格安全模式；自訂設定、點擊連結與外部圖形資源不會執行。語法錯誤的圖表保留原始文字，公式錯誤會標示在內容中。

本機相對圖片需要連同資料夾一起匯入；單獨開啟 `.md` 不會授權瀏覽器讀取其他檔案。支援 PNG、JPEG、GIF、WebP、AVIF、SVG、BMP 與 ICO。遠端圖片預設不載入，須按「允許此文件載入遠端圖片」；離線或連線失敗會顯示提示。瀏覽器可能阻擋 HTTPS 頁面中的 HTTP 圖片。

## 隱私與相容性

沒有後端、文件上傳、追蹤碼、分析或外部 CDN。文件與圖片僅存在此頁面的記憶體中，重新整理或關閉後不會保留；主題與字級儲存在瀏覽器的 localStorage，儲存受限時仍可使用。GitHub Pages 只提供程式檔案，不接收使用者開啟的文件。使用者主動開啟的外部連結或允許載入的遠端圖片會連到對應網站。

主要支援近期 Chrome 與 Edge。資料夾選取使用 `webkitdirectory`，拖曳資料夾使用 File and Directory Entries API。內容以 UTF-8 解碼；其他編碼請先轉為 UTF-8。大文件與複雜圖表的速度依裝置而異；圖表限制 50,000 字元與 500 條邊。內網環境若只允許檔案下載而不提供 HTML 網站服務，請下載後在本機解壓縮開啟。

## 開發與建置

需要 Node.js 22.12+ 與 npm。

```sh
npm ci
npm run build
npm run dev
```

建置結果位於 `dist/`，資源皆為相對路徑，可部署到子目錄或使用 `file://`。JavaScript 分為閱讀器 `app.js`、公式 `math.js`、圖表 `diagrams.js` 與佈局引擎 `elk.js`，皆為一般 IIFE 腳本，避免本機檔案的模組載入限制。公式樣式 `math.css` 與 KaTeX 字型隨包附上；請保留整套檔案。

瀏覽器整合測試：

```sh
# 安裝 Chromium 後，依環境設定瀏覽器位置
CHROMIUM_PATH=/usr/bin/chromium npm test
```

24 組檢查涵蓋 10 組功能、7 組安全／效能及 7 組延遲載入驗證：內網子目錄部署、圖表公式、資料夾圖片與連結、寬表、深色模式、列印、惡意內容、已載入功能斷網使用，以及 Windows 以 `file://` 完全斷網首次開啟圖表、ELK、公式與本機字型。測試結果與截圖存入 `test-results/`。實際公司瀏覽器政策仍需另外驗收。

Windows 可指定測試瀏覽器後執行：

```powershell
$env:CHROMIUM_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm test
```

若本機端點防護軟體向頁面注入腳本，測試仍會封鎖外部請求。經確認的注入主機可用 `INKREAD_TEST_INJECTED_HOSTS` 另列於報告的 `blockedInjectedRequests`；預設不設定任何例外。詳細環境與本次驗收結果見 `交接文件.md`。

## GitHub Pages

儲存庫的 Actions 工作流程會在推送 `main` 後建置網站、打包離線 ZIP 並部署 GitHub Pages。儲存庫的 **Settings → Pages → Source** 需設為 **GitHub Actions**。部署完成後，網站根目錄的 `inkread-offline.zip` 可供下載。

## 第三方授權

本專案採用 [MIT 授權](./LICENSE)，著作權標示為 `Copyright (c) 2026 koviankevin`。可使用、修改、商用及再散布，須保留授權與著作權聲明。第三方元件仍適用各自的授權。

依賴套件包含 Markdown-it、DOMPurify、highlight.js、Mermaid、KaTeX、Lucide 等。建置依 esbuild 的實際輸入蒐集直接及間接套件的完整授權／NOTICE，保留程式碼授權註解，並在網站及離線包附上 `LICENSE` 與 `THIRD-PARTY-NOTICES.txt`。原始碼依賴版本以 `package-lock.json` 鎖定。

## 容量與效能

單份文件上限 2 MiB、匯入文件合計 200 份／20 MiB；單張圖片 20 MiB、圖片合計 100 MiB，每次匯入最多 1,000 份檔案。每份文件最多繪製 20 張 Mermaid 圖，每張最多 50,000 字元及 500 條邊。超長程式碼區塊保留原文與複製功能，超過 20,000 字元時略過上色。

1.2.0 將首載 JavaScript 由 5,898,968 位元組降至 366,024 位元組，減少約 94%；主程式 gzip 約 134 KB。四份 JavaScript 合計 5,531,083 位元組，較 1.1.0 減少約 6.2%。以上不含 CSS、字型與圖片；實際網路壓縮由伺服器決定。

公式或圖表接近可見區域（前後 300 px）時才載入對應程式；同份文件的同類內容會一起繪製。Mermaid 與閱讀器共用公式和淨化套件，ELK 在佈局時才載入；保留 Mermaid 12 的 ELK 預設。右上角列印按鈕會先補齊尚未繪製的內容。

下載版包含所有分檔，完全斷網也能首次使用圖表與公式。線上版首次使用尚未載入的功能仍需連線；已載入的功能可在當次頁面斷網後繼續使用。沒有 Service Worker，穩定離線使用請下載並完整解壓縮 ZIP。

長文件的章節位置會快取；捲動更新每個畫面幀最多一次，使用二分搜尋選取目前章節。文件解析與圖表繪製仍在主執行緒，複雜圖表仍可能短暫停頓。完整圖表引擎仍有較大的首次使用成本。

`npm test` 會執行功能驗收及安全／效能回歸；`npm audit` 查核鎖定依賴的已知弱點。GitHub Pages 部署前也會執行兩者。測試程式 `tests/audit.mjs --baseline` 可對未修改的舊版成品記錄基準，結果在 `test-results/`。

`npm run benchmark:startup` 可測量三次冷啟動中位數（gzip、5 Mbps、50 ms 延遲、CPU 四倍降速），產生 `startup-results.json`。若將舊版完整網站放在 `test-results/startup-baseline/`，會交錯比較兩版；測量指標為閱讀器顯示且標題已插入 DOM 的時間，並非全部圖表完成或實際繪製到螢幕的時間。
