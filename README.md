# 掃碼派卷測驗範本

用自己的四選一題庫建立線上測驗。老師派卷後可分享網址或 QR Code，學生使用指定代號作答。教師後台提供成績、錯題分析、投影檢討與 CSV 匯出。

[圖文教學](https://littleyi22.github.io/quiz-assignment-template/)

## 本機跑通一份考卷

需要 Node.js 22 以上和 npm。以下指令在儲存庫根目錄執行。

```sh
npm ci
npm run db:init
```

複製 `.dev.vars.example` 為 `.dev.vars`，用你自己的值替換老師登入密碼 `TEACHER_PASSWORD` 與題庫匯入金鑰 `AGENT_API_KEY`。這兩個值用途不同。接著啟動本機 Worker。

```sh
npm run dev
```

另開一個終端機，先用 `--check` 檢查格式，再匯入範例。

```sh
npm run quiz:import -- examples/quiz.json --check
```

在執行匯入的終端機設定 `QUIZ_AGENT_KEY`，值與 `.dev.vars` 的 `AGENT_API_KEY` 相同。匯入工具預設連本機 `http://127.0.0.1:8787`。以下命令只匯入題庫，方便接著練習教師派卷。

```sh
npm run quiz:import -- examples/quiz.json --no-assign
```

1. 開啟 [本機教師後台](http://127.0.0.1:8787/quiz/teacher/)，使用 `TEACHER_PASSWORD` 登入。
2. 選範例試卷，設定開放與截止時間，再選即時核對、做完再核對，或同時開放兩種。
3. 按「派出考卷」，複製顯示的學生網址。清單也有「QR Code」按鈕，可重新開啟或下載 SVG。
4. 在同一電腦開啟學生網址，填虛構班級代碼、座號與作答代號。完成作答後回後台查看成績。跨裝置掃描要用手機可連線的網址，部署後可直接使用正式網址。

## 換自己的題庫

從 `examples/quiz.json` 開始。每一份檔案包含試卷名稱 `title` 與 1～100 題的 `questions`。每題填 `question`、四個 `options`、正解 `answer`（A～D），建議補上 `explanation`。可選填 `part`（題組標題）和 `tag`（主題標籤）。請用自行編寫或有權使用的題目。

執行 `--check` 只檢查檔案。執行 `--no-assign` 只建卷。省略這兩項會同時派卷。API 未指定截止時間時預設自開放起 24 小時，教師後台的時間欄則依瀏覽器時區設定。

## 部署在自己的 Cloudflare 帳號

```sh
npx wrangler login
npx wrangler d1 create quiz-assignment
```

把回傳的資料庫 ID 填入 `wrangler.toml` 的 `database_id`。可自訂 Worker 的 `name`。如果更改資料庫名稱，同步調整設定和命令中的 `quiz-assignment`。

```sh
npx wrangler d1 execute quiz-assignment --remote --file schema.sql
npm run deploy
npx wrangler secret put TEACHER_PASSWORD
npx wrangler secret put AGENT_API_KEY
```

部署後把終端機環境變數 `QUIZ_BASE_URL` 設為 Wrangler 回傳的 HTTPS 站點根網址，並設定與正式 Secret 相同的 `QUIZ_AGENT_KEY`。重新匯入題庫，在該站的 `/quiz/teacher/` 派卷。用手機掃 QR Code，按正式流程交一份測試卷，再到後台確認紀錄。

## 程式怎麼組成

| 檔案 | 負責的功能 |
| --- | --- |
| `public/quiz/index.html` | 學生作答、即時或交卷後核對、題目標記 |
| `public/quiz/teacher/index.html` | 教師登入、派卷、QR Code、成績報告與投影檢討 |
| `src/index.js` | Cloudflare Worker 路由、登入驗證、題庫匯入、派卷與伺服器計分 |
| `schema.sql` | D1 的試卷、題目、派卷、作答與答案資料表 |
| `scripts/agent-create-quiz.mjs` | JSON 題庫檢查與匯入 |
| `docs/` | GitHub Pages 教學頁 |

派卷時 Worker 會建立六碼代碼。教師頁以本站網址加上 `/quiz/?a=代碼` 組成學生入口，並在瀏覽器內用 qrcode-generator 編碼及下載 SVG。這個步驟不把連結轉送到外部 QR Code 服務。學生第一次開卷時，API 回傳題目並建立作答憑證。正解存於 D1，依作答模式在核對時提供結果。第一次交卷是正式成績，之後是練習。

## 資料與適用範圍

範本的資料表從空白開始，題庫是通用示例。正式使用時請發班級代碼、座號與作答代號，避免填真實姓名。作答與成績會保存在部署者的 D1，CSV 匯出後也要妥善保存。續答需使用同一瀏覽器與同一組代碼，該瀏覽器保存作答憑證。學生端沒有帳號驗身，適合課堂練習與低風險評量。

QR Code 編碼使用 qrcode-generator 2.0.4，其 MIT 授權聲明保留在教師頁。
