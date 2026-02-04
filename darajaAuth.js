const axios = require('axios');

async function getDarajaToken() {
  const auth = Buffer.from(
    `${process.env.DARAJA_CONSUMER_KEY}:${process.env.DARAJA_CONSUMER_SECRET}`
  ).toString('base64');

  const url =
    process.env.DARAJA_ENV === 'sandbox'
      ? 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
      : 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';

  const res = await axios.get(url, {
    headers: {
      Authorization: `Basic ${auth}`
    }
  });

  return res.data.access_token;
}

module.exports = { getDarajaToken };
