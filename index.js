require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024 } });

const app = express();

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
});

const adUserIds = new Set();

// ===== JSONBin 工具函式 =====
async function getStudents() {
  const fetch = (await import('node-fetch')).default;
  const binId = process.env.JSONBIN_BIN_ID;
  if (!binId) return [];
  try {
    const res = await fetch(`https://api.jsonbin.io/v3/b/${binId}/latest`, {
      headers: { 'X-Master-Key': process.env.JSONBIN_KEY }
    });
    const data = await res.json();
    return data.record?.students || [];
  } catch { return []; }
}

async function saveStudents(students) {
  const fetch = (await import('node-fetch')).default;
  const binId = process.env.JSONBIN_BIN_ID;
  if (!binId) return;
  await fetch(`https://api.jsonbin.io/v3/b/${binId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Master-Key': process.env.JSONBIN_KEY
    },
    body: JSON.stringify({ students })
  });
}

async function initBin() {
  const fetch = (await import('node-fetch')).default;
  if (process.env.JSONBIN_BIN_ID) return;
  try {
    const res = await fetch('https://api.jsonbin.io/v3/b', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': process.env.JSONBIN_KEY,
        'X-Bin-Name': 'line-bot-students'
      },
      body: JSON.stringify({ students: [] })
    });
    const data = await res.json();
    console.log(`✅ JSONBin 建立成功！請到 Render 環境變數新增：JSONBIN_BIN_ID = ${data.metadata.id}`);
  } catch (e) {
    console.log('JSONBin 初始化失敗：', e.message);
  }
}
initBin();

// ===== 廣告入口頁面 =====
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
        const urlParams = new URLSearchParams(window.location.search);
        const path = urlParams.get('path');
        if (path === '/join-paid') {
          await fetch('/api/join-paid', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: profile.userId, name: profile.displayName })
          });
          document.body.innerHTML = '<p style="text-align:center;margin-top:60px;font-family:sans-serif;color:#06C755;font-size:20px;">✅ 學員身份認證成功！<br><br>請回到 LINE 查看你的專屬選單 😊</p>';
        } else {
          await fetch('/mark-ad', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: profile.userId })
          });
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

// ===== 學員註冊連結 =====
app.get('/join-paid', (req, res) => {
  const liffId = process.env.LIFF_ID;
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>學員認證中...</title>
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
</head>
<body>
  <p style="text-align:center;margin-top:60px;font-family:sans-serif;color:#555;">學員身份認證中，請稍候...</p>
  <script>
    liff.init({ liffId: '${liffId}' })
      .then(async () => {
        if (!liff.isLoggedIn()) {
          liff.login({ redirectUri: window.location.href });
          return;
        }
        const profile = await liff.getProfile();
        const res = await fetch('/api/join-paid', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: profile.userId, name: profile.displayName })
        });
        const data = await res.json();
        if (data.ok) {
          document.body.innerHTML = '<p style="text-align:center;margin-top:60px;font-family:sans-serif;color:#06C755;font-size:20px;">✅ 學員身份認證成功！<br><br>請回到 LINE 查看你的專屬選單 😊</p>';
        } else {
          document.body.innerHTML = '<p style="text-align:center;margin-top:60px;font-family:sans-serif;color:#e74c3c;">❌ 認證失敗，請聯繫客服</p>';
        }
      });
  </script>
</body>
</html>`);
});

