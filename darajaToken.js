// darajaToken.js
const axios = require('axios');

let cachedToken = null;
let tokenExpiry = 0; // epoch ms

async function getDarajaToken() {
  const now = Date.now();

  // ✅ still valid (1 min buffer)
  if (cachedToken && now < tokenExpiry - 60_000) {
    return cachedToken;
  }

  const auth = Buffer.from(
    `${process.env.DARAJA_CONSUMER_KEY}:${process.env.DARAJA_CONSUMER_SECRET}`
  ).toString('base64');

  const url =
    process.env.DARAJA_ENV === 'production'
      ? 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
      : 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';

  const res = await axios.get(url, {
    headers: { Authorization: `Basic ${auth}` }
  });

  cachedToken = res.data.access_token;
  tokenExpiry = now + res.data.expires_in * 1000;

  return cachedToken;
}

module.exports = { getDarajaToken };
