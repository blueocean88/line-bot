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

// ===== Supabase =====
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
      user_id: userId, name, source,
      joined_at: new Date().toISOString(),
      status: '潛在客'
    });
  }
}

async function updateUser(userId, fields) {
  await supabase('PATCH', `users?user_id=eq.${userId}`, fields);
}

// ===== 廣告入口 =====
app.get('/ad-entry', (req, res) => {
  const liffId = process.env.LIFF_ID;
  const lineOaId = process.env.LINE_OA_ID;
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></scr` + `ipt></head>
<body><p style="text-align:center;margin-top:60px;font-family:sans-serif;color:#555;">載入中...</p>
<scr` + `ipt>
liff.init({liffId:'${liffId}'}).then(async()=>{
  if(!liff.isLoggedIn()){liff.login({redirectUri:window.location.href});return;}
  const profile=await liff.getProfile();
  const path=new URLSearchParams(window.location.search).get('path');
  if(path==='/join-paid'){
    await fetch('/api/join-paid',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:profile.userId,name:profile.displayName})});
    document.body.innerHTML='<p style="text-align:center;margin-top:60px;font-family:sans-serif;color:#06C755;font-size:20px;">✅ 學員身份認證成功！<br><br>請回到 LINE 查看你的專屬選單 😊</p>';
  } else {
    await fetch('/mark-ad',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:profile.userId})});
    window.location.href='https://line.me/R/ti/p/${lineOaId}';
  }
}).catch(()=>{window.location.href='https://line.me/R/ti/p/${lineOaId}';});
</scr` + `ipt></body></html>`);
});

app.post('/mark-ad', express.json(), (req, res) => {
  const { userId } = req.body;
  if (userId) { adUserIds.add(userId); setTimeout(() => adUserIds.delete(userId), 10 * 60 * 1000); }
  res.json({ ok: true });
});

app.post('/api/join-paid', express.json(), async (req, res) => {
  const { userId, name } = req.body;
  if (!userId) return res.status(400).json({ error: '缺少用戶 ID' });
  try {
    await client.linkRichMenuIdToUser(userId, process.env.RICHMENU_PAID);
    const existing = await getUser(userId);
    const now = new Date().toISOString();
    if (existing) {
      const days = Math.floor((new Date() - new Date(existing.joined_at)) / 86400000);
      await updateUser(userId, { status: '付費學員', paid_at: now, days_to_convert: days });
    } else {
      await supabase('POST', 'users', { user_id: userId, name, source: '一般', joined_at: now, status: '付費學員', paid_at: now, days_to_convert: 0 });
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== 圖文選單 =====
app.get('/setup-richmenus', async (req, res) => {
  try {
    try { await client.deleteRichMenu(process.env.RICHMENU_NORMAL); } catch(e) {}
    try { await client.deleteRichMenu(process.env.RICHMENU_AD); } catch(e) {}
    try { await client.deleteRichMenu(process.env.RICHMENU_PAID); } catch(e) {}
    const normal = await client.createRichMenu({ size:{width:1200,height:405}, selected:true, name:'一般顧客', chatBarText:'點我開啟選單', areas:[{bounds:{x:0,y:0,width:600,height:405},action:{type:'message',text:'領取免費課程'}},{bounds:{x:600,y:0,width:600,height:405},action:{type:'message',text:'預約1對1試聽'}}] });
    const ad = await client.createRichMenu({ size:{width:1200,height:405}, selected:true, name:'廣告顧客', chatBarText:'點我開啟選單', areas:[{bounds:{x:0,y:0,width:600,height:405},action:{type:'message',text:'領取免費診斷課'}},{bounds:{x:600,y:0,width:600,height:405},action:{type:'message',text:'預約1對1交易研討會'}}] });
    const paid = await client.createRichMenu({ size:{width:1200,height:405}, selected:true, name:'付費學員', chatBarText:'點我開啟選單', areas:[{bounds:{x:0,y:0,width:600,height:405},action:{type:'message',text:'預約課程'}},{bounds:{x:600,y:0,width:600,height:405},action:{type:'message',text:'預約查詢'}}] });
    res.send(`<h2>✅ 成功</h2><p>RICHMENU_NORMAL: ${normal.richMenuId}</p><p>RICHMENU_AD: ${ad.richMenuId}</p><p>RICHMENU_PAID: ${paid.richMenuId}</p>`);
  } catch (err) { res.send('錯誤：' + err.message); }
});

app.get('/upload-image', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:sans-serif;padding:24px;background:#1a1a2e;color:#fff;}.card{background:#16213e;border-radius:12px;padding:20px;max-width:480px;margin:0 auto 16px;border:1px solid #2d2d4e;}h1{color:#a78bfa;text-align:center;margin-bottom:24px;}button{background:#a78bfa;color:#fff;padding:10px;border:none;border-radius:8px;width:100%;cursor:pointer;font-size:14px;}.result{margin-top:10px;padding:8px;border-radius:6px;text-align:center;display:none;}.ok{background:#1a4731;color:#6ee7b7;display:block;}.err{background:#4c1d1d;color:#fca5a5;display:block;}</style></head><body>
  <h1>上傳圖文選單圖片</h1>
  <div class="card"><h3>一般顧客</h3><input type="file" id="f1" accept="image/jpeg,image/png"><button onclick="up('normal','f1','r1')">上傳</button><div id="r1" class="result"></div></div>
  <div class="card"><h3>廣告顧客</h3><input type="file" id="f2" accept="image/jpeg,image/png"><button onclick="up('ad','f2','r2')">上傳</button><div id="r2" class="result"></div></div>
  <div class="card"><h3>付費學員</h3><input type="file" id="f3" accept="image/jpeg,image/png"><button onclick="up('paid','f3','r3')">上傳</button><div id="r3" class="result"></div></div>
  <scr` + `ipt>async function up(t,f,r){const file=document.getElementById(f).files[0];const el=document.getElementById(r);if(!file){el.className='result err';el.textContent='請選圖片';return;}const fd=new FormData();fd.append('image',file);fd.append('type',t);el.style.display='block';el.textContent='上傳中...';try{const res=await fetch('/upload-image',{method:'POST',body:fd});const d=await res.json();if(res.ok){el.className='result ok';el.textContent='✅ 成功';}else{el.className='result err';el.textContent=d.error;}}catch{el.className='result err';el.textContent='網路錯誤';}}</scr` + `ipt></body></html>`);
});

