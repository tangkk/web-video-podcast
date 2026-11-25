# Web Video Podcasts

英語、國語和粵語的影片播客目錄。支援搜尋、語言與主題篩選、節目收藏和 YouTube 播放續看。收藏與進度存在目前瀏覽器，也可用同步碼跨裝置合併。

## 多裝置同步

從頁首打開 **同步**，產生或輸入同步碼，按 **儲存並同步**。在其他裝置使用同一組同步碼可合併收藏與續看進度。可中斷個別裝置的同步並保留該裝置資料。同步碼可存取這些同步資料，請只分享給你信任的人。

影片站使用與 Web Podcasts 相同的服務，資料存於獨立的 `video-podcasts` 命名空間。

## 本機預覽

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

從此目錄啟動後，打開 http://127.0.0.1:8080/ 。網站無需安裝套件或編譯。

## 自動更新

GitHub Actions 每天在台北時間 08:17 檢查一次官方 YouTube 節目源，也可在 Actions 的 **Update and deploy video podcasts** 手動執行。新增且可嵌入的完整單集會寫入 `episodes.json`，同一次工作流程會部署到 GitHub Pages。定時檢查沒有新增時保留線上版本。

`scripts/video-sources.json` 登錄可自動更新的官方頻道、單集時長與各節目的標題篩選。來源暫時失敗時保留既有單集。未登錄更新源的節目可繼續手動新增。每檔節目保留最近 20 集自動收錄的單集及全部手工選片。

可在本機試跑並查看結果：

```sh
node scripts/update-videos.mjs --dry-run
node scripts/update-videos.mjs --dry-run --show=huberman-lab
```

## 更新內容

- `catalog.json` 是節目目錄。`id` 用來連接節目、分類與單集。
- `episodes.json` 的 `categories` 定義節目分類。每集需要唯一的 `id`、`showId`、`title` 和 `publishedAt`。
- 可嵌入的 YouTube 完整單集填入 `youtube` 影片 ID。其他平台可填 `url` 指向原始單集。`duration` 和 `chapters` 使用秒數。
- 挑選完整正片並核對語言。部分發行方限制嵌入，播放器保留原平台入口。

所有影音由原平台提供。