// 學員自動升級 API
app.post('/api/join-paid', express.json(), async (req, res) => {
  const { userId, name } = req.body;
  if (!userId) return res.status(400).json({ error: '缺少用戶 ID' });
  try {
    await client.linkRichMenuIdToUser(userId, process.env.RICHMENU_PAID);
    const students = await getStudents();
    if (!students.find(s => s.userId === userId)) {
      students.push({ userId, name, joinedAt: new Date().toISOString() });
      await saveStudents(students);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// ===== 上傳圖片 =====
app.get('/upload-image', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>上傳圖文選單圖片</title>
  <style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:-apple-system,sans-serif;background:#f0f2f5;padding:24px 16px;}.card{background:white;border-radius:16px;padding:24px;max-width:480px;margin:0 auto 20px;box-shadow:0 2px 12px rgba(0,0,0,0.08);}h1{color:#06C755;font-size:20px;margin-bottom:24px;text-align:center;}h3{color:#333;margin-bottom:16px;}label{display:block;margin-bottom:6px;color:#666;font-size:13px;font-weight:600;}input[type=file]{width:100%;padding:10px;margin-bottom:16px;border:1.5px dashed #ccc;border-radius:10px;}button{width:100%;background:#06C755;color:white;padding:12px;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;}.result{margin-top:12px;padding:10px;border-radius:8px;text-align:center;display:none;}.success{background:#e6f9ee;color:#1a7f3c;display:block;}.error{background:#fdecea;color:#c0392b;display:block;}.note{font-size:12px;color:#999;margin-top:8px;}</style>
</head>
<body>
  <h1>🖼️ 上傳圖文選單圖片</h1>
  <div class="card"><h3>📋 一般顧客</h3><input type="file" id="f1" accept="image/jpeg,image/png"><button onclick="up('normal','f1','r1')">上傳</button><div id="r1" class="result"></div><p class="note">按鈕：領取免費課程 ／ 預約1對1試聽</p></div>
  <div class="card"><h3>📢 廣告顧客</h3><input type="file" id="f2" accept="image/jpeg,image/png"><button onclick="up('ad','f2','r2')">上傳</button><div id="r2" class="result"></div><p class="note">按鈕：領取免費診斷課 ／ 預約1對1交易研討會</p></div>
  <div class="card"><h3>🎓 付費學員</h3><input type="file" id="f3" accept="image/jpeg,image/png"><button onclick="up('paid','f3','r3')">上傳</button><div id="r3" class="result"></div><p class="note">按鈕：預約課程 ／ 預約查詢</p></div>
  <script>
    async function up(type,fid,rid){
      const file=document.getElementById(fid).files[0];
      const el=document.getElementById(rid);
      if(!file){el.className='result error';el.textContent='❌ 請先選擇圖片';return;}
      const fd=new FormData();fd.append('image',file);fd.append('type',type);
      el.style.display='block';el.textContent='⏳ 上傳中...';
      try{
        const res=await fetch('/upload-image',{method:'POST',body:fd});
        const data=await res.json();
        if(res.ok){el.className='result success';el.textContent='✅ 上傳成功！';}
        else{el.className='result error';el.textContent='❌ '+(data.error||'失敗');}
      }catch{el.className='result error';el.textContent='❌ 網路錯誤';}
    }
  </script>
</body></html>`);
});

app.post('/upload-image', upload.single('image'), async (req, res) => {
  const { type } = req.body;
  const menuIds = { normal: process.env.RICHMENU_NORMAL, ad: process.env.RICHMENU_AD, paid: process.env.RICHMENU_PAID };
  const richMenuId = menuIds[type];
  if (!richMenuId) return res.status(400).json({ error: '無效類型' });
  if (!req.file) return res.status(400).json({ error: '請提供圖片' });
  try {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.CHANNEL_ACCESS_TOKEN}`, 'Content-Type': req.file.mimetype },
      body: req.file.buffer,
    });
    if (!response.ok) return res.status(500).json({ error: await response.text() });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== 設定預設圖文選單 =====
app.get('/set-default-richmenu', async (req, res) => {
  try {
    await client.setDefaultRichMenu(process.env.RICHMENU_NORMAL);
    res.send('✅ 預設圖文選單設定成功！');
  } catch (err) {
    res.send('❌ 錯誤：' + err.message);
  }
});

// ===== 管理後台 =====
app.get('/admin', (req, res) => {
  const liffId = process.env.LIFF_ID || '';
  const joinLink = 'https://liff.line.me/' + liffId + '?path=/join-paid';
  const scriptOpen = '<scr' + 'ipt>';
  const scriptClose = '<\/scr' + 'ipt>';
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LINE Bot 管理後台</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,sans-serif;background:#f0f2f5;min-height:100vh;padding:24px 16px;}
h1{color:#06C755;font-size:22px;margin-bottom:24px;text-align:center;}
.card{background:white;border-radius:16px;padding:24px;max-width:500px;margin:0 auto 20px;box-shadow:0 2px 12px rgba(0,0,0,0.08);}
h3{color:#333;margin-bottom:16px;font-size:17px;}
label{display:block;margin-bottom:6px;color:#666;font-size:13px;font-weight:600;}
input{width:100%;padding:12px;margin-bottom:12px;border:1.5px solid #e0e0e0;border-radius:10px;font-size:15px;outline:none;}
input:focus{border-color:#06C755;}
.btn{width:100%;padding:13px;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;margin-bottom:8px;}
.btn-green{background:#06C755;color:white;}
.result{margin-top:12px;padding:12px;border-radius:10px;text-align:center;font-size:14px;display:none;}
.success{background:#e6f9ee;color:#1a7f3c;display:block;}
.error{background:#fdecea;color:#c0392b;display:block;}
.hint{margin-top:12px;padding:10px;background:#f8f9fa;border-radius:8px;font-size:12px;color:#888;line-height:1.6;}
table{width:100%;border-collapse:collapse;font-size:14px;}
th{background:#f0f2f5;padding:10px;text-align:left;font-size:13px;color:#666;}
td{padding:10px;border-bottom:1px solid #f0f0f0;vertical-align:middle;}
.remove-btn{background:#fdecea;color:#e74c3c;border:none;padding:5px 10px;border-radius:6px;cursor:pointer;font-size:12px;}
.join-link{background:#f0f2f5;padding:10px;border-radius:8px;font-size:13px;word-break:break-all;margin-top:8px;}
</style>
</head>
<body>
<h1>LINE Bot 管理後台</h1>
<div class="card">
  <h3>學員註冊連結</h3>
  <p style="font-size:14px;color:#666;margin-bottom:8px;">將此連結傳給付費學員，點一下即可自動升級：</p>
  <div class="join-link" id="joinLink">${joinLink}</div>
  <button class="btn btn-green" style="margin-top:12px;" id="copyBtn">複製連結</button>
  <div id="copy-result" class="result"></div>
</div>
<div class="card">
  <h3>手動切換付費學員</h3>
  <label>顧客的 LINE User ID</label>
  <input type="text" id="userId" placeholder="Uxxxxxxxxxxxxxxxxx">
  <label>管理員密碼</label>
  <input type="password" id="adminKey" placeholder="輸入管理員密碼">
  <button class="btn btn-green" id="setPaidBtn">切換為付費學員</button>
  <div id="result" class="result"></div>
  <div class="hint">取得 User ID：請學員傳任意訊息後，到 Render Logs 查看</div>
</div>
<div class="card">
  <h3>付費學員名單</h3>
  <label>管理員密碼</label>
  <input type="password" id="adminKey2" placeholder="輸入管理員密碼">
  <button class="btn btn-green" id="loadBtn">載入名單</button>
  <div id="student-list" style="margin-top:16px;"></div>
</div>
${scriptOpen}
document.getElementById('copyBtn').addEventListener('click', function() {
  var link = document.getElementById('joinLink').textContent.trim();
  navigator.clipboard.writeText(link).then(function() {
    var el = document.getElementById('copy-result');
    el.className = 'result success';
    el.textContent = '已複製！';
    setTimeout(function(){ el.style.display='none'; }, 2000);
  });
});

document.getElementById('setPaidBtn').addEventListener('click', function() {
  var userId = document.getElementById('userId').value.trim();
  var adminKey = document.getElementById('adminKey').value.trim();
  var el = document.getElementById('result');
  el.className = 'result';
  if (!userId || !adminKey) { el.className='result error'; el.textContent='請填寫所有欄位'; return; }
  fetch('/set-paid', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({userId:userId, adminKey:adminKey}) })
  .then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
  .then(function(x) {
    if (x.ok) { el.className='result success'; el.textContent='切換成功！'; document.getElementById('userId').value=''; }
    else { el.className='result error'; el.textContent='錯誤：'+(x.d.error||'發生錯誤'); }
  }).catch(function(){ el.className='result error'; el.textContent='網路錯誤'; });
});

document.getElementById('loadBtn').addEventListener('click', function() {
  var adminKey = document.getElementById('adminKey2').value.trim();
  var el = document.getElementById('student-list');
  if (!adminKey) { el.innerHTML='<p>請輸入密碼</p>'; return; }
  el.innerHTML = '<p>載入中...</p>';
  fetch('/api/students?adminKey=' + encodeURIComponent(adminKey))
  .then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
  .then(function(x) {
    if (!x.ok) { el.innerHTML='<p>錯誤：' + x.d.error + '</p>'; return; }
    if (x.d.students.length === 0) { el.innerHTML='<p>目前沒有付費學員</p>'; return; }
    var html = '<table><tr><th>名稱</th><th>加入時間</th><th>操作</th></tr>';
    x.d.students.forEach(function(s) {
      var date = new Date(s.joinedAt).toLocaleDateString('zh-TW');
      html += '<tr><td>' + s.name + '</td><td>' + date + '</td><td><button class="remove-btn" data-uid="' + s.userId + '" data-ak="' + adminKey + '">移除</button></td></tr>';
    });
    html += '</table>';
    el.innerHTML = html;
    el.querySelectorAll('.remove-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var uid = this.getAttribute('data-uid');
        var ak = this.getAttribute('data-ak');
        if (!confirm('確定要移除這位學員嗎？')) return;
        fetch('/api/remove-student', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({userId:uid, adminKey:ak}) })
        .then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
        .then(function(x) {
          if (x.ok) { document.getElementById('loadBtn').click(); }
          else { alert('錯誤：' + x.d.error); }
        }).catch(function(){ alert('網路錯誤'); });
      });
    });
  }).catch(function(){ el.innerHTML='<p>網路錯誤</p>'; });
});
${scriptClose}
</body>
</html>`);
});


// 取得學員名單 API
app.get('/api/students', async (req, res) => {
  const { adminKey } = req.query;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: '密碼錯誤' });
  const students = await getStudents();
  res.json({ students });
});

// 移除學員 API
app.post('/api/remove-student', express.json(), async (req, res) => {
  const { userId, adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: '密碼錯誤' });
  try {
    await client.linkRichMenuIdToUser(userId, process.env.RICHMENU_NORMAL);
    const students = await getStudents();
    await saveStudents(students.filter(s => s.userId !== userId));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 手動切換付費學員 API
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
      console.log(`📩 訊息來自：${profile.displayName} | User ID：${userId}`);
    } catch (e) {}

    const replies = {
      '領取免費課程': `歡迎領取我們的免費課程：

📈交易實戰地圖-從零構建「不依賴預測」的穩定獲利模式

不管你是完全不懂交易者，還是有些交易經驗，但一直沒找到穩定獲利的方法，看完這個課程，將會幫助你在交易中如何穩定獲利，有個完整清晰的架構！💪

領取連結：https://reurl.cc/QVGV69`,

      '領取免費診斷課': `歡迎領取我們的免費課程：

📈交易實戰地圖-從零構建「不依賴預測」的穩定獲利模式

不管你是完全不懂交易者，還是有些交易經驗，但一直沒找到穩定獲利的方法，看完這個課程，將會幫助你在交易中如何穩定獲利，有個完整清晰的架構！💪

領取連結：https://ads-funnel.pages.dev/free-course`,

      '預約1對1試聽': `🔹【一對一交易研討會】🔹

${nickname}歡迎你的預約！
請按照以下步驟完成預約☺️

🔸步驟一，請複製1️⃣2️⃣3️⃣並填寫資訊

1️⃣你的姓名：
2️⃣提供三個您的空閒時段：
   1. x月x日，18:00
   2.
   3.
3️⃣研討會地點：選擇線上 (google meet) 或實體 (高雄教室)

補充資訊：
1. 這場研討會的時間預計為1-2小時左右，視當下情況和吸收程度調整。
2. 學院可預約時間為每日下午3點-晚上10點。若您空檔時間較長亦可填寫一個範圍，讓我們能更好安排。
3. 我們的實體教室位在高雄苓雅區，若你交通允許非常歡迎來現場交流參觀。

🔸步驟二，請填寫簡短問卷

為了當天能提供你更好的協助，我們需要更了解你的需求，請花2分鐘完成以下問卷👇
https://tally.so/r/kdeRYZ

📌 完成後，我們將在24小時內主動回覆您，安排專屬一對一時間☺️`,

      '預約1對1交易研討會': `${nickname}歡迎你的預約！

為了讓這場研討會帶給你更好的幫助，請花3分鐘填寫問卷和時段
我們將在48小時內回覆你☺️

https://ads-funnel.pages.dev/booking

(如果尚未觀看免費診斷課，請先點下方選單觀看後再來預約~)`,

      '預約查詢': `請稍候～將會由專人確認你是否完成預約☑️`,

      '預約課程': `【課程預約】📖

請協助提供以下資訊
我們會為你安排上課時間！

姓名：
欲預約之時段：
偏好的上課方式（線上／實體）：

提供後，我們會盡快與你確認上課安排！`,
    };

    if (replies[text]) {
      await client.replyMessage({ replyToken, messages: [{ type: 'text', text: replies[text] }] });
    }
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Bot 啟動成功，Port: ${PORT}`));
