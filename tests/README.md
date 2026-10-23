# Browser acceptance

`media-switch.mjs` is mandatory in Chromium and Firefox/WebKit CI: 12 checks per engine, with image/diagram/formula/mixed A/B documents. It holds actual runtime requests while switching, repeats rapid A→B→A→B followed by real user scrolling, and releases old loads after a keyboard switch. The mixed-media switch uses a narrow viewport and native simulated touchscreen input, including reopening the sidebar. The direct-switch cases force-close the entire context without relying on unload, and the other cases close the reader through normal unload before the process. Every case closes the full persistent browser and restarts with native `context.setOffline(true)` before navigation. It verifies each document’s own image pixels, diagram label, formula, paragraph and internal fraction. On Firefox, offline contexts intentionally omit request routing because routing prevents worker navigation in this combination. The server/proxy and URL hooks are QA-only; saved document and image bytes are unmodified. Deployed-site runs use `INKREAD_TEST_SITE`; local runs can select pristine output with `INKREAD_TEST_DIST`.

`reading-controls.mjs` 也須覆蓋只改頁首高度、在 ResizeObserver 之前立即保存，檢查點的區塊與畫面段落必須相符，並驗證完整離線重開。一般捲動不可逐段量測；合併恢復的既有精度門檻不變。

`library.mjs` 的模擬配額失敗／立即關閉案例，需比對原章節在視窗內的 offset，維持 8px 精度；保存或錯誤狀態列換行可令整頁 scrollY 改變而文字位置相同。不要用整頁絕對捲動值替代閱讀位置。

`merge.mjs` 記錄預期位置前先等待本機圖片解碼與版面穩定，避免預期值仍受100px圖片的未完成載入影響。`reading-controls.mjs` 另外在觀察器執行前直接改文章內部高度，檢查實際段落的同步保存及離線重開；此項確實驗證未穩定版面的資料正確性，合併恢復仍維持8px精度。

`reading-controls.mjs` 以原生鍵盤／滑鼠按鈕測試手動13–22字級、反覆變化、真實捲動後重新保存、書末與完整離線重啟；調整後不重新捲回目標。Chromium 原生瀏覽器縮放另外透過一次性無額外權限 helper 的 chrome.tabs.setZoom，核對80/125/150/200/100%、內寬及DPR，含150%倍率保留及混合字級後離線重開。使用 Playwright bundled Chromium channel，需先 `npx playwright-core install chromium`；不以CSS zoom或viewport模擬代替。Firefox/WebKit只執行手動字級案例，原生縮放未驗證。完整及相容性CI皆必跑新測試。

`font-progress.mjs` 另驗證視窗寬高、手機 viewport 直橫向、快速縮放、離開檢查點及不同尺寸離線重開；比對實際段落與段內位置，並覆蓋書末。備份測試須往返可選 block 定位，舊欄位缺省與非法值必須分別接受及拒絕。

`tests/font-progress.mjs` 驗證 16→18 後的實際段落與段內位置，不以捲動像素或整章百分比替代；覆蓋舊格式、其他未開啟文件、完整離線重啟與手動字級。完整及相容性測試皆必須執行；備份的可選原字級欄位需保留並驗證範圍。

`tests/verify.mjs` 另驗證 1.7.3 字級遷移：以舊版 localStorage 的 16 升到 18、其他 13–22 字級保留、新版手動選回 16 後重開保留。初始化不建立手動選擇紀錄；無效手動資料不覆蓋可用偏好。

`npm test` runs ten Chromium suites (113 checks), including true
Playwright offline emulation and full `file://` transfers. The Pages workflow runs
this suite exactly once per PR, main push or manual dispatch.

## Focused compatibility jobs

```sh
npm ci
npx playwright-core install --with-deps firefox webkit
npm run build
INKREAD_BROWSER=firefox npm run test:compat
INKREAD_BROWSER=webkit npm run test:compat
```

These commands reuse `backup.mjs` and `merge.mjs`, their original fixtures, UI
interactions, rollback injection, progress assertions and backup codec. There is
no new runner/framework. `INKREAD_BROWSER` defaults to Chromium and rejects typos.
Only the two library suites run in the Firefox/WebKit matrix; they do not repeat
the general rendering, security, lazy-loading or cache-repair suites.

`pages.yml` calls `compatibility.yml` as a local reusable workflow at the same
commit. Its Firefox/WebKit jobs retain the 12-minute ceiling and no fail-fast;
the Pages build retains the full Chromium suite (15-minute ceiling). These jobs
run in parallel. There is no second independent main/PR compatibility trigger
and no duplicate Chromium run.

Deployment requires both `build` and the complete `compatibility` matrix to
succeed in this run. Failure, cancellation or a skipped dependency blocks it.
Only main pushes or manual dispatches on main can deploy; PRs and manual runs
on other branches validate and upload artifacts without deployment. The tested
build packages `dist/inkread-offline.zip` and uploads the Pages artifact; deployment
uses that same run's artifact, without rebuilding or looking up other runs.
Chromium and per-browser diagnostics are retained for 7 days, including failures.
Only the deploy job receives Pages/OIDC write permissions. PR runs use read-only
repository permissions. This does not change repository branch protection.

`npm run test:ci` parses both workflow files and checks the dependency graph,
triggers, exact source checkout, matrix, test commands, artifact flow and write
permissions. It evaluates the actual deploy condition against all combinations
of success/failure/cancelled/skipped dependencies, PR/non-main events and a
cancelled run. Mutation cases ensure that removing a prerequisite, weakening the
gate, ignoring test failures or reintroducing independent triggers is rejected.
This is a configuration contract, not a simulated GitHub scheduler; live Actions
must still confirm PR deployment is skipped and the main deployment succeeds.

