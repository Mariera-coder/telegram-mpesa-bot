const axios = require('axios');
const moment = require('moment');
const { getDarajaToken } = require('./darajaToken');

/* --------------------
   PHONE NORMALIZER
-------------------- */
function normalizePhone(phone) {
  const cleaned = phone.trim();

  if (/^07\d{8}$/.test(cleaned)) {
    return '254' + cleaned.slice(1);
  }

  if (/^01\d{8}$/.test(cleaned)) {
    return '254' + cleaned.slice(1);
  }

  if (/^254\d{9}$/.test(cleaned)) {
    return cleaned;
  }

  throw new Error('INVALID_PHONE_FORMAT');
}

/* --------------------
   STK PUSH
-------------------- */
async function stkPush({ phone, amount, accountRef }) {
  try {
    const msisdn = normalizePhone(phone);
    const timestamp = moment().format('YYYYMMDDHHmmss');

    const password = Buffer.from(
      process.env.MPESA_SHORTCODE +
        process.env.MPESA_PASSKEY +
        timestamp
    ).toString('base64');

    const payload = {
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: msisdn,
      PartyB: process.env.MPESA_SHORTCODE,
      PhoneNumber: msisdn,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: accountRef,
      TransactionDesc: 'Subscription Payment'
    };

    // 🔐 Auto-refreshing OAuth token
    const token = await getDarajaToken();

    const url =
      process.env.DARAJA_ENV === 'production'
        ? 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest'
        : 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest';

    const res = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    return res.data;

  } catch (err) {
    console.error('❌ STK PUSH ERROR', {
      message: err.message,
      mpesa: err.response?.data
    });

    throw new Error('STK_PUSH_FAILED');
  }
}

module.exports = { stkPush };

