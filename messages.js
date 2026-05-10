// messages.js
// 所有 LINE 訊息範本集中管理。修改文案只需要動這個檔案,不必動到主程式邏輯。

module.exports = {
  // ===== 階段一:預約審核通知 =====
  bookingApproved: ({ name, appointmentAt }) => [
    `${name} 你好 👋`,
    '',
    `🎉 恭喜！你的「一對一交易研討會」申請已成功通過審核。`,
    '',
    `📅 你的預約時段：${appointmentAt || '我們會再透過 LINE 與你確認'}`,
    '',
    `在研討會之前，你可以先準備任何想問的交易問題 💪`,
    '',
    `我們會在諮詢前一天再次透過 LINE 提醒你，請先保留好這段時間 🙏`,
    '',
    `期待與你見面！`
  ].join('\n'),

  // 拒絕版:你決定改成手動發,這個函式先保留備用,目前 index.js 不會呼叫到
  bookingRejected: ({ name }) => [
    `${name} 你好 🙏`,
    '',
    `感謝你申請藍海的「一對一交易研討會」。`,
    '',
    `經評估後此次未安排研討會，建議你先觀看選單中的免費診斷課，後續可再次申請。`
  ].join('\n'),

  // ===== 階段二:加溫跟進(待實作)=====
  // TODO: 加 LINE 後 24h 沒看課程
  // warmup_notWatchedCourse: ({ name }) => `...`,

  // TODO: 看完課程但 48h 沒預約
  // warmup_watchedNotBooked: ({ name }) => `...`,

  // ===== 階段三:出席提醒(待實作)=====
  // TODO: 諮詢前 24h
  // reminder_24h: ({ name, appointmentAt, meetLink }) => `...`,

  // TODO: 諮詢前 2h
  // reminder_2h: ({ name, appointmentAt, meetLink }) => `...`,

  // ===== 階段四:再行銷(待實作)=====
  // TODO: 學員見證
  // remarket_testimonial: ({ name }) => `...`,

  // TODO: 自媒體精選內容
  // remarket_content: ({ name }) => `...`,
};