app.post('/upload-image', upload.single('image'), async (req, res) => {
  const menuIds = { normal: process.env.RICHMENU_NORMAL, ad: process.env.RICHMENU_AD, paid: process.env.RICHMENU_PAID };
  const richMenuId = menuIds[req.body.type];
  if (!richMenuId || !req.file) return res.status(400).json({ error: '參數錯誤' });
  try {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${process.env.CHANNEL_ACCESS_TOKEN}`, 'Content-Type': req.file.mimetype }, body: req.file.buffer,
    });
    if (!response.ok) return res.status(500).json({ error: await response.text() });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/set-default-richmenu', async (req, res) => {
  try { await client.setDefaultRichMenu(process.env.RICHMENU_NORMAL); res.send('✅ 完成'); }
  catch (err) { res.send('❌ ' + err.message); }
});

// ===== API =====
app.get('/api/stats', async (req, res) => {
  const { adminKey, period } = req.query;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: '密碼錯誤' });
  try {
    let dateFilter = '';
    const now = new Date();
    if (period === 'week') { const s=new Date(now); s.setDate(now.getDate()-now.getDay()); dateFilter=`&joined_at=gte.${s.toISOString()}`; }
    else if (period === 'month') { dateFilter=`&joined_at=gte.${new Date(now.getFullYear(),now.getMonth(),1).toISOString()}`; }
    else if (period === 'quarter') { const q=Math.floor(now.getMonth()/3); dateFilter=`&joined_at=gte.${new Date(now.getFullYear(),q*3,1).toISOString()}`; }
    else if (period === 'year') { dateFilter=`&joined_at=gte.${new Date(now.getFullYear(),0,1).toISOString()}`; }
    const users = await supabase('GET', `users?select=*${dateFilter}`);
    if (!Array.isArray(users)) return res.status(500).json({ error: '資料庫錯誤' });
    const total = users.length;
    const paid = users.filter(u => u.status === '付費學員').length;
    const ad = users.filter(u => u.source === '廣告').length;
    const normal = users.filter(u => u.source === '一般').length;
    const blocked = users.filter(u => u.blocked_at).length;
    const adPaid = users.filter(u => u.source === '廣告' && u.status === '付費學員').length;
    const convRate = ad > 0 ? Math.round(adPaid / ad * 100) : 0;
    const convertedUsers = users.filter(u => u.days_to_convert != null);
    const avgDays = convertedUsers.length > 0 ? Math.round(convertedUsers.reduce((a, u) => a + u.days_to_convert, 0) / convertedUsers.length) : 0;
    res.json({ total, paid, ad, normal, blocked, convRate, avgDays });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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

app.post('/set-paid', express.json(), async (req, res) => {
  const { userId, adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: '密碼錯誤' });
  if (!userId) return res.status(400).json({ error: '請提供用戶 ID' });
  try {
    await client.linkRichMenuIdToUser(userId, process.env.RICHMENU_PAID);
    const existing = await getUser(userId);
    const now = new Date().toISOString();
    if (existing) {
      const days = Math.floor((new Date() - new Date(existing.joined_at)) / 86400000);
      await updateUser(userId, { status: '付費學員', paid_at: now, days_to_convert: days });
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/remove-student', express.json(), async (req, res) => {
  const { userId, adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: '密碼錯誤' });
  try {
    await client.linkRichMenuIdToUser(userId, process.env.RICHMENU_NORMAL);
    await updateUser(userId, { status: '潛在客', paid_at: null, days_to_convert: null });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== 管理後台 =====
app.get('/admin', (req, res) => {
  const liffId = process.env.LIFF_ID || '';
  const joinLink = 'https://liff.line.me/' + liffId + '?path=/join-paid';
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>藍海交易 管理後台</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d0d1a;color:#e0e0e0;}
/* Login */
.login-wrap{display:flex;align-items:center;justify-content:center;min-height:100vh;}
.login-box{background:#16213e;border:1px solid #2d2d4e;border-radius:16px;padding:48px 40px;width:380px;}
.login-box h2{color:#a78bfa;font-size:20px;margin-bottom:8px;text-align:center;}
.login-box p{color:#888;font-size:13px;text-align:center;margin-bottom:28px;}
/* App Layout */
#app{display:none;min-height:100vh;}
.sidebar{width:240px;background:#111128;border-right:1px solid #2d2d4e;position:fixed;top:0;left:0;height:100vh;display:flex;flex-direction:column;}
.sidebar-logo{padding:24px 20px;border-bottom:1px solid #2d2d4e;}
.sidebar-logo h2{color:#a78bfa;font-size:16px;font-weight:700;}
.sidebar-logo p{color:#666;font-size:12px;margin-top:4px;}
.nav-section{padding:16px 12px 8px;color:#555;font-size:11px;text-transform:uppercase;letter-spacing:1px;}
.nav-item{display:flex;align-items:center;gap:10px;padding:11px 20px;cursor:pointer;font-size:14px;color:#888;border-radius:0;transition:all 0.15s;border-left:3px solid transparent;}
.nav-item:hover{color:#ddd;background:#1a1a35;}
.nav-item.active{color:#a78bfa;background:#1a1a35;border-left-color:#a78bfa;}
.nav-item .icon{font-size:16px;}
.main{margin-left:240px;padding:36px 40px;min-height:100vh;}
.page{display:none;} .page.active{display:block;}
/* Header */
.page-header{margin-bottom:28px;}
.page-header h1{font-size:24px;color:#fff;font-weight:700;}
.page-header p{color:#666;font-size:14px;margin-top:4px;}
/* Cards */
.card{background:#16213e;border:1px solid #2d2d4e;border-radius:12px;padding:24px;margin-bottom:20px;}
.card-title{color:#a78bfa;font-size:12px;text-transform:uppercase;letter-spacing:1px;font-weight:700;margin-bottom:16px;}
/* Form */
label{display:block;color:#aaa;font-size:13px;margin-bottom:6px;}
input,select{width:100%;padding:10px 14px;background:#0d0d1a;border:1px solid #2d2d4e;border-radius:8px;color:#fff;font-size:14px;outline:none;margin-bottom:14px;transition:border 0.2s;}
input:focus,select:focus{border-color:#a78bfa;}
/* Buttons */
.btn{padding:10px 20px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:all 0.2s;display:inline-flex;align-items:center;gap:6px;}
.btn-primary{background:#a78bfa;color:#fff;} .btn-primary:hover{background:#9061f9;}
.btn-danger{background:transparent;color:#f87171;border:1px solid #f87171;padding:5px 12px;font-size:12px;} .btn-danger:hover{background:#4c1d1d;}
.btn-full{width:100%;justify-content:center;}
/* Alerts */
.alert{padding:10px 14px;border-radius:8px;font-size:13px;display:none;margin-top:12px;}
.alert-success{background:#0d2b1f;border:1px solid #166534;color:#6ee7b7;display:block;}
.alert-error{background:#2b0d0d;border:1px solid #991b1b;color:#fca5a5;display:block;}
/* Stats */
.stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:8px;}
.stat-card{background:#111128;border:1px solid #2d2d4e;border-radius:10px;padding:20px 24px;}
.stat-num{font-size:36px;font-weight:800;color:#a78bfa;line-height:1;}
.stat-label{color:#666;font-size:12px;margin-top:8px;text-transform:uppercase;letter-spacing:0.5px;}
.stat-sub{color:#888;font-size:11px;margin-top:4px;}
/* Period tabs */
.period-tabs{display:flex;gap:6px;margin-bottom:20px;}
.ptab{padding:6px 18px;border:1px solid #2d2d4e;background:transparent;color:#888;border-radius:20px;cursor:pointer;font-size:13px;transition:all 0.2s;}
.ptab:hover{color:#ddd;border-color:#555;}
.ptab.active{background:#a78bfa;color:#fff;border-color:#a78bfa;}
/* Table */
.table-wrap{overflow-x:auto;}
table{width:100%;border-collapse:collapse;font-size:13px;min-width:900px;}
th{padding:10px 14px;text-align:left;color:#666;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #2d2d4e;white-space:nowrap;}
td{padding:12px 14px;border-bottom:1px solid #1e1e35;color:#ccc;white-space:nowrap;}
tr:hover td{background:#111128;}
/* Tags */
.tag{display:inline-block;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:700;}
.tag-ad{background:#3b0764;color:#d946ef;}
.tag-normal{background:#0c2a4a;color:#38bdf8;}
.tag-paid{background:#0a2e1f;color:#4ade80;}
.tag-potential{background:#2d2400;color:#fbbf24;}
/* Link box */
.link-box{background:#0d0d1a;border:1px solid #2d2d4e;border-radius:8px;padding:12px 16px;font-size:13px;color:#a78bfa;word-break:break-all;margin-bottom:14px;}
/* Filters */
.filter-row{display:flex;gap:12px;align-items:flex-end;margin-bottom:16px;}
.filter-row select{margin-bottom:0;width:auto;min-width:160px;}
</style>
</head>
<body>

<div class="login-wrap" id="loginWrap">
  <div class="login-box">
    <h2>🔐 管理後台</h2>
    <p>藍海交易教育學院</p>
    <label>管理員密碼</label>
    <input type="password" id="loginKey" placeholder="輸入密碼" autofocus>
    <button class="btn btn-primary btn-full" id="loginBtn">登入</button>
    <div id="loginErr" class="alert"></div>
  </div>
</div>

<div id="app">
  <div class="sidebar">
    <div class="sidebar-logo">
      <h2>藍海交易</h2>
      <p>管理後台</p>
    </div>
    <div class="nav-section">主選單</div>
    <div class="nav-item active" data-page="stats"><span class="icon">📊</span>數據統計</div>
    <div class="nav-item" data-page="users"><span class="icon">👥</span>用戶名單</div>
    <div class="nav-item" data-page="manage"><span class="icon">⚙️</span>學員管理</div>
  </div>

  <div class="main">

    <div id="page-stats" class="page active">
      <div class="page-header">
        <h1>數據統計</h1>
        <p>查看各時段的用戶成長與轉換數據</p>
      </div>
      <div class="period-tabs">
        <button class="ptab active" data-period="week">本週</button>
        <button class="ptab" data-period="month">本月</button>
        <button class="ptab" data-period="quarter">本季</button>
        <button class="ptab" data-period="year">本年</button>
        <button class="ptab" data-period="all">全部</button>
      </div>
      <div id="stats-grid" class="stats-grid">
        <div class="stat-card"><div class="stat-num">-</div><div class="stat-label">載入中</div></div>
      </div>
    </div>

    <div id="page-users" class="page">
      <div class="page-header">
        <h1>用戶名單</h1>
        <p>查看所有用戶資料與行為記錄</p>
      </div>
      <div class="card">
        <div class="filter-row">
          <div>
            <label>來源篩選</label>
            <select id="sourceFilter">
              <option value="">全部來源</option>
              <option value="廣告">廣告</option>
              <option value="一般">一般</option>
            </select>
          </div>
          <div>
            <label>狀態篩選</label>
            <select id="statusFilter">
              <option value="">全部狀態</option>
              <option value="潛在客">潛在客</option>
              <option value="付費學員">付費學員</option>
            </select>
          </div>
          <button class="btn btn-primary" id="loadListBtn">載入名單</button>
        </div>
        <div class="table-wrap">
          <div id="user-list"><p style="color:#666;padding:20px 0;">請點擊「載入名單」查看資料</p></div>
        </div>
      </div>
    </div>

    <div id="page-manage" class="page">
      <div class="page-header">
        <h1>學員管理</h1>
        <p>管理付費學員權限</p>
      </div>
      <div class="card">
        <div class="card-title">學員註冊連結</div>
        <p style="color:#888;font-size:13px;margin-bottom:12px;">傳給付費學員，點一下即可自動升級為付費學員介面</p>
        <div class="link-box" id="joinLink">${joinLink}</div>
        <button class="btn btn-primary" id="copyBtn">複製連結</button>
        <div id="copy-result" class="alert"></div>
      </div>
      <div class="card">
        <div class="card-title">手動切換付費學員</div>
        <label>顧客的 LINE User ID</label>
        <input type="text" id="userId" placeholder="Uxxxxxxxxxxxxxxxxx">
        <button class="btn btn-primary btn-full" id="setPaidBtn">切換為付費學員</button>
        <div id="set-result" class="alert"></div>
        <p style="color:#555;font-size:12px;margin-top:10px;">💡 取得 User ID：請學員傳任意訊息後，到 Render Logs 查看</p>
      </div>
    </div>

  </div>
</div>

<script>
var AK = '';
var period = 'week';

// 登入
document.getElementById('loginBtn').addEventListener('click', function() {
  var key = document.getElementById('loginKey').value.trim();
  if (!key) return;
  fetch('/api/stats?adminKey=' + encodeURIComponent(key) + '&period=all')
  .then(function(r) {
    if (r.ok) {
      AK = key;
      document.getElementById('loginWrap').style.display = 'none';
      document.getElementById('app').style.display = 'block';
      loadStats();
    } else {
      var el = document.getElementById('loginErr');
      el.className = 'alert alert-error';
      el.textContent = '密碼錯誤，請重試';
    }
  });
});
document.getElementById('loginKey').addEventListener('keydown', function(e) { if (e.key === 'Enter') document.getElementById('loginBtn').click(); });

// 導覽
document.querySelectorAll('.nav-item').forEach(function(item) {
  item.addEventListener('click', function() {
    var page = this.getAttribute('data-page');
    document.querySelectorAll('.nav-item').forEach(function(n) { n.classList.remove('active'); });
    document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
    this.classList.add('active');
    document.getElementById('page-' + page).classList.add('active');
  });
});

// 時間軸
document.querySelectorAll('.ptab').forEach(function(btn) {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.ptab').forEach(function(b) { b.classList.remove('active'); });
    this.classList.add('active');
    period = this.getAttribute('data-period');
    loadStats();
  });
});

// 統計
function loadStats() {
  var el = document.getElementById('stats-grid');
  el.innerHTML = '<div class="stat-card" style="grid-column:1/-1;color:#666;text-align:center;padding:30px;">載入中...</div>';
  fetch('/api/stats?adminKey=' + encodeURIComponent(AK) + '&period=' + period)
  .then(function(r) { return r.json(); })
  .then(function(s) {
    el.innerHTML =
      '<div class="stat-card"><div class="stat-num">' + s.total + '</div><div class="stat-label">總加入人數</div></div>' +
      '<div class="stat-card"><div class="stat-num">' + s.paid + '</div><div class="stat-label">付費學員</div></div>' +
      '<div class="stat-card"><div class="stat-num">' + s.ad + '</div><div class="stat-label">廣告來源</div><div class="stat-sub">轉換率 ' + s.convRate + '%</div></div>' +
      '<div class="stat-card"><div class="stat-num">' + s.normal + '</div><div class="stat-label">一般來源</div></div>' +
      '<div class="stat-card"><div class="stat-num">' + s.blocked + '</div><div class="stat-label">已封鎖</div></div>' +
      '<div class="stat-card"><div class="stat-num">' + s.avgDays + '</div><div class="stat-label">平均成交天數</div></div>';
  });
}

// 用戶名單
document.getElementById('loadListBtn').addEventListener('click', function() {
  var source = document.getElementById('sourceFilter').value;
  var status = document.getElementById('statusFilter').value;
  var el = document.getElementById('user-list');
  el.innerHTML = '<p style="color:#666;padding:20px 0;">載入中...</p>';
  var url = '/api/users?adminKey=' + encodeURIComponent(AK);
  if (source) url += '&source=' + encodeURIComponent(source);
  if (status) url += '&status=' + encodeURIComponent(status);
  fetch(url).then(function(r) { return r.json(); })
  .then(function(x) {
    if (!x.users || x.users.length === 0) {
      el.innerHTML = '<p style="color:#666;padding:20px 0;">沒有符合的用戶</p>';
      return;
    }
    var html = '<table><tr><th>姓名</th><th>User ID</th><th>來源</th><th>狀態</th><th>加入時間</th><th>付費時間</th><th>成交天數</th><th>封鎖時間</th><th>領取課程</th><th>預約諮詢</th><th>操作</th></tr>';
    x.users.forEach(function(u) {
      function fmt(d) { return d ? new Date(d).toLocaleDateString('zh-TW') : '-'; }
      var srcTag = u.source === '廣告' ? '<span class="tag tag-ad">廣告</span>' : '<span class="tag tag-normal">一般</span>';
      var stTag = u.status === '付費學員' ? '<span class="tag tag-paid">付費學員</span>' : '<span class="tag tag-potential">潛在客</span>';
      html += '<tr><td>' + u.name + '</td><td style="font-size:11px;color:#555;">' + u.user_id + '</td><td>' + srcTag + '</td><td>' + stTag + '</td><td>' + fmt(u.joined_at) + '</td><td>' + fmt(u.paid_at) + '</td><td>' + (u.days_to_convert != null ? u.days_to_convert + ' 天' : '-') + '</td><td>' + fmt(u.blocked_at) + '</td><td>' + fmt(u.free_course_at) + '</td><td>' + fmt(u.consultation_at) + '</td><td><button class="btn btn-danger" data-uid="' + u.user_id + '">移除</button></td></tr>';
    });
    html += '</table>';
    el.innerHTML = html;
    el.querySelectorAll('[data-uid]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var uid = this.getAttribute('data-uid');
        if (!confirm('確定要將此學員移回潛在客？')) return;
        fetch('/api/remove-student', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: uid, adminKey: AK }) })
        .then(function(r) { return r.json(); })
        .then(function(x) { if (x.ok) document.getElementById('loadListBtn').click(); else alert('錯誤：' + x.error); });
      });
    });
  });
});

// 複製連結
document.getElementById('copyBtn').addEventListener('click', function() {
  var link = document.getElementById('joinLink').textContent.trim();
  navigator.clipboard.writeText(link).then(function() {
    var el = document.getElementById('copy-result');
    el.className = 'alert alert-success';
    el.textContent = '✅ 已複製！';
    setTimeout(function() { el.style.display = 'none'; }, 2000);
  });
});

// 切換付費學員
document.getElementById('setPaidBtn').addEventListener('click', function() {
  var userId = document.getElementById('userId').value.trim();
  var el = document.getElementById('set-result');
  el.className = 'alert';
  if (!userId) { el.className = 'alert alert-error'; el.textContent = '請輸入 User ID'; return; }
  fetch('/set-paid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: userId, adminKey: AK }) })
  .then(function(r) { return r.json(); })
  .then(function(x) {
    if (x.ok) { el.className = 'alert alert-success'; el.textContent = '✅ 切換成功！'; document.getElementById('userId').value = ''; }
    else { el.className = 'alert alert-error'; el.textContent = '❌ ' + (x.error || '發生錯誤'); }
  });
});
</script>
</body>
</html>`);
});

// ===== Webhook =====
app.post('/webhook', express.json(), async (req, res) => {
  res.status(200).json({ status: 'ok' });
  const events = req.body?.events || [];
  await Promise.all(events.map(handleEvent));
});

async function handleEvent(event) {
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
      await upsertUser(userId, profile.displayName, '一般');
      await client.pushMessage({ to: userId, messages: [{ type: 'text', text: process.env.NORMAL_WELCOME_MSG }] });
      await client.linkRichMenuIdToUser(userId, process.env.RICHMENU_NORMAL);
    }
  }

  if (event.type === 'unfollow') {
    await updateUser(event.source.userId, { blocked_at: new Date().toISOString() });
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
