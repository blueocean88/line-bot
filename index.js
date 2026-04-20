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

// ===== Ping =====
app.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

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

app.post('/mark-ad', express.json(), async (req, res) => {
  const { userId } = req.body;
  if (userId) {
    adUserIds.add(userId);
    setTimeout(() => adUserIds.delete(userId), 30 * 60 * 1000);
    // 也存進 Supabase 避免重啟遺失
    try {
      await supabase('POST', 'ad_pending', { user_id: userId, created_at: new Date().toISOString() });
    } catch(e) {}
  }
  res.json({ ok: true });
});

async function isAdUser(userId) {
  if (adUserIds.has(userId)) return true;
  try {
    const data = await supabase('GET', `ad_pending?user_id=eq.${userId}&limit=1`);
    if (Array.isArray(data) && data.length > 0) {
      const created = new Date(data[0].created_at);
      const mins = (new Date() - created) / 60000;
      return mins < 30;
    }
  } catch(e) {}
  return false;
}

async function clearAdUser(userId) {
  adUserIds.delete(userId);
  try { await supabase('DELETE', `ad_pending?user_id=eq.${userId}`); } catch(e) {}
}

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
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:sans-serif;padding:24px;background:#1c1c1c;color:#fff;}.card{background:#252525;border-radius:12px;padding:20px;max-width:480px;margin:0 auto 16px;border:1px solid #333;}h1{color:#3b82f6;text-align:center;margin-bottom:24px;}button{background:#3b82f6;color:#fff;padding:10px;border:none;border-radius:8px;width:100%;cursor:pointer;font-size:14px;}.result{margin-top:10px;padding:8px;border-radius:6px;text-align:center;display:none;}.ok{background:#1a4731;color:#6ee7b7;display:block;}.err{background:#4c1d1d;color:#fca5a5;display:block;}</style></head><body>
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


