require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024 } });

const app = express();

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
});

const blobClient = new line.messagingApi.MessagingApiBlobClient({
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
});

// 暫存廣告來源用戶
const adUserIds = new Set();

// ===== 廣告入口頁面（LIFF）=====
app.get('/ad-entry', (req, res) => {
  const liffId = process.env.LIFF_ID;
  const lineOaId = process.env.LINE_OA_ID;
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>載入中...</title>
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
</head>
<body>
  <p style="text-align:center;margin-top:60px;font-family:sans-serif;color:#555;">載入中，請稍候...</p>
  <script>
    liff.init({ liffId: '${liffId}' })
      .then(async () => {
        if (!liff.isLoggedIn()) {
          liff.login({ redirectUri: window.location.href });
          return;
        }
        const profile = await liff.getProfile();
        await fetch('/mark-ad', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: profile.userId })
        });
        if (liff.isInClient()) {
          liff.closeWindow();
        } else {
          window.location.href = 'https://line.me/R/ti/p/${lineOaId}';
        }
      })
      .catch(() => {
        window.location.href = 'https://line.me/R/ti/p/${lineOaId}';
      });
  </script>
</body>
</html>`);
});

// 標記廣告來源
app.post('/mark-ad', express.json(), (req, res) => {
  const { userId } = req.body;
  if (userId) {
    adUserIds.add(userId);
    setTimeout(() => adUserIds.delete(userId), 10 * 60 * 1000);
  }
  res.json({ ok: true });
});

// ===== 重新建立圖文選單（1200x405）=====
app.get('/setup-richmenus', async (req, res) => {
  try {
    // 刪除舊的
    try {
      await client.deleteRichMenu(process.env.RICHMENU_NORMAL);
      await client.deleteRichMenu(process.env.RICHMENU_AD);
      await client.deleteRichMenu(process.env.RICHMENU_PAID);
    } catch(e) {}

    const normal = await client.createRichMenu({
      size: { width: 1200, height: 405 },
      selected: true,
      name: '一般顧客',
      chatBarText: '點我開啟選單',
      areas: [
        { bounds: { x: 0, y: 0, width: 600, height: 405 }, action: { type: 'message', text: '領取免費課程' } },
        { bounds: { x: 600, y: 0, width: 600, height: 405 }, action: { type: 'message', text: '預約1對1試聽' } }
      ]
    });

    const ad = await client.createRichMenu({
      size: { width: 1200, height: 405 },
      selected: true,
      name: '廣告顧客',
      chatBarText: '點我開啟選單',
      areas: [
        { bounds: { x: 0, y: 0, width: 600, height: 405 }, action: { type: 'message', text: '領取免費診斷課' } },
        { bounds: { x: 600, y: 0, width: 600, height: 405 }, action: { type: 'message', text: '預約1對1交易研討會' } }
      ]
    });

    const paid = await client.createRichMenu({
      size: { width: 1200, height: 405 },
      selected: true,
      name: '付費學員',
      chatBarText: '點我開啟選單',
      areas: [
        { bounds: { x: 0, y: 0, width: 600, height: 405 }, action: { type: 'message', text: '預約課程' } },
        { bounds: { x: 600, y: 0, width: 600, height: 405 }, action: { type: 'message', text: '預約查詢' } }
      ]
    });

    res.send(`<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>圖文選單建立成功</title>
