// 這個檔案用來查詢你所有圖文選單的 ID
// 在 Render 部署完成後，於 Shell 輸入：node get-richmenus.js

require('dotenv').config();
const line = require('@line/bot-sdk');

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
});

async function listRichMenus() {
  try {
    const result = await client.getRichMenuList();
    if (!result.richmenus || result.richmenus.length === 0) {
      console.log('目前沒有任何圖文選單，請先到 LINE Official Account Manager 建立圖文選單。');
      return;
    }
    console.log('\n===== 你的圖文選單清單 =====\n');
    result.richmenus.forEach((menu, i) => {
      console.log(`【${i + 1}】名稱：${menu.name}`);
      console.log(`     ID：${menu.richMenuId}`);
      console.log('');
    });
    console.log('請把對應的 ID 填入 Render 的環境變數中。');
  } catch (err) {
    console.error('發生錯誤：', err.message);
  }
}

listRichMenus();