| Risk | Executed assertions |
| --- | --- |
| Format 1 | Download through the UI, inspect manifest version, decode original UTF-8/image bytes/progress; preview, cancel, corrupt input rejection and replace |
| Partial data loss | Inject IndexedDB transaction abort during replacement and merge; assert destination documents/images remain unchanged; retry succeeds |
| Concurrent writes | Another tab changes the destination after preview; stale merge is rejected and requires fresh choices |
| Keep both / format 2 | Original and renamed copies, independent red/green image pixels and bytes, root/reference document links, separate reading progress; inspect exported manifest version 2 |
| Reopening | Close and relaunch real persistent profiles; verify chosen/current copies and progress without reimporting |
| Second transfer | Restore the actual downloaded format 1 and format 2 archives into a fresh HTTP profile; check both copies, image bytes/pixels, document links and progress |
| v1.7.1 sidebar | Examples initially closed; matching search opens them temporarily; clearing restores closed/open state; no-match empty state; keyboard expansion and manual state survive document selection |
| Phone-sized UI | 390 and 320 px viewports: document list retained, real restore file chooser, restore mode control, dialog fits horizontally, cancel accessible and leaves list intact; existing merge conflict interaction at 390 px |

Counts include existing Node.js codec/planner checks, not just browser scenarios.
Download events and `saveAs` are required: no synthetic archive substitutes for
an actual downloaded UI backup. Failed HTTP downloads, IndexedDB writes, progress,
image pixels or restore assertions fail the job; they are never capability skips.
Browser-specific output lives in `test-results/firefox/` and `test-results/webkit/`.
JSON, failure diagnostics and screenshots are uploaded even on failure, for 7 days.

## Scope and platform limits

- **Offline:** Firefox/WebKit compatibility cases warm the real service worker,
  then make the origin return HTTP 503, including across persistent-profile
  relaunch. Restores/exports use local files and cached resources. This verifies
  an unavailable server, **not a physical/network-disconnect test**. The original
  Chromium suite still uses `context.setOffline(true)`. This avoids conflating
  WebKit's offline-emulation navigation problem with app data loss; see
  [Playwright issue #42775](https://github.com/microsoft/playwright/issues/42775).
  Cache readiness is required; errors are not silently ignored.
- **IndexedDB:** WebKit uses fresh persistent profiles even for the donor and
  second-transfer destination. Playwright WebKit ephemeral/private sessions cannot
  persist image Blobs (upstream [#42795](https://github.com/microsoft/playwright/issues/42795));
  the initial ephemeral-context run stalled on its first Blob transaction. This is
  not worked around by bypassing IndexedDB or removing images. Normal-profile
  transactions and image bytes must pass. Private-mode support remains unverified.
  Real transactions and image Blobs are tested on localhost (a
  secure origin). Persistent-profile relaunch tests disk persistence. Private
  browsing, quota eviction, clearing site data and enterprise policies still need
  environment-specific acceptance. Tests never treat an HTTP storage failure as
  an expected browser limitation.
- **Downloads:** headless Playwright confirms the download event, `.inkread`
  filename and saved bytes. It cannot certify Safari/iOS Files app prompts,
  permissions, share sheet or a user's download location.
- **`file://`:** each compatibility run separately probes secure context, Web
  Crypto and an IndexedDB Blob write/read on the extracted app. Its JSON explicitly
  reports unavailable APIs as local-file restrictions. Even when APIs exist, this
  probe **does not certify a full Firefox/WebKit file transfer**. Full local-file
  backup/restore remains covered by Chromium. A file-origin restriction is not an
  HTTP restore failure; use HTTPS/localhost and a portable backup when needed.
- **WebKit is not Safari:** Linux Playwright WebKit is an engine build, not Apple's
  Safari app. Desktop viewport resizing is not an iPhone/iPad. Real Safari/macOS,
  iOS/iPadOS storage, offline cold launch, native chooser/download and touch/keyboard
  behavior remain unverified. See [Playwright browser documentation](https://playwright.dev/docs/browsers).

A passing CI run must be linked to its exact PR head; adding these tests alone is
not evidence that they passed. Historical v1.7.0/v1.7.1 release runs do not validate
this new matrix.

## Re-export regression found by this matrix

The initial persistent WebKit run restored a 14,634-byte format 1 archive, closed
and reopened the profile, then exported again. Both the generated Blob and the
real download were 29,150 bytes while the manifest declared 14,634 bytes; the
strict decoder correctly rejected it. The extra 14,516 bytes equal the backing
archive minus its 118-byte SVG image. The corrupt image payload was byte-for-byte equal to the entire first archive.
This isolates file-backed slice bounds after IndexedDB rehydration, rather than
an incomplete download.

`decodeBackup` now materializes verified image bytes before they enter IndexedDB,
so storage never receives a slice backed by the uploaded archive. `encodeBackup`
also reads each image into bytes, hashes those same bytes, and appends a fresh Blob.
It checks the read length against the saved Blob size;
format 1/2 and strict decoding stay unchanged. Materialization adds temporary
memory for one image (bounded by the existing 20 MiB per-image limit), and keeps
up to the existing 100 MiB of image payload in the output chunks. Both the
re-export and subsequent fresh-profile restore remain mandatory browser checks.
The regression was observed in Linux Playwright WebKit; Safari/iOS behavior is
not inferred from that result.