// ===== 學員中繼頁面 =====
const LOGO_B64 = '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MXHBEgMQIPBBUWGBobHRMCIy0hNQYJHhgqKywuIzBEDxUkJiciOAsBSScCT/2gAMAwEBAhEDEQAAAJ/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUBUUClQqAAAAAUBUFChcAAKKCoVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKGI/S8Ph32cc3Uuob/wAcqWKL5w3dLhZZWGnq8HAvo8UUpTIDXenoN4baVBQjPkSH+s9nobrq0tZFcx2WdnHSVrVqNop5n5H1PHfSgqSt8rnSY89lAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADCfs47wPkGKK1sH0sXKmrhP6R3VbxbZWBLuNXGv12EKX25M6XI9P8AGe6AESktwH1Ft9Ev8lrKjjZBkcjyXNS6o2da+RyWdBxfJsFK1mp4bZS38pnAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADCjso8wOkOKKW2D6mNlzVwt9HbqnoLbawJdxqo1utwgVyZ1Xv6f4x3IAiUleBuod9za0MqOOkCR6PJevrQbNTyPy5o+J+/mKVvmq4fYS38nnAADSKqUUrbfqXUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGFHZR5gdIcUUtsH1MbLmrhb6O3VPQW21gS7jVRrdbhArkzqvf0/xjuQBEpK8DdQ77m1oZUcdIEj0eS9fWg2ankflzR8T9/MUrfNVw+wlv5POAoVKGkt4f7YWyupz7Hz9VUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYUdlHmB0hxRS2wfUxsuauFvo7dU9BbbWBLuNVGt1uECuTOq9/T/GO5AESkrwN1DvubWhlRx0gSPR5L19aDZqeR+XNHxP386qUrdNVw+0lu5PMAGjbTTuYn9Lw2B0gxVJNGszZB6HqbrgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwo7KPMDpDiiltg+pjZc1cLfR26p6C22sCXcaqNbrcIFcmdV7+n+MdyAIlJXgbqHfc2tDKjjpAkejyXr60GzU8j8uaPifv51UpW6arh9pLdyeYBadaZumj2kOKejek5FbfKHFM45B6HqbrgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwo7KPMDpDiiltg+pjZc1cLfR26p6KLaIEu41ca3W4QK5M6r39P8Y7kARKSzAnUW65+i0ZUcdIEj0eS9fWg2laeR2W9FxT2pWtO69b7+gGP9plXrvUadKcOyMGHuY/nzYZOPRYJRIqnPIPn+quuAAAAAAAAAAAAAAAAAAAAAAAAAAAAADCjso8wOkOKKW2D6mNlzVwt9HbqnootpWBLuNVGt1uECuTOq9/T/GO5AESkswJ1FuufotGVHHSBI9HkvX1oNop5G5c0Xz70tHHbCXLk8zkPndqXBp0cCzNVDxM3zwKXUEosTztkFounuuAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKMKOxjzA2Q4oqtUr9LHyJqYW+j97T0FLUCPc6yNbqsNdRayZ1Xv6f4z3IAiVleBuod7ziyqtMp+O7+RyPpc1VRs7XnvkDWTPcXmd94vveACyjgOZrId5m+d63PuYmVnbH8r5bcv2+uvuAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKUYU9jHmBshxRWlnLsDZSAR3LuSXP8AWbitwssdKZnnBt3Wuwe6HFWUyZ1Xv6f4z3IFCJaV4G6h3vOKO++Z66QSO5b7DxtjrLhZSmnbdq3UUVuVALKOA5msh4mb53yL5js5BY9ljmWJnal91VKqgAAAAAAAAAAAAAAAAAAAAAAAAACgVqpQqUMJuyjnBSQIuyt47u89ODlLknllAAUNC1Hd0GJCP3ev7Sw6+n+Mt0AIlJagLhOZh56x5KmUXO9nuqXAADRW3W10VPge2PynzyhZSnEfbE6Q3fMZM6DstelQAAAAAAAAAAAAAAAAAAAAAAAAAAAKFFdustU3a+oMYOg4/knhl966bo1tda6oAoClKKV4D7WRu9FjyxczlgUML+qj3Kbmu55N45CtNVcBQqUNKlOEe+DgFIUUdx6rf5r8ZI4tpRWtLa0u89ReAAAAAAAAAAAAAAAAAAAAAAAAAABQssWXOt87Ux4yNEUjsbzBzzC2epcFpcAadq4uuDQrSi3WpeUuVAAFCoKFtFaLrlDRU0aW4i9ZweDHexd8XMxs84/lHNXi5IAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAofMeWGXYx5hP3cX/ADvXymLhj6K55h7O+4AKFDCbZeOZ2t9d6qNvW3o3Y8/3Jgb76Vl+oqAABQHzTHTL88ncP0rUNnXxiuk+FOlOg5VdVdXPOP5RzV4uSAAAAAAAAAAAAAAAAAAAAAAAAAAAAABoW04Lm62MmTYW6v3WgtrbRbMZC30ZzvE2d9QstKV6597ITO41mAPQ43rriPeb+lw06I4ZBiPpze8zIRHcu97aPpK3V1qgBZaoYq7Txg07jWZF6r3ns4nZXVDb0shUm75x+T7YYrW/POP5SzV4uSAAAAAAAAAAAAAAAAAAAAAAAAAAAAABp0pj3vuXi/lWDVbaFFsxkLfRnO8TZ31UNK1HXv8AEhC7zXdfZFv2qPXfEG939KjTojhkGI8Weyj++y7KTk+8z04SUuWY+ZUFDg11sMHZ4EZPVYG2vSV8lnT18Tsrqht6WQqTd84/J9sMVrfnnH8pZq8XJAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAsox93nKxeSvBhVW/JDlOzkdjqYfrefpq1rQi06TCg07/W0Wj7Xn6eu+It3v7bqFlEcMgxFix2cfit1/cnP9NLHFU6VBQ800karELd4lFBJXyefPXw+yuqG3pZCpN3zj8n2wxWt+ecfylmrxckAAAAAAAAAAAAAAAAAAAAAAAAAAAAACyjH3ecrF5K8G8wwtjIBHEt5I6DrtS26ty6oRF9XgQt9rrV4fa8/T13xFu9/bdQsojhkGIsWOzj8Vsv7X1PRS4RLPFQUPMbJumxa23iWiSvk8+evh9ldUNvSyFSbvnH5Pthitb884/lLNXi5IAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGjbTH/e81jf0nGZ48JJ/JfPKAAoRGdXgwtdzra0oPtefp674i3e/tuoWURwyDEWLHZx+Kqdr6XpJcImnoVB5i5M02Lm28KVoJK+Tz56+H2V1Q29LIVJu+cfk+2GK1vzzj+Us1eLkgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWeTa+luvVW27VuAAUIjOrwYWu51taUH2vP09d8Rbvf23ULKI4ZBiLFjs4/FVO19L0kuETT0Kg8xcmabFzbeFK0ElfJ589fD7K6obelkKk3fOPyfbDFa355x/KWavFyQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQiM6vBha7nW1pQfa8/T13xFu9/bdQsojhkGIsWOzj8VU7X0vSS4RNPQqDzFyZpsXNt4UrQSV8nnz18Psrqht6WQqTd84/J9sMVrfnnH8pZq8XJAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCIzq8GFrudbWlB9rz9PXfEW739t1CyiOGQYixY7OPxVTtfS9JLhE09CoPMXJmmxc23hStBJXyefPXw+yuqG3pZCpN3zj8n2wxWt+ecfylmrxckAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUoiL6vBhb7jW1rQfa87/XfEO939K0osI4ZBiLFjs4/FVO19L0kuETT0Kg8xkmabFrb+AW1kr5XNnr4fZXVKNBZCnNvzj8nIw1qt1+ecfylmrxckAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAW0RGdXgwt9xra1oPted/ruiHe/QpW2i0jhkGIsWOzj8VU7W0vSS4RNPVSpQ8xcmabFzb+FVKWpKuVz57OH2V1VKNGtkKc2fOPyfbDrbR6emecfylmrxckAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADCLaeOBvQ4Va+laN54Vm15LN3lK2mnW3FfoOQ6i3vNi1TmGBtM2+QkKpUtIj+mw+os3zXVGVmk9pItJk1qoaFvngP3Ea7T38BYpkVzXWZCafqgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABp2K3VuoFFKW1v9KUNJSy6zX8vQaalLmvWoA07K1Lq0FCta1rQWUppqay4aKwv16gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKFQUoqKhQqAAAAAAAAAAAAAAUoqUqqAAChUAFCoAAAAAAAABQqAAChUAAAAAAAAAAGnaqK1oUspVW66ilVaW2q1KVv9KClA07VTUvCliyi1RddfcpZbW64AW20Vu1brQBbapVSlbFtlWsrWi65UFKKFtK6dtKX01F19KK0W1sUuuuAFLC5qXUFKLKFyttb7qAULLFFbq0uKK0pShWlb/SgAAAAAAAAAAig6XDjZ6jAVVNxSuQOu95jeLzu7Mb1+H6W+ZeR9TkLrfWf3g9nqegW0dc+1nm/kfU5g6bInH4zYjT86wOd9rMWdv4el+Ltt8P3p5wZG1d91gWguu9FEcbXt3H9AKFKOt/ayHbscHBPf4vBsmncuuuku5rOlO5bM+tVUto6o97IcuzwMGt9jcT9qdw6+6Svms2Vjl8zc0u808lafjnr5hQK31ngj3Z5SYPuLaIvOhw4b+218jfM5c3PH7GoLSAzudZjls/Cejgdnkvge9TGDO84GpB1MlfL5srfM5oAAAAAAAAAAhU7HXxJdhrsitbkcp8qcB93Rew8cidVk+omMdt8P3p5B5Z0mU2n9PTfHO51AUtdWZ/n5OJT0ueGgyfRXH21FivmwkjT4YbzG9dsO9Bx328/J5LOj5r43ZBa72XWitvp6CY82nbHhcBQ6q9rPM9J+o6fzvHuzV+/bnjdjFsPHieXZnvzOb6FI/2e6rTqTJt8y8n6bq3M8+8tX7dqeN2Lmx8vge9nozjXb5s6j38jcu6XY1tyY1nsutW1qunH4TZZNa/1GzpTy2yfpuhdp5cl8L/VzE+75v5VvuUPM5I+lxL3fj3nrPf05Rlt+Y+d2H228vNVJ+klw47YTUcbsAAAAAAAAAABCp2OviS7DXemKK93ljge+1ts8skq6fqb3s9fEUbv5Po8g8s6TKbT+npvjnc6gKWurM/z8nEp6XPDQZPorj7aixXzYSRp8MN5jeu2Heg477efk8lnR5waXK9GcabfUrShaVrXUuoBQgD73Vxy9LgytcfsprOMz99WvXHrZ5wJH1WOG4xvQJHG4kQ0GVAHIGqjn6LDla5DYTX8ZsN3dXrX288Jdz4SSc7lad9vkbl3S9pYV3qVirdXXBRUpqXqGEG3x/OPJemyV0+XjXusObjgtrK7y2dddSh5nJH0uJe78VaSCcxneg3gdniHtvLzVSfpJcOO2E1HG7AAAAAAAAAAAQqdjr4kuw10lfKZ3bOPf1xkWRmdVhyYcpmztcPsvhZFvkHlnSZTaf09N8c7nUBS11Zn+fk4lPS536DJ9FkfbUWnmukjT4Y7zH9dsO9Bx738vJ3K+k7nw/WQHnMu6tFWVmmypANJkX1oFGhWnkSlrR23vWlEm75H53VuUMB91j+eCSdNIhzObP7wG18j8u6LY32+tSI97yOyt1QoVNrW3yOy7pt/ZbJZy+bctWu/NdkyYc5k3XKHnVkLUYS7zx9TMV7rzJSfpea49/qZi7c7ytaHmbknTYm7bxzD0/vh5uceb3hNjkvrcjzUydp5ceSzpqOL2IAAAAAAAAAAhU7HXxJdhrt0vupS02qsnvLZc4fD7Lbe1PIPLOkym0/p6b453OoClrqzP8/JxKelzv0GT6LI92tClXmtkjT4ZbzH9dsO9Bx738vJ3K+kX3adAWpQ+Xy51+F2l91Ao47dTyGTBoe3MD09WsW7y62l1yhi9svDzEyjps4tBk+iGOtt5Apj0XZeLd6w4l3t6lblCoNrW3yOy7puJenlp+dXrVazs0OR6Lo529bnRmT5eWaWNJnnocqf+PdpC52Wuim7DA9Fca7nO3T5FDzNyPpsUNt4+rqK915kZL1XA8rymU4nYQrdzr5ceSzpqOL2IAAAAAAAAAFKIVey18SXYa70pRdusrdb7fPurDp2Ovib7DXz8R9ts/8ASZHkHlnSZTam/wBN8Z7ut4LXXmV4+SuWNFlhqMv0zRrtrlbLXlylLS9C7Px9dUP77hmRZ5O5X0mZOmyp+Y52t1A+7WvNrV1QFp5TZU0nTubZ6iYo3GROH71UESvVYcKnd6uVzj9hNpxWx8rMqaPpjY2eomJ9xkTh+y1StdopvKtKtPI3Lul7GwLfSdGm6vsuVfUpXn1KUtuhN7fXRO9fg6llt11bb2n50zh0OV6NI62qlfM7JmmxO2tnsHiTd4j53h5vJP1OrR8z0slw47YzUcbsAAAAAAAAAAKUQq9lr4kuw10+Md7fJHB9trbbE/1uDHP1WDOFH22k10OV5B5Z0nfWuunE4fZ3rR9/z9MrdX7+WOVtN0pmY84vB7PODT5Mfm9xYWu412UupyfTZGO26vzfPydyvo8udTkTpcBtLvRSp507ww/T7qoFCJ/pcGEnv9Z3frPeb/hNlkDg+mDW68IUe911POz0/wAY7vvnW+sUHXYEJXda3IDU5E4XD7DurC9cGN5jxg9VheiWOdl3Jj+vkbl3S89xK+iGOdrdfWgtdtYV+4ut8pEr6TkXjdnhzuZSqttMM+gx+is/w9SMV7vv3D9fM7JWmxO2lnsHiPd7vzrEf1mDC33OtVpLhx2xmo43YAAAAAAAAAACFPrsCJPtdWXitK0W9z6729L8ZbjmCvkHlvRXegVWjvvWevqYi3eYJ7vF890jaz5F1lK0rWvKMf09G0abXLjXe/VWV5+TyV9HdeCoXLfUXFG9yLwvUAbGiD/tddFz1uDbfSyi5TlXh6T8R5ss89Nl1NjRBN3OtjR6rBtvPIup2Hie3ocjrbZX6318jst6LieRZUpUFlnoPjXd8Ey7ILJB1M2vCbSV7lM7UvpQj03ON585L08qvHZ833E7LzPSZp8T9lj+weJt/v7K7I88Hf6rBPpMOW7jNjNVyGwAAAAAAAAAAGI208cZ9v40WC6z07Rwbs2NN78ksu+eRfdPiXeltC64OZYd8jfPZSlejszxwF6PG6c9PPvTw95Aeb9+2vL0ra4vejV6XErfYFQrbdInzeXz/wA6gCyxaYwbLzwa3mJ1lk0yJwfSQHn8nsjG9NS+gtsWmJW08sH93i8G96ZH4HpIHz+Rzzw9NMjG6jE+d6WClQrVm7zmX0DsvPp/P8pGuayubeN19wfJrSMbosXkysknN5Ufe+8Ot8rylI5jL3NK2W14F7+cdvSY2TOq9cudZ7gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUKlCpQAAqUAKgFCoBQqAUBUFCpQqACgABUAAFAVBQAFQAAAAAAAAAAAAAAAAAAAAAAChaba7yorRS630XeVbb71bi6y7Qu81WrS6xXbenjr23atvoV0rraLVaUtuXlKX23altaUrdfSpt1nH/Tw+/5e+4tupVx2/H3dtfrPetldt7ee9s9Lba7a7z1Lrtal2mt0q2F1lbNx5elFOPe3hvrfX6vndo3XWPOty627eVvAAAAAAAAAAAAAAAAAAAAAFDb3ecOEvwBw/bab6Xjk5d8NIGIfc8BybCzNj7eUnkUTZ21qt7GxJUN7mnrJBG0wdEbzmosJfgf6Xlldj6XbyMxtMHSG95nACTIo+jj+uTnIdzyzGy8Qe24Dc+F2THMdvINHcqr3VufpowJVhPQ9fPkuFsJWolnKM+UIX6i3mg2tbMt+O7zPCP5UhNnf5pm6gr6Y1bKxqSZDeQHMdXlPzfc9A7/lYuJYg36dvr29z/TSbRdM8YMsQp1znaX5mT4SLRjMXGszCwBkaJ/oefrlFx3bSLx9LwAAAAAAAAAAAAAAAAAAAAAA07axYy3BOXvESPkdzvWwhTr80yyw5POBUiRN3vznYZT8r2sSsvQP8zKwpgoU+i+s9xocFZCi+VuHp1wu7OO8bes43J7luz6C6DmczuFkfnOFscUOx4T4fvhd78118dUnQzNTB/0nUiylaDu+ed6rNLiZH+Vd44rdrwuMfTcNKhEk7fK9vKHabPnWUeI5yiXmeAZyoD+ntal0ZkowtkDzPW5Ycp3mPvQ8tgHIsSSARrLvJ8XNx16fkOmt1zEnEXzZ01tdByrEzseun5HoDoeRzP4eSedYW07HwNoAAAAAAAAAAAAAAAAAAAAABQspSK+WYJy/4mSMj+c6yD+e/mbmGr2m6tvlciOdMOuzj7p/fc78f08O/uf6nvHRdRgr30Xyww9PPTm85uMyUobzM4mQcLe4jLtnU9Hk/wAl3fWm15/Fjr+K4FstLJXEs3ZUcx2yqISZPn+QCO5W7753rBgp38WfE98aQWOZaVrEjMkAZvx9KEYsswZOXAn1HfSkZ0owvkDzPW5X8p3ePvQ8rGZK0Id3890/dWi6fhufrPv4mdmzwslRKTFAXLsbLyF5jssLe7jXtrUb/JvjO3yu5ru6gAAAAAAAAAAAAAAAAAAAAAoaNqLKXYJy+4iSMj+a6uEOePmuXCF58idmCCZaogneJqXoHyZ5buNKnljZ1nGyQxlMMeEkxFl1xcg4r9dxOUvI9p9W33xe6rismuR7bnGFseqN3z+tb68IzNdyzCzs9I/lK5dg93UY41dZx2YnByJ03v8AnMouS7iMGW4PzrjeVeMZ2BiL2seTBwv9CQqzv83Z+xtLHKMHYY8dRxltte49J0nJ/DLwVkOK8w+Ckr63lkdga/aRmynCudsdSl1lttL11u9JkPy3Z4t9dweTvKdtzbX7fJ7muxvAAAAAAAAAAAAAAAAAAAAABQspTFnpuJ7d03QdjYO1wo7WOMxuNkPHLpeO2Xq+T64uYPG9/SrDbso67X1HR9GdFye88/XuDQ9F3xpOo6d2/P4/dLyRbzvB2vNddsrra9gYG0xa6ziM0eHkjc0u0LrMWuo4jpDf813Do+ky15PuumtzzmLPW8L9Lwysv+M7/nGHtMIu5jOz1pyrB2HJsHM6v3OkpW3v3meu6B6fkb1fr4+VmdxEidEb3l8Y+r4ve2emTHK9lurfXHzo+QrdXnWBt8seT7moAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA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';

