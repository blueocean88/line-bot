require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');

const app = express();

const lineConfig = {
  channelSecret: process.env.CHANNEL_SECRET,
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
});

// 暫存廣告來源用戶（10分鐘內若加入LINE，自動標記為廣告來源）
const adUserIds = new Set();

// ===== 廣告入口頁面（LIFF）=====
// 廣告投放時，把連結設定為此頁面，系統會自動識別來源
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
    setTimeout(() => adUserIds.delete(userId), 10 * 60 * 1000); // 10分鐘自動清除
  }
  res.json({ ok: true });
});

// ===== LINE Webhook =====
app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  res.json({ status: 'ok' });
  await Promise.all(req.body.events.map(handleEvent));
});

async function handleEvent(event) {
  if (event.type === 'follow') {
    const userId = event.source.userId;
    const isAd = adUserIds.has(userId);

    if (isAd) {
      adUserIds.delete(userId);
      // 廣告用戶：廣告版歡迎訊息 + 廣告版圖文選單
      await client.pushMessage({
        to: userId,
        messages: [{ type: 'text', text: process.env.AD_WELCOME_MSG }]
      });
      await client.linkRichMenuIdToUser(userId, process.env.RICHMENU_AD);
    } else {
      // 一般用戶：一般版歡迎訊息 + 一般版圖文選單
      await client.pushMessage({
        to: userId,
        messages: [{ type: 'text', text: process.env.NORMAL_WELCOME_MSG }]
      });
      await client.linkRichMenuIdToUser(userId, process.env.RICHMENU_NORMAL);
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

// 切換付費學員 API
app.post('/set-paid', express.json(), async (req, res) => {
  const { userId, adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: '密碼錯誤' });
  }
  if (!userId) {
    return res.status(400).json({ error: '請提供用戶 ID' });
  }
  try {
    await client.linkRichMenuIdToUser(userId, process.env.RICHMENU_PAID);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Bot 啟動成功，Port: ${PORT}`));
