# Web Video Podcasts

英語、國語和粵語的影片播客目錄。支援搜尋、語言與主題篩選、節目收藏和 YouTube 播放續看。收藏與進度存在目前瀏覽器。

## 本機預覽

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

從此目錄啟動後，打開 http://127.0.0.1:8080/ 。網站無需安裝套件或編譯。

## 更新內容

- `catalog.json` 是節目目錄。`id` 用來連接節目、分類與單集。
- `episodes.json` 的 `categories` 定義節目分類。每集需要唯一的 `id`、`showId`、`title` 和 `publishedAt`。
- 可嵌入的 YouTube 完整單集填入 `youtube` 影片 ID。其他平台可填 `url` 指向原始單集。`duration` 和 `chapters` 使用秒數。
- 挑選完整正片並核對語言。部分發行方限制嵌入，播放器保留原平台入口。內容清單目前手動更新。

所有影音由原平台提供。
