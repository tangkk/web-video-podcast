# Web Video Podcasts

英語、國語和粵語的 YouTube 影片播客目錄。只保留以官方 YouTube 視頻 ID 收錄的單集，支援搜尋、語言與主題篩選、收藏、進度續看及節目歷史分頁。收藏與進度存在目前瀏覽器。

## 本機預覽

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

瀏覽 http://127.0.0.1:8080/ 。不需要前端編譯。

## YouTube 同步（需設定 API Key）

在 Google Cloud Console 啟用 **YouTube Data API v3**，建立 API Key，存入 GitHub repository Actions secret **`YOUTUBE_API_KEY`**。不要把 Key 提交到 Git 或公開前端。沒有這個 Secret，排程會明確失敗而不更動既有目錄。

資料來源位於 `scripts/video-sources.json`，必須使用合法的 YouTube channel ID，並以 `titlePattern` / `excludePattern` 篩掉非正式播客、精華或剪輯。相同頻道可以服務不同節目，但應給每個節目互斥的標題規則。

```sh
YOUTUBE_API_KEY=... node scripts/sync-youtube.mjs --dry-run --show=lex-fridman
YOUTUBE_API_KEY=... node scripts/sync-youtube.mjs --backfill --dry-run
YOUTUBE_API_KEY=... node scripts/sync-youtube.mjs --backfill
```

- **每日增量**：讀取每個已登錄頻道最新約 100 部上傳、取得時長與嵌入權限、補充新集；永不因集數超過 20 就截斷歷史。
- **每週全歷史**：逐頁讀取全部 uploads playlist，補上所有可獲取的過往完整集。也可從 Actions 的 `workflow_dispatch` 手動運行全量回填。
- **每次執行**：以 `videos.list` 檢查目錄內每個 YouTube ID 是否仍公開且允許嵌入，排除失效影片。既有人工選集的章節資訊會保留。
- **安全性**：任何 API 失敗都不應視作影片不存在；當全部來源不可用時保留既有清單。YouTube 嵌入限制可能依地區、瀏覽器或日後權限變化不同，前端仍保留原平台連結。

## 資料維護

- `catalog.json` 定義節目名稱、語言、官網與分類。
- `episodes.json` 定義單集及分類，官方 YouTube 單集以唯一 `youtube` ID 索引；完整單集資料不設固定歷史保留上限。
- `scripts/video-sources.json` 定義可自動追蹤的官方頻道及收錄規則。
- 僅含外部連結、沒有 YouTube 影片 ID 的節目已不再進入正式目錄。新候選在確認官方頻道及完整單集品質後才應加入。
- 站內嵌入可用性以 API 的 `status.embeddable` 初步篩查，不構成所有地區的 100% 保證。

## 更新及部署

`.github/workflows/video-pages.yml` 每天在台北時間 08:17 進行增量同步，並於週日 09:43 執行全量回填（GitHub Actions 的 UTC cron）；新內容會 commit 回 `episodes.json` 並部署 GitHub Pages。一般 push 仍會部署網站。

## 發布前確認

1. 已新增 repository secret `YOUTUBE_API_KEY`，且有足夠 API quota。
2. 手動執行一次 Action 的全量回填，檢查日誌以及 Lex Fridman 等節目的歷史集數。
3. 實測內嵌播放器在主要使用地區的播放效果；API 的 `embeddable` 並不涵蓋所有播放錯誤。
4. 確認收錄數及品質，再合併 PR。外部網站無法保證所有歷史影片仍公開或可內嵌。