<style>body{font-family:sans-serif;padding:32px;background:#f5f5f5;} .card{background:white;padding:24px;border-radius:12px;margin-bottom:16px;box-shadow:0 2px 8px rgba(0,0,0,0.08);} h2{color:#06C755;} code{background:#f0f0f0;padding:4px 8px;border-radius:4px;font-size:13px;word-break:break-all;}</style>
</head>
<body>
<h2>✅ 圖文選單建立成功！</h2>
<p>請把以下 ID 更新到 Render 環境變數：</p>
<div class="card"><b>一般顧客 (RICHMENU_NORMAL)</b><br><br><code>${normal.richMenuId}</code></div>
<div class="card"><b>廣告顧客 (RICHMENU_AD)</b><br><br><code>${ad.richMenuId}</code></div>
<div class="card"><b>付費學員 (RICHMENU_PAID)</b><br><br><code>${paid.richMenuId}</code></div>
<p style="color:#e74c3c;">⚠️ 截圖存好後，到 Render 環境變數更新這三個 ID，然後再來 <a href="/upload-image">上傳圖片</a></p>
</body></html>`);
  } catch (err) {
    res.send('錯誤：' + err.message);
  }
});

// ===== 上傳圖片頁面 =====
app.get('/upload-image', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>上傳圖文選單圖片</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, sans-serif; background: #f0f2f5; padding: 24px 16px; }
    h1 { color: #06C755; font-size: 20px; margin-bottom: 24px; text-align: center; }
    .card { background: white; border-radius: 16px; padding: 24px; max-width: 480px; margin: 0 auto 20px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
    h3 { color: #333; margin-bottom: 16px; font-size: 16px; }
    label { display: block; margin-bottom: 6px; color: #666; font-size: 13px; font-weight: 600; }
    input[type=file] { width: 100%; padding: 10px; margin-bottom: 16px; border: 1.5px dashed #ccc; border-radius: 10px; font-size: 14px; }
    button { width: 100%; background: #06C755; color: white; padding: 12px; border: none; border-radius: 10px; font-size: 15px; font-weight: 600; cursor: pointer; }
    button:hover { background: #05a847; }
    .result { margin-top: 12px; padding: 10px; border-radius: 8px; text-align: center; font-size: 14px; display: none; }
    .success { background: #e6f9ee; color: #1a7f3c; display: block; }
    .error { background: #fdecea; color: #c0392b; display: block; }
    .note { font-size: 12px; color: #999; margin-top: 8px; }
  </style>
</head>
<body>
  <h1>🖼️ 上傳圖文選單圖片</h1>

  <div class="card">
    <h3>📋 一般顧客圖文選單</h3>
    <label>選擇圖片（JPG/PNG，1MB以下）</label>
    <input type="file" id="file-normal" accept="image/jpeg,image/png">
    <button onclick="uploadImage('normal', 'file-normal', 'result-normal')">上傳圖片</button>
    <div id="result-normal" class="result"></div>
    <p class="note">按鈕：領取免費課程 ／ 預約1對1試聽</p>
  </div>

  <div class="card">
    <h3>📢 廣告顧客圖文選單</h3>
    <label>選擇圖片（JPG/PNG，1MB以下）</label>
    <input type="file" id="file-ad" accept="image/jpeg,image/png">
    <button onclick="uploadImage('ad', 'file-ad', 'result-ad')">上傳圖片</button>
    <div id="result-ad" class="result"></div>
    <p class="note">按鈕：領取免費診斷課 ／ 預約1對1交易研討會</p>
  </div>

  <div class="card">
    <h3>🎓 付費學員圖文選單</h3>
    <label>選擇圖片（JPG/PNG，1MB以下）</label>
    <input type="file" id="file-paid" accept="image/jpeg,image/png">
    <button onclick="uploadImage('paid', 'file-paid', 'result-paid')">上傳圖片</button>
    <div id="result-paid" class="result"></div>
    <p class="note">按鈕：預約課程 ／ 預約查詢</p>
  </div>

  <script>
    async function uploadImage(type, fileInputId, resultId) {
      const file = document.getElementById(fileInputId).files[0];
      const resultEl = document.getElementById(resultId);
      resultEl.className = 'result';
      if (!file) {
        resultEl.className = 'result error';
        resultEl.textContent = '❌ 請先選擇圖片';
        return;
      }
      const formData = new FormData();
      formData.append('image', file);
      formData.append('type', type);
      resultEl.className = 'result';
      resultEl.style.display = 'block';
      resultEl.textContent = '⏳ 上傳中...';
      try {
        const res = await fetch('/upload-image', { method: 'POST', body: formData });
        const data = await res.json();
        if (res.ok) {
          resultEl.className = 'result success';
          resultEl.textContent = '✅ 上傳成功！';
        } else {
          resultEl.className = 'result error';
          resultEl.textContent = '❌ ' + (data.error || '上傳失敗');
        }
      } catch {
        resultEl.className = 'result error';
        resultEl.textContent = '❌ 網路錯誤，請重試';
      }
    }
  </script>
</body>
</html>`);
});

