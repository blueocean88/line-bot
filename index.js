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

// ===== Supabase 工具函式 =====
async function supabase(method, path, body) {
  const fetch = (await import('node-fetch')).default;
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
      'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (method === 'GET' || (method === 'POST' && res.headers.get('content-type')?.includes('json'))) {
    return res.json();
  }
  return res;
}

async function getUser(userId) {
  const data = await supabase('GET', `users?user_id=eq.${userId}&limit=1`);
  return Array.isArray(data) ? data[0] : null;
}

async function upsertUser(userId, name, source) {
  const existing = await getUser(userId);
  if (!existing) {
    await supabase('POST', 'users', {
      user_id: userId,
      name,
      source,
      joined_at: new Date().toISOString(),
      status: '一般'
    });
  }
}

async function updateUser(userId, fields) {
  await supabase('PATCH', `users?user_id=eq.${userId}`, fields);
}

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

// 標記廣告來源
app.post('/mark-ad', express.json(), (req, res) => {
  const { userId } = req.body;
  if (userId) {
    adUserIds.add(userId);
    setTimeout(() => adUserIds.delete(userId), 10 * 60 * 1000);
  }
  res.json({ ok: true });
});

// 學員升級 API
app.post('/api/join-paid', express.json(), async (req, res) => {
  const { userId, name } = req.body;
  if (!userId) return res.status(400).json({ error: '缺少用戶 ID' });
  try {
    await client.linkRichMenuIdToUser(userId, process.env.RICHMENU_PAID);
    const existing = await getUser(userId);
    const now = new Date().toISOString();
    if (existing) {
      const joinedAt = new Date(existing.joined_at);
      const days = Math.floor((new Date() - joinedAt) / (1000 * 60 * 60 * 24));
      await updateUser(userId, { status: '付費學員', paid_at: now, days_to_convert: days });
    } else {
      await supabase('POST', 'users', {
        user_id: userId, name, source: '業務', joined_at: now,
        status: '付費學員', paid_at: now, days_to_convert: 0
      });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== 圖文選單設定 =====
app.get('/setup-richmenus', async (req, res) => {
  try {
    try {
      await client.deleteRichMenu(process.env.RICHMENU_NORMAL);
      await client.deleteRichMenu(process.env.RICHMENU_AD);
      await client.deleteRichMenu(process.env.RICHMENU_PAID);
    } catch(e) {}
    const normal = await client.createRichMenu({ size: { width: 1200, height: 405 }, selected: true, name: '一般顧客', chatBarText: '點我開啟選單', areas: [{ bounds: { x: 0, y: 0, width: 600, height: 405 }, action: { type: 'message', text: '領取免費課程' } }, { bounds: { x: 600, y: 0, width: 600, height: 405 }, action: { type: 'message', text: '預約1對1試聽' } }] });
    const ad = await client.createRichMenu({ size: { width: 1200, height: 405 }, selected: true, name: '廣告顧客', chatBarText: '點我開啟選單', areas: [{ bounds: { x: 0, y: 0, width: 600, height: 405 }, action: { type: 'message', text: '領取免費診斷課' } }, { bounds: { x: 600, y: 0, width: 600, height: 405 }, action: { type: 'message', text: '預約1對1交易研討會' } }] });
    const paid = await client.createRichMenu({ size: { width: 1200, height: 405 }, selected: true, name: '付費學員', chatBarText: '點我開啟選單', areas: [{ bounds: { x: 0, y: 0, width: 600, height: 405 }, action: { type: 'message', text: '預約課程' } }, { bounds: { x: 600, y: 0, width: 600, height: 405 }, action: { type: 'message', text: '預約查詢' } }] });
    res.send(`<h2>✅ 成功</h2><p>RICHMENU_NORMAL: ${normal.richMenuId}</p><p>RICHMENU_AD: ${ad.richMenuId}</p><p>RICHMENU_PAID: ${paid.richMenuId}</p>`);
  } catch (err) { res.send('錯誤：' + err.message); }
});

// ===== 上傳圖片 =====
app.get('/upload-image', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:sans-serif;padding:24px;background:#f0f2f5;}.card{background:white;border-radius:16px;padding:24px;max-width:480px;margin:0 auto 20px;box-shadow:0 2px 12px rgba(0,0,0,0.08);}h1{color:#06C755;text-align:center;}button{width:100%;background:#06C755;color:white;padding:12px;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;}.result{margin-top:12px;padding:10px;border-radius:8px;text-align:center;display:none;}.success{background:#e6f9ee;color:#1a7f3c;display:block;}.error{background:#fdecea;color:#c0392b;display:block;}</style></head><body>
  <h1>上傳圖文選單圖片</h1>
  <div class="card"><h3>一般顧客</h3><input type="file" id="f1" accept="image/jpeg,image/png"><button onclick="up('normal','f1','r1')">上傳</button><div id="r1" class="result"></div></div>
  <div class="card"><h3>廣告顧客</h3><input type="file" id="f2" accept="image/jpeg,image/png"><button onclick="up('ad','f2','r2')">上傳</button><div id="r2" class="result"></div></div>
  <div class="card"><h3>付費學員</h3><input type="file" id="f3" accept="image/jpeg,image/png"><button onclick="up('paid','f3','r3')">上傳</button><div id="r3" class="result"></div></div>
  <script>async function up(type,fid,rid){const file=document.getElementById(fid).files[0];const el=document.getElementById(rid);if(!file){el.className='result error';el.textContent='請先選擇圖片';return;}const fd=new FormData();fd.append('image',file);fd.append('type',type);el.style.display='block';el.textContent='上傳中...';try{const res=await fetch('/upload-image',{method:'POST',body:fd});const data=await res.json();if(res.ok){el.className='result success';el.textContent='上傳成功！';}else{el.className='result error';el.textContent=data.error||'失敗';}}catch{el.className='result error';el.textContent='網路錯誤';}}</script>
  </body></html>`);
});

app.post('/upload-image', upload.single('image'), async (req, res) => {
  const menuIds = { normal: process.env.RICHMENU_NORMAL, ad: process.env.RICHMENU_AD, paid: process.env.RICHMENU_PAID };
  const richMenuId = menuIds[req.body.type];
  if (!richMenuId || !req.file) return res.status(400).json({ error: '參數錯誤' });
  try {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.CHANNEL_ACCESS_TOKEN}`, 'Content-Type': req.file.mimetype },
      body: req.file.buffer,
    });
    if (!response.ok) return res.status(500).json({ error: await response.text() });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== 設定預設圖文選單 =====
app.get('/set-default-richmenu', async (req, res) => {
  try {
    await client.setDefaultRichMenu(process.env.RICHMENU_NORMAL);
    res.send('✅ 預設圖文選單設定成功！');
  } catch (err) { res.send('❌ 錯誤：' + err.message); }
});

// ===== 管理後台 =====
app.get('/admin', (req, res) => {
  const liffId = process.env.LIFF_ID || '';
  const joinLink = 'https://liff.line.me/' + liffId + '?path=/join-paid';
  const scriptOpen = '<scr' + 'ipt>';
  const scriptClose = '<\/scr' + 'ipt>';
  const html = [
    '<!DOCTYPE html><html><head><meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<title>LINE Bot 管理後台</title>',
    '<style>',
    '*{box-sizing:border-box;margin:0;padding:0;}',
    'body{font-family:-apple-system,sans-serif;background:#f0f2f5;min-height:100vh;padding:24px 16px;}',
    'h1{color:#06C755;font-size:22px;margin-bottom:24px;text-align:center;}',
    '.card{background:white;border-radius:16px;padding:24px;max-width:520px;margin:0 auto 20px;box-shadow:0 2px 12px rgba(0,0,0,0.08);}',
    'h3{color:#333;margin-bottom:16px;font-size:17px;}',
    'label{display:block;margin-bottom:6px;color:#666;font-size:13px;font-weight:600;}',
    'input,select{width:100%;padding:12px;margin-bottom:12px;border:1.5px solid #e0e0e0;border-radius:10px;font-size:15px;outline:none;}',
    'input:focus,select:focus{border-color:#06C755;}',
    '.btn{width:100%;padding:13px;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;margin-bottom:8px;}',
    '.btn-green{background:#06C755;color:white;}',
    '.result{margin-top:12px;padding:12px;border-radius:10px;text-align:center;font-size:14px;display:none;}',
    '.success{background:#e6f9ee;color:#1a7f3c;display:block;}',
    '.error{background:#fdecea;color:#c0392b;display:block;}',
    '.hint{margin-top:12px;padding:10px;background:#f8f9fa;border-radius:8px;font-size:12px;color:#888;line-height:1.6;}',
    'table{width:100%;border-collapse:collapse;font-size:13px;}',
    'th{background:#f0f2f5;padding:8px;text-align:left;font-size:12px;color:#666;}',
    'td{padding:8px;border-bottom:1px solid #f0f0f0;vertical-align:middle;}',
    '.remove-btn{background:#fdecea;color:#e74c3c;border:none;padding:4px 8px;border-radius:6px;cursor:pointer;font-size:12px;}',
    '.join-link{background:#f0f2f5;padding:10px;border-radius:8px;font-size:13px;word-break:break-all;margin-top:8px;}',
    '.stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:8px;}',
    '.stat-box{background:#f8f9fa;border-radius:10px;padding:16px;text-align:center;}',
    '.stat-num{font-size:28px;font-weight:700;color:#06C755;}',
    '.stat-label{font-size:12px;color:#888;margin-top:4px;}',
    '.period-btn{padding:6px 12px;border:1.5px solid #e0e0e0;background:white;border-radius:8px;cursor:pointer;font-size:13px;margin-right:6px;margin-bottom:8px;}',
    '.period-btn.active{background:#06C755;color:white;border-color:#06C755;}',
    '</style></head><body>',
    '<h1>LINE Bot 管理後台</h1>',

    '<div class="card">',
    '<h3>學員註冊連結</h3>',
    '<p style="font-size:14px;color:#666;margin-bottom:8px;">傳給付費學員，點一下即可自動升級：</p>',
    '<div class="join-link" id="joinLink">' + joinLink + '</div>',
    '<button class="btn btn-green" style="margin-top:12px;" id="copyBtn">複製連結</button>',
    '<div id="copy-result" class="result"></div>',
    '</div>',

    '<div class="card">',
    '<h3>手動切換付費學員</h3>',
    '<label>顧客的 LINE User ID</label>',
    '<input type="text" id="userId" placeholder="Uxxxxxxxxxxxxxxxxx">',
    '<label>管理員密碼</label>',
    '<input type="password" id="adminKey" placeholder="輸入管理員密碼">',
    '<button class="btn btn-green" id="setPaidBtn">切換為付費學員</button>',
    '<div id="result" class="result"></div>',
    '<div class="hint">取得 User ID：請學員傳任意訊息後，到 Render Logs 查看</div>',
    '</div>',

    '<div class="card">',
    '<h3>數據統計</h3>',
    '<label>管理員密碼</label>',
    '<input type="password" id="statsKey" placeholder="輸入管理員密碼">',
    '<div style="margin-bottom:12px;">',
    '<button class="period-btn active" id="btn-week" onclick="loadStats(\'week\')">本週</button>',
    '<button class="period-btn" id="btn-month" onclick="loadStats(\'month\')">本月</button>',
    '<button class="period-btn" id="btn-quarter" onclick="loadStats(\'quarter\')">本季</button>',
    '<button class="period-btn" id="btn-year" onclick="loadStats(\'year\')">本年</button>',
    '<button class="period-btn" id="btn-all" onclick="loadStats(\'all\')">全部</button>',
    '</div>',
    '<button class="btn btn-green" id="loadStatsBtn">載入數據</button>',
    '<div id="stats-result" style="margin-top:16px;"></div>',
    '</div>',

    '<div class="card">',
    '<h3>用戶名單</h3>',
    '<label>管理員密碼</label>',
    '<input type="password" id="listKey" placeholder="輸入管理員密碼">',
    '<select id="sourceFilter"><option value="">全部來源</option><option value="廣告">廣告</option><option value="業務">業務</option></select>',
    '<select id="statusFilter"><option value="">全部狀態</option><option value="一般">一般</option><option value="付費學員">付費學員</option></select>',
    '<button class="btn btn-green" id="loadListBtn">載入名單</button>',
    '<div id="user-list" style="margin-top:16px;overflow-x:auto;"></div>',
    '</div>',

    scriptOpen,
    'var currentPeriod="week";',
    'document.getElementById("copyBtn").addEventListener("click",function(){',
    '  var link=document.getElementById("joinLink").textContent.trim();',
    '  navigator.clipboard.writeText(link).then(function(){',
    '    var el=document.getElementById("copy-result");',
    '    el.className="result success";el.textContent="已複製！";',
    '    setTimeout(function(){el.style.display="none";},2000);',
    '  });',
    '});',
    'document.getElementById("setPaidBtn").addEventListener("click",function(){',
    '  var userId=document.getElementById("userId").value.trim();',
    '  var adminKey=document.getElementById("adminKey").value.trim();',
    '  var el=document.getElementById("result");el.className="result";',
    '  if(!userId||!adminKey){el.className="result error";el.textContent="請填寫所有欄位";return;}',
    '  fetch("/set-paid",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({userId:userId,adminKey:adminKey})})',
    '  .then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d};});})',
    '  .then(function(x){',
    '    if(x.ok){el.className="result success";el.textContent="切換成功！";document.getElementById("userId").value="";}',
    '    else{el.className="result error";el.textContent="錯誤："+(x.d.error||"發生錯誤");}',
    '  }).catch(function(){el.className="result error";el.textContent="網路錯誤";});',
    '});',
    'function loadStats(period){',
    '  currentPeriod=period;',
    '  ["week","month","quarter","year","all"].forEach(function(p){',
    '    document.getElementById("btn-"+p).className="period-btn"+(p===period?" active":"");',
    '  });',
    '}',
    'document.getElementById("loadStatsBtn").addEventListener("click",function(){',
    '  var adminKey=document.getElementById("statsKey").value.trim();',
    '  var el=document.getElementById("stats-result");',
    '  if(!adminKey){el.innerHTML="<p>請輸入密碼</p>";return;}',
    '  el.innerHTML="<p>載入中...</p>";',
    '  fetch("/api/stats?adminKey="+encodeURIComponent(adminKey)+"&period="+currentPeriod)',
    '  .then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d};});})',
    '  .then(function(x){',
    '    if(!x.ok){el.innerHTML="<p>錯誤："+x.d.error+"</p>";return;}',
    '    var s=x.d;',
    '    el.innerHTML=',
    '      \'<div class="stat-grid">\'+',
    '      \'<div class="stat-box"><div class="stat-num">\'+s.total+\'</div><div class="stat-label">總加入人數</div></div>\'+',
    '      \'<div class="stat-box"><div class="stat-num">\'+s.paid+\'</div><div class="stat-label">付費學員</div></div>\'+',
    '      \'<div class="stat-box"><div class="stat-num">\'+s.ad+\'</div><div class="stat-label">廣告來源</div></div>\'+',
    '      \'<div class="stat-box"><div class="stat-num">\'+s.organic+\'</div><div class="stat-label">業務來源</div></div>\'+',
    '      \'<div class="stat-box"><div class="stat-num">\'+s.blocked+\'</div><div class="stat-label">已封鎖</div></div>\'+',
    '      \'<div class="stat-box"><div class="stat-num">\'+s.convRate+\'%</div><div class="stat-label">廣告轉換率</div></div>\'+',
    '      \'</div>\';',
    '  }).catch(function(){el.innerHTML="<p>網路錯誤</p>";});',
    '});',
    'document.getElementById("loadListBtn").addEventListener("click",function(){',
    '  var adminKey=document.getElementById("listKey").value.trim();',
    '  var source=document.getElementById("sourceFilter").value;',
    '  var status=document.getElementById("statusFilter").value;',
    '  var el=document.getElementById("user-list");',
    '  if(!adminKey){el.innerHTML="<p>請輸入密碼</p>";return;}',
    '  el.innerHTML="<p>載入中...</p>";',
    '  var url="/api/users?adminKey="+encodeURIComponent(adminKey);',
    '  if(source)url+="&source="+encodeURIComponent(source);',
    '  if(status)url+="&status="+encodeURIComponent(status);',
    '  fetch(url)',
    '  .then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d};});})',
    '  .then(function(x){',
    '    if(!x.ok){el.innerHTML="<p>錯誤："+x.d.error+"</p>";return;}',
    '    if(x.d.users.length===0){el.innerHTML="<p>沒有符合的用戶</p>";return;}',
    '    var html=\'<table><tr><th>姓名</th><th>來源</th><th>狀態</th><th>加入時間</th><th>操作</th></tr>\';',
    '    x.d.users.forEach(function(u){',
    '      var date=new Date(u.joined_at).toLocaleDateString("zh-TW");',
    '      html+=\'<tr><td>\'+u.name+\'</td><td>\'+u.source+\'</td><td>\'+u.status+\'</td><td>\'+date+\'</td><td><button class="remove-btn" data-uid="\'+u.user_id+\'" data-ak="\'+adminKey+\'">移除</button></td></tr>\';',
    '    });',
    '    html+=\'</table>\';',
    '    el.innerHTML=html;',
    '    el.querySelectorAll(".remove-btn").forEach(function(btn){',
    '      btn.addEventListener("click",function(){',
    '        var uid=this.getAttribute("data-uid");',
    '        var ak=this.getAttribute("data-ak");',
    '        if(!confirm("確定要移除？"))return;',
    '        fetch("/api/remove-student",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({userId:uid,adminKey:ak})})',
    '        .then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d};});})',
    '        .then(function(x){',
    '          if(x.ok){document.getElementById("loadListBtn").click();}',
    '          else{alert("錯誤："+x.d.error);}',
    '        });',
    '      });',
    '    });',
    '  }).catch(function(){el.innerHTML="<p>網路錯誤</p>";});',
    '});',
    scriptClose,
    '</body></html>'
  ].join('\n');
  res.send(html);
});

// 統計 API
app.get('/api/stats', async (req, res) => {
  const { adminKey, period } = req.query;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: '密碼錯誤' });
  try {
    let dateFilter = '';
    const now = new Date();
    if (period === 'week') {
      const start = new Date(now); start.setDate(now.getDate() - now.getDay());
      dateFilter = `&joined_at=gte.${start.toISOString()}`;
    } else if (period === 'month') {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      dateFilter = `&joined_at=gte.${start.toISOString()}`;
    } else if (period === 'quarter') {
      const q = Math.floor(now.getMonth() / 3);
      const start = new Date(now.getFullYear(), q * 3, 1);
      dateFilter = `&joined_at=gte.${start.toISOString()}`;
    } else if (period === 'year') {
      const start = new Date(now.getFullYear(), 0, 1);
      dateFilter = `&joined_at=gte.${start.toISOString()}`;
    }
    const users = await supabase('GET', `users?select=*${dateFilter}`);
    if (!Array.isArray(users)) return res.status(500).json({ error: '資料庫錯誤' });
    const total = users.length;
    const paid = users.filter(u => u.status === '付費學員').length;
    const ad = users.filter(u => u.source === '廣告').length;
    const organic = users.filter(u => u.source === '業務').length;
    const blocked = users.filter(u => u.blocked_at).length;
    const adPaid = users.filter(u => u.source === '廣告' && u.status === '付費學員').length;
    const convRate = ad > 0 ? Math.round(adPaid / ad * 100) : 0;
    res.json({ total, paid, ad, organic, blocked, convRate });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 用戶名單 API
app.get('/api/users', async (req, res) => {
  const { adminKey, source, status } = req.query;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: '密碼錯誤' });
  try {
    let query = 'users?select=*&order=joined_at.desc';
    if (source) query += `&source=eq.${encodeURIComponent(source)}`;
    if (status) query += `&status=eq.${encodeURIComponent(status)}`;
    const users = await supabase('GET', query);
    res.json({ users: Array.isArray(users) ? users : [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 手動切換付費學員 API
app.post('/set-paid', express.json(), async (req, res) => {
  const { userId, adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: '密碼錯誤' });
  if (!userId) return res.status(400).json({ error: '請提供用戶 ID' });
  try {
    await client.linkRichMenuIdToUser(userId, process.env.RICHMENU_PAID);
    const existing = await getUser(userId);
    const now = new Date().toISOString();
    if (existing) {
      const days = Math.floor((new Date() - new Date(existing.joined_at)) / (1000 * 60 * 60 * 24));
      await updateUser(userId, { status: '付費學員', paid_at: now, days_to_convert: days });
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 移除學員 API
app.post('/api/remove-student', express.json(), async (req, res) => {
  const { userId, adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: '密碼錯誤' });
  try {
    await client.linkRichMenuIdToUser(userId, process.env.RICHMENU_NORMAL);
    await updateUser(userId, { status: '一般', paid_at: null, days_to_convert: null });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== LINE Webhook =====
app.post('/webhook', express.json(), async (req, res) => {
  res.status(200).json({ status: 'ok' });
  const events = req.body?.events || [];
  await Promise.all(events.map(handleEvent));
});

async function handleEvent(event) {
  // 新用戶加入
  if (event.type === 'follow') {
    const userId = event.source.userId;
    const isAd = adUserIds.has(userId);
    let profile = { displayName: '未知' };
    try { profile = await client.getProfile(userId); } catch(e) {}
    if (isAd) {
      adUserIds.delete(userId);
      await upsertUser(userId, profile.displayName, '廣告');
      await client.pushMessage({ to: userId, messages: [{ type: 'text', text: process.env.AD_WELCOME_MSG }] });
      await client.linkRichMenuIdToUser(userId, process.env.RICHMENU_AD);
    } else {
      await upsertUser(userId, profile.displayName, '業務');
      await client.pushMessage({ to: userId, messages: [{ type: 'text', text: process.env.NORMAL_WELCOME_MSG }] });
      await client.linkRichMenuIdToUser(userId, process.env.RICHMENU_NORMAL);
    }
  }

  // 用戶封鎖
  if (event.type === 'unfollow') {
    const userId = event.source.userId;
    await updateUser(userId, { blocked_at: new Date().toISOString() });
  }

  // 訊息處理
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

    // 記錄行為
    if (text === '領取免費課程' || text === '領取免費診斷課') {
      await updateUser(userId, { free_course_at: new Date().toISOString() });
    }
    if (text === '預約1對1試聽' || text === '預約1對1交易研討會') {
      await updateUser(userId, { consultation_at: new Date().toISOString() });
    }

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