app.get('/member', (req, res) => {
  const liffUrl = 'https://liff.line.me/' + (process.env.LIFF_ID || '') + '?path=/join-paid';
  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>藍海交易學院 官方LINE學員身分專區</title>
<meta property="og:title" content="藍海交易學院 官方LINE學員身分專區">
<meta property="og:description" content="點此完成學員身分認證，解鎖專屬學員服務">
<meta property="og:image" content="https://line-bot-083j.onrender.com/logo.jpg">
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,sans-serif;background:#f0f4ff;min-height:100vh;display:flex;align-items:center;justify-content:center;}
.card{background:white;border-radius:20px;padding:48px 40px;max-width:380px;width:90%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.1);}
img{width:180px;margin-bottom:28px;}
h1{color:#1e3a8a;font-size:18px;font-weight:700;line-height:1.5;margin-bottom:8px;}
p{color:#888;font-size:13px;margin-bottom:32px;line-height:1.6;}
.btn{display:block;background:#06C755;color:white;padding:16px;border-radius:12px;text-decoration:none;font-size:16px;font-weight:700;}
.note{margin-top:16px;color:#aaa;font-size:11px;}
</style></head><body>
<div class="card">
<img src="/logo.jpg" alt="藍海交易學院">
<h1>藍海交易學院<br>官方LINE學員身分專區</h1>
<p>點擊下方按鈕完成學員身分認證<br>即可解鎖專屬學員服務與選單</p>
<a href="${liffUrl}" class="btn">✅ 立即認證學員身分</a>
<p class="note">此連結僅供已完成報名之學員使用</p>
</div></body></html>`);
});

app.get('/logo.jpg', (req, res) => {
  const buf = Buffer.from(LOGO_B64, 'base64');
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(buf);
});

// ===== 管理後台 =====
app.get('/admin', (req, res) => {
  const liffId = process.env.LIFF_ID || '';
  const joinLink = 'https://line-bot-083j.onrender.com/member';
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>藍海交易學院 官方LINE 管理後台 管理後台</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#1c1c1c;color:#e0e0e0;}
/* Login */
.login-wrap{display:flex;align-items:center;justify-content:center;min-height:100vh;background:#1c1c1c;}
.login-box{background:#252525;border:1px solid #333;border-radius:16px;padding:48px 40px;width:380px;}
.login-box h2{color:#3b82f6;font-size:20px;margin-bottom:8px;text-align:center;}
.login-box p{color:#888;font-size:13px;text-align:center;margin-bottom:28px;}
/* App Layout */
#app{display:none;min-height:100vh;}
.sidebar{width:240px;background:#1a1a1a;border-right:1px solid #2d2d4e;position:fixed;top:0;left:0;height:100vh;display:flex;flex-direction:column;}
.sidebar-logo{padding:24px 20px;border-bottom:1px solid #333;}
.sidebar-logo h2{color:#3b82f6;font-size:16px;font-weight:700;}
.sidebar-logo p{color:#666;font-size:12px;margin-top:4px;}
.nav-section{padding:16px 12px 8px;color:#666;font-size:11px;text-transform:uppercase;letter-spacing:1px;}
.nav-item{display:flex;align-items:center;gap:10px;padding:13px 20px;cursor:pointer;font-size:16px;font-weight:600;color:#aaa;border-radius:0;transition:all 0.15s;border-left:3px solid transparent;}
.nav-item:hover{color:#ddd;background:#2a2a2a;}
.nav-item.active{color:#3b82f6;background:#2a2a2a;border-left-color:#3b82f6;}
.nav-item .icon{font-size:16px;}
.main{margin-left:240px;padding:36px 40px;min-height:100vh;}
.page{display:none;} .page.active{display:block;}
/* Header */
.page-header{margin-bottom:28px;}
.page-header h1{font-size:24px;color:#fff;font-weight:700;}
.page-header p{color:#666;font-size:14px;margin-top:4px;}
/* Cards */
.card{background:#252525;border:1px solid #333;border-radius:12px;padding:24px;margin-bottom:20px;}
.card-title{color:#3b82f6;font-size:12px;text-transform:uppercase;letter-spacing:1px;font-weight:700;margin-bottom:16px;}
/* Form */
label{display:block;color:#aaa;font-size:13px;margin-bottom:6px;}
input,select{width:100%;padding:10px 14px;background:#1c1c1c;border:1px solid #333;border-radius:8px;color:#fff;font-size:14px;outline:none;margin-bottom:14px;transition:border 0.2s;}
input:focus,select:focus{border-color:#3b82f6;}
/* Buttons */
.btn{padding:10px 20px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:all 0.2s;display:inline-flex;align-items:center;gap:6px;}
.btn-primary{background:#3b82f6;color:#fff;} .btn-primary:hover{background:#2563eb;}
.btn-danger{background:transparent;color:#f87171;border:1px solid #f87171;padding:5px 12px;font-size:12px;} .btn-danger:hover{background:#4c1d1d;}
.btn-full{width:100%;justify-content:center;}
/* Alerts */
.alert{padding:10px 14px;border-radius:8px;font-size:13px;display:none;margin-top:12px;}
.alert-success{background:#0d2b1f;border:1px solid #166534;color:#6ee7b7;display:block;}
.alert-error{background:#2b0d0d;border:1px solid #991b1b;color:#fca5a5;display:block;}
/* Stats */
.stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:8px;}
.stat-card{background:#1a1a1a;border:1px solid #333;border-radius:10px;padding:20px 24px;}
.stat-num{font-size:36px;font-weight:800;color:#3b82f6;line-height:1;}
.stat-label{color:#666;font-size:12px;margin-top:8px;text-transform:uppercase;letter-spacing:0.5px;}
.stat-sub{color:#888;font-size:11px;margin-top:4px;}
/* Period tabs */
.period-tabs{display:flex;gap:6px;margin-bottom:20px;}
.ptab{padding:6px 18px;border:1px solid #333;background:transparent;color:#888;border-radius:20px;cursor:pointer;font-size:13px;transition:all 0.2s;}
.ptab:hover{color:#ddd;border-color:#555;}
.ptab.active{background:#3b82f6;color:#fff;border-color:#3b82f6;}
/* Table */
.table-wrap{overflow-x:auto;}
table{width:100%;border-collapse:collapse;font-size:13px;min-width:900px;}
th{padding:10px 14px;text-align:left;color:#666;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #333;white-space:nowrap;}
td{padding:12px 14px;border-bottom:1px solid #2a2a2a;color:#ccc;white-space:nowrap;}
tr:hover td{background:#1a1a1a;}
/* Tags */
.tag{display:inline-block;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:700;}
.tag-ad{background:#1e3a5f;color:#d946ef;}
.tag-normal{background:#0c2a4a;color:#38bdf8;}
.tag-paid{background:#0a2e1f;color:#4ade80;}
.tag-potential{background:#2d2400;color:#fbbf24;}
/* Link box */
.link-box{background:#1c1c1c;border:1px solid #333;border-radius:8px;padding:12px 16px;font-size:13px;color:#3b82f6;word-break:break-all;margin-bottom:14px;}
/* Filters */
.filter-row{display:flex;gap:12px;align-items:flex-end;margin-bottom:16px;}
.filter-row select{margin-bottom:0;width:auto;min-width:160px;}
</style>
</head>
<body>

<div class="login-wrap" id="loginWrap">
  <div class="login-box">
    <h2>🔐 管理後台</h2>
    <p>藍海交易學院 官方LINE 管理後台教育學院</p>
    <label>管理員密碼</label>
    <input type="password" id="loginKey" placeholder="輸入密碼" autofocus>
    <button class="btn btn-primary btn-full" id="loginBtn">登入</button>
    <div id="loginErr" class="alert"></div>
  </div>
</div>

<div id="app">
  <div class="sidebar">
    <div class="sidebar-logo">
      <h2>藍海交易學院 官方LINE 管理後台</h2>
      
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
      function fmt(d) { if(!d) return '-'; return new Date(d).toLocaleString('zh-TW', {timeZone:'Asia/Taipei', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'}); }
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
    const isAd = await isAdUser(userId);
    let profile = { displayName: '未知' };
    try { profile = await client.getProfile(userId); } catch(e) {}
    if (isAd) {
      await clearAdUser(userId);
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

      // 補救措施：若資料庫沒有此用戶，自動補上記錄
      const existing = await getUser(userId);
      if (!existing) {
        console.log(`⚠️ 補錄用戶：${profile.displayName} | ${userId}`);
        await supabase('POST', 'users', {
          user_id: userId,
          name: profile.displayName,
          source: '一般',
          joined_at: new Date().toISOString(),
          status: '潛在客'
        });
      }
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