// 上傳圖片 API
app.post('/upload-image', upload.single('image'), async (req, res) => {
  const { type } = req.body;
  const menuIds = {
    normal: process.env.RICHMENU_NORMAL,
    ad: process.env.RICHMENU_AD,
    paid: process.env.RICHMENU_PAID,
  };
  const richMenuId = menuIds[type];
  if (!richMenuId) return res.status(400).json({ error: '無效的選單類型' });
  if (!req.file) return res.status(400).json({ error: '請提供圖片' });

  try {
    const contentType = req.file.mimetype;
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(
      `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.CHANNEL_ACCESS_TOKEN}`,
          'Content-Type': contentType,
        },
        body: req.file.buffer,
      }
    );
    if (!response.ok) {
      const errText = await response.text();
      return res.status(500).json({ error: errText });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== LINE Webhook =====
app.post('/webhook', express.json(), async (req, res) => {
  res.status(200).json({ status: 'ok' });
  const events = req.body?.events || [];
  await Promise.all(events.map(handleEvent));
});

async function handleEvent(event) {
  if (event.type === 'follow') {
    const userId = event.source.userId;
    const isAd = adUserIds.has(userId);
    if (isAd) {
      adUserIds.delete(userId);
      await client.pushMessage({ to: userId, messages: [{ type: 'text', text: process.env.AD_WELCOME_MSG }] });
      await client.linkRichMenuIdToUser(userId, process.env.RICHMENU_AD);
    } else {
      await client.pushMessage({ to: userId, messages: [{ type: 'text', text: process.env.NORMAL_WELCOME_MSG }] });
      await client.linkRichMenuIdToUser(userId, process.env.RICHMENU_NORMAL);
    }
  }

  if (event.type === 'message' && event.message.type === 'text') {
    const userId = event.source.userId;
    const replyToken = event.replyToken;
    const text = event.message.text.trim();

    let nickname = '您';
    try {
      const profile = await client.getProfile(userId);
      nickname = profile.displayName;
    } catch (e) {}

    const replies = {
      '領取免費課程': `歡迎領取我們的免費課程：\n📈交易實戰地圖-從零構建「不依賴預測」的穩定獲利模式\n不管你是完全不懂交易者，還是有些交易經驗，但一直沒找到穩定獲利的方法，看完這個課程，將會幫助你在交易中如何穩定獲利，有個完整清晰的架構！💪\n領取連結：https://reurl.cc/QVGV69`,
      '領取免費診斷課': `歡迎領取我們的免費課程：\n📈交易實戰地圖-從零構建「不依賴預測」的穩定獲利模式\n不管你是完全不懂交易者，還是有些交易經驗，但一直沒找到穩定獲利的方法，看完這個課程，將會幫助你在交易中如何穩定獲利，有個完整清晰的架構！💪\n領取連結：https://ads-funnel.pages.dev/free-course`,
      '預約1對1試聽': `🔹【一對一交易研討會】🔹\n${nickname}歡迎你的預約！\n請按照以下步驟完成預約☺️\n🔸步驟一，請複製1️⃣2️⃣3️⃣並填寫資訊\n1️⃣你的姓名：\n2️⃣提供三個您的空閒時段：\n   1. x月x日，18:00\n   2.\n   3.\n3️⃣研討會地點：選擇線上 (google meet) 或實體 (高雄教室)\n補充資訊：\n1.這場研討會的時間預計為1-2小時左右，視當下情況和吸收程度調整。\n2.學院可預約時間為每日下午3點-晚上10點。若您空檔時間較長亦可填寫一個範圍，讓我們能更好安排。\n3.我們的實體教室位在高雄苓雅區，若你交通允許非常歡迎來現場交流參觀。\n🔸步驟二，請填寫簡短問卷\n為了當天能提供你更好的協助，我們需要更了解你的需求，請花2分鐘完成以下問卷👇\nhttps://tally.so/r/kdeRYZ\n📌 完成後，我們將在24小時內主動回覆您，安排專屬一對一時間☺️`,
      '預約1對1交易研討會': `${nickname}歡迎你的預約！\n為了讓這場研討會帶給你更好的幫助，請花3分鐘填寫問卷和時段\n我們將在48小時內回覆你☺️\nhttps://ads-funnel.pages.dev/booking\n(如果尚未觀看免費診斷課，請先點下方選單觀看後再來預約~)`,
    };

    if (replies[text]) {
      await client.replyMessage({ replyToken, messages: [{ type: 'text', text: replies[text] }] });
    }
  }
}

// ===== 管理後台 =====
app.get('/admin', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LINE Bot 管理後台</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, sans-serif; background: #f0f2f5; min-height: 100vh; padding: 24px 16px; }
    h1 { color: #06C755; font-size: 22px; margin-bottom: 24px; text-align: center; }
    .card { background: white; border-radius: 16px; padding: 24px; max-width: 440px; margin: 0 auto; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
    h3 { color: #333; margin-bottom: 20px; font-size: 17px; }
    label { display: block; margin-bottom: 6px; color: #666; font-size: 13px; font-weight: 600; }
    input { width: 100%; padding: 12px; margin-bottom: 16px; border: 1.5px solid #e0e0e0; border-radius: 10px; font-size: 15px; outline: none; transition: border 0.2s; }
    input:focus { border-color: #06C755; }
    button { width: 100%; background: #06C755; color: white; padding: 14px; border: none; border-radius: 10px; font-size: 16px; font-weight: 600; cursor: pointer; transition: background 0.2s; }
    button:hover { background: #05a847; }
    .result { margin-top: 16px; padding: 12px 16px; border-radius: 10px; text-align: center; font-size: 15px; display: none; }
    .success { background: #e6f9ee; color: #1a7f3c; display: block; }
    .error { background: #fdecea; color: #c0392b; display: block; }
    .hint { margin-top: 16px; padding: 12px; background: #f8f9fa; border-radius: 10px; font-size: 12px; color: #888; line-height: 1.6; }
  </style>
</head>
<body>
  <h1>🟢 LINE Bot 管理後台</h1>
  <div class="card">
    <h3>🎓 切換為付費學員</h3>
    <label>顧客的 LINE User ID</label>
    <input type="text" id="userId" placeholder="Uxxxxxxxxxxxxxxxxx">
    <label>管理員密碼</label>
    <input type="password" id="adminKey" placeholder="輸入管理員密碼">
    <button onclick="setPaid()">✅ 切換為付費學員介面</button>
    <div id="result" class="result"></div>
    <div class="hint">
      💡 如何取得顧客的 LINE User ID？<br>
      在 LINE Official Account Manager → 聊天 → 點開顧客對話 → 右側「用戶資料」即可看到 User ID
    </div>
  </div>
  <script>
    async function setPaid() {
      const userId = document.getElementById('userId').value.trim();
      const adminKey = document.getElementById('adminKey').value.trim();
      const resultEl = document.getElementById('result');
      resultEl.className = 'result';
      if (!userId || !adminKey) {
        resultEl.className = 'result error';
        resultEl.textContent = '❌ 請填寫所有欄位';
        return;
      }
      try {
        const res = await fetch('/set-paid', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, adminKey })
        });
        const data = await res.json();
        if (res.ok) {
          resultEl.className = 'result success';
          resultEl.textContent = '✅ 已成功切換為付費學員圖文選單！';
          document.getElementById('userId').value = '';
        } else {
          resultEl.className = 'result error';
          resultEl.textContent = '❌ ' + (data.error || '發生錯誤');
        }
      } catch {
        resultEl.className = 'result error';
        resultEl.textContent = '❌ 網路錯誤，請重試';
      }
    }
  </script>
</body>
</html>`);
});

app.post('/set-paid', express.json(), async (req, res) => {
  const { userId, adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: '密碼錯誤' });
  if (!userId) return res.status(400).json({ error: '請提供用戶 ID' });
  try {
    await client.linkRichMenuIdToUser(userId, process.env.RICHMENU_PAID);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ===== 設定預設圖文選單 =====
app.get('/set-default-richmenu', async (req, res) => {
  try {
    const richMenuId = process.env.RICHMENU_NORMAL;
    await client.setDefaultRichMenu(richMenuId);
    res.send('✅ 預設圖文選單設定成功！所有未指定的用戶都會看到一般版圖文選單。');
  } catch (err) {
    res.send('❌ 錯誤：' + err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Bot 啟動成功，Port: ${PORT}`));
