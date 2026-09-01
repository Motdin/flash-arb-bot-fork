// Telegram messaging using node-fetch
// Using global fetch available in Node.js
/** Send a Telegram message if credentials are present. */
function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('⚠️ Telegram credentials missing – message not sent.');
    return;
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown'
  };
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
    .then(res => res.json())
    .then(json => {
      if (!json.ok) console.error('❌ Telegram API error', json);
    })
    .catch(err => console.error('❌ Telegram request error', err));
}
module.exports = { sendTelegramMessage };
