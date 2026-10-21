# Browser acceptance

`npm test` retains the seven existing Chromium suites (66 checks), including true
Playwright offline emulation and full `file://` transfers. `pages.yml` is unchanged:
Chromium acceptance still gates the release build and Pages deployment.

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

The independent `compatibility.yml` runs on PRs, main and manual dispatch, with
separate Firefox/WebKit jobs (12-minute ceiling, no fail-fast), plus the original
full Chromium suite (15-minute ceiling). This workflow does not deploy. Its checks
are additional CI signals; it does not change repository branch-protection rules
or make Firefox/WebKit prerequisites of the existing Pages deployment.

| Risk | Executed assertions |
| --- | --- |
| Format 1 | Download through the UI, inspect manifest version, decode original UTF-8/image bytes/progress; preview, cancel, corrupt input rejection and replace |
| Partial data loss | Inject IndexedDB transaction abort during replacement and merge; assert destination documents/images remain unchanged; retry succeeds |
| Concurrent writes | Another tab changes the destination after preview; stale merge is rejected and requires fresh choices |
| Keep both / format 2 | Original and renamed copies, independent red/green image pixels and bytes, root/reference document links, separate reading progress; inspect exported manifest version 2 |
| Reopening | Close and relaunch real persistent profiles; verify chosen/current copies and progress without reimporting |
| Second transfer | Restore the actual downloaded format 2 archive into a fresh HTTP profile; check both copies, image bytes/pixels, document links and progress |
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
- **IndexedDB:** real transactions and image Blobs are tested on localhost (a
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
