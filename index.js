require('dotenv').config();

const { Telegraf, Markup, session } = require('telegraf');
const express = require('express');
const crypto = require('crypto');
const { stkPush } = require('./mpesa');
const { activateSubscription } = require('./subscription');




/* --------------------
   CONSTANTS
-------------------- */
const ADMIN_ID = Number(process.env.ADMIN_ID);
function isAdmin(ctx) {
  return ctx.from?.id === ADMIN_ID;
}


/* --------------------
   Firebase Init
-------------------- */

const { admin, db } = require('./firebase');


/* ======================================================
   ⏱️ EXPIRY BUSINESS LOGIC (SLEEP-SAFE)
====================================================== */

/**
 * Expire pending M-Pesa transactions
 */
async function expirePendingTransactions() {
  const now = admin.firestore.Timestamp.now();

  const snap = await db
    .collection('transactions')
    .where('status', '==', 'PENDING')
    .where('expiresAt', '<=', now)
    .get();

  for (const doc of snap.docs) {
    await doc.ref.update({ status: 'EXPIRED' });
  }

  if (!snap.empty) {
    console.log(`⏰ Expired ${snap.size} pending transactions`);
  }
}

/**
 * Expire active subscriptions
 */
async function expireSubscriptions() {
  const now = admin.firestore.Timestamp.now();

  const snap = await db
    .collection('users')
    .where('status', '==', 'ACTIVE')
    .where('expiresAt', '<=', now)
    .get();

  for (const doc of snap.docs) {
    await doc.ref.update({
      status: 'INACTIVE',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await bot.telegram.sendMessage(
      doc.id,
      '⏰ Your subscription has expired. Please renew.'
    );
  }

  if (!snap.empty) {
    console.log(`⏰ Expired ${snap.size} subscriptions`);
  }
}




/* --------------------
   Telegram Bot Init
-------------------- */
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
bot.use(session());

/* ✅ SESSION SAFETY GUARD (ONLY ADDITION) */
bot.use((ctx, next) => {
  ctx.session ??= {};
  return next();
});


/* ======================================================
   🔁 STARTUP RECONCILIATION (CRASH / SLEEP SAFE)
====================================================== */

async function reconcileOnStartup() {
  console.log('🔁 Reconciling expired records on startup...');
  await expirePendingTransactions();
  await expireSubscriptions();
}

reconcileOnStartup();
/* --------------------
   Express Init
-------------------- */
const app = express();
app.use(express.json());



/* ======================================================
   ☁️ CLOUD SCHEDULER TASK ENDPOINTS
====================================================== */




/* --------------------
   Admin Guard
-------------------- */
function adminOnly(ctx, next) {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply('⛔ Admin only command.');
  }
  return next();
}

/* --------------------
   Roles Helper
-------------------- */
function getUserRole(ctx) {
  return ctx.from.id === ADMIN_ID ? 'ADMIN' : 'USER';
}

/* --------------------
   Plans
-------------------- */
const plans = {
  daily: { price: 100, days: 1 },
  weekly: { price: 200, days: 7 },
  monthly: { price: 400, days: 30 }
};

/* --------------------
   RETRY BUTTON
-------------------- */
/* --------------------
   RETRY BUTTON (GUARDED)
-------------------- */
bot.action(/retry:(.+)/, async ctx => {
  const txRef = db.collection('transactions').doc(ctx.match[1]);
  const snap = await txRef.get();

  if (!snap.exists) {
    return ctx.reply('❌ Transaction not found.');
  }

  const tx = snap.data();

  // 🚫 Block early retry while callback may still arrive
  if (tx.status === 'PENDING' && tx.expiresAt.toDate() > new Date()) {
    return ctx.reply(
      '⏳ Payment is still being processed.\n' +
      'If money was deducted, you will be activated automatically.'
    );
  }

  // ✅ Safe to expire and retry
  await txRef.update({ status: 'EXPIRED' });

  ctx.reply('🔁 Retry started. Please enter your phone number again.');
});

/* --------------------
   /PLANS
-------------------- */

bot.command('plans', ctx => {
  ctx.reply(
    'Choose a plan:',
    Markup.inlineKeyboard([
      [Markup.button.callback('Daily @100', 'daily')],
      [Markup.button.callback('Weekly @200', 'weekly')],
      [Markup.button.callback('Monthly @400', 'monthly')]
    ])
  );
});



/* --------------------
   /status
-------------------- */
bot.command('status', async ctx => {
  const snap = await db.collection('users').doc(String(ctx.from.id)).get();

  if (!snap.exists || snap.data().status !== 'ACTIVE') {
    return ctx.reply(
      `🆔 ID: ${ctx.from.id}\n👤 Name: ${ctx.from.first_name}\n🔴 Status: INACTIVE`
    );
  }

  ctx.reply(
`🆔 ID: ${ctx.from.id}
👤 Name: ${ctx.from.first_name}
🟢 Status: ACTIVE
📦 Plan: ${snap.data().plan}
⏳ Expires: ${snap.data().expiresAt.toDate().toLocaleString()}`
  );
});

/* --------------------
   /help
-------------------- */
bot.command('help', async ctx => {
  const snap = await db.collection('users').doc(String(ctx.from.id)).get();

  if (!snap.exists || snap.data().status !== 'ACTIVE') {
    return ctx.reply(
      '🔒 Help is available to active subscribers only.\n\n' +
      'Please subscribe to access support.'
    );
  }

  ctx.reply(
`🆘 Need help?

📞 Contact Support: 0713 324 899`
  );
});

/* --------------------
   /CANCEL
-------------------- */
bot.command('cancel', async ctx => {
  // 🧹 Clear in-progress plan selection
  if (ctx.session.plan) {
    delete ctx.session.plan;

    return ctx.reply(
      '❌ Subscription selection cancelled.\n\n' +
      'You can now choose a different plan using /plans.'
    );
  }

  // 🔎 Check if user is already active
  const snap = await db.collection('users').doc(String(ctx.from.id)).get();

  if (snap.exists && snap.data().status === 'ACTIVE') {
    return ctx.reply(
      '✅ You already have an active subscription.\n\n' +
      'If you need help, use /help.'
    );
  }

  // 💤 Nothing to cancel
  return ctx.reply(
    'ℹ️ There is no active subscription process to cancel.\n\n' +
    'Use /plans to start.'
  );
});


/* --------------------
   ADMIN: /users
-------------------- */
bot.command('users', adminOnly, async ctx => {
  const snap = await db.collection('users').get();
  if (snap.empty) return ctx.reply('No users found.');

  let msg = '👥 USERS LIST\n\n';

  snap.forEach(doc => {
    const u = doc.data();
    msg +=
`🆔 ${u.telegramId}
👤 ${u.name || '—'}
📦 ${u.plan || '—'}
📊 ${u.status}
⏳ ${u.expiresAt ? u.expiresAt.toDate().toDateString() : '—'}
----------------------\n`;
  });

  ctx.reply(msg);
});

/* --------------------
   ADMIN: /activate
-------------------- */
bot.command('activate', adminOnly, async ctx => {
  const parts = ctx.message.text.split(' ');
  if (parts.length !== 3) {
    return ctx.reply('Usage:\n/activate <telegramId> <daily|weekly|monthly>');
  }

  const telegramId = Number(parts[1]);
  const planKey = parts[2];
  if (!plans[planKey]) return ctx.reply('Invalid plan.');

  const userRef = db.collection('users').doc(String(telegramId));
  const snap = await userRef.get();

  let baseTime = Date.now();
  if (snap.exists && snap.data().status === 'ACTIVE') {
    baseTime = snap.data().expiresAt.toDate().getTime();
  }

  const expiresAt = admin.firestore.Timestamp.fromDate(
    new Date(baseTime + plans[planKey].days * 86400000)
  );

  await userRef.set({
    telegramId,
    plan: planKey,
    status: 'ACTIVE',
    expiresAt,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await bot.telegram.sendMessage(
    telegramId,
    '✅ Your subscription has been activated by admin.'
  );

  ctx.reply(`✅ User ${telegramId} activated.`);
});

/* ======================================================
   💰 ADMIN REVENUE COMMANDS
====================================================== */



/* ======================================================
   💰 ADMIN REVENUE COMMANDS
====================================================== */

/* ---- /revenue_today ---- */
bot.command('revenue_today', adminOnly, async ctx => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const snap = await db
    .collection('transactions')
    .where('status', '==', 'SUCCESS')
    .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(start))
    .get();

  let total = 0;
  snap.forEach(doc => total += doc.data().amount);

  ctx.reply(`💰 Revenue Today: KES ${total}`);
});

/* ---- /revenue_month ---- */
bot.command('revenue_month', adminOnly, async ctx => {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);

  const snap = await db
    .collection('transactions')
    .where('status', '==', 'SUCCESS')
    .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(start))
    .get();

  let total = 0;
  snap.forEach(doc => total += doc.data().amount);

  ctx.reply(`📆 Revenue This Month: KES ${total}`);
});

/* ---- /revenue_all ---- */
bot.command('revenue_all', adminOnly, async ctx => {
  const snap = await db
    .collection('transactions')
    .where('status', '==', 'SUCCESS')
    .get();

  let total = 0;
  snap.forEach(doc => total += doc.data().amount);

  ctx.reply(`🏦 Total Revenue (All Time): KES ${total}`);
});

/* ---- /stats ---- */
bot.command('stats', adminOnly, async ctx => {
  const usersSnap = await db.collection('users').get();
  const txSnap = await db
    .collection('transactions')
    .where('status', '==', 'SUCCESS')
    .get();

  let active = 0;
  let inactive = 0;

  usersSnap.forEach(doc => {
    doc.data().status === 'ACTIVE' ? active++ : inactive++;
  });

  ctx.reply(
`📊 SYSTEM STATS

👥 Users: ${usersSnap.size}
🟢 Active: ${active}
🔴 Inactive: ${inactive}
💳 Successful Payments: ${txSnap.size}`
  );
});

/* --------------------
   ADMIN: /daily
-------------------- */
bot.command('daily', adminOnly, async ctx => {
  const now = new Date();

  const startOfDay = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  );

  // 👤 New users today
  const usersTodaySnap = await db
    .collection('users')
    .where('firstSeenAt', '>=', startOfDay)
    .get();

  // 💳 Successful payments today
  const paymentsTodaySnap = await db
    .collection('transactions')
    .where('status', '==', 'SUCCESS')
    .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(startOfDay))
    .get();

  let revenue = 0;
  paymentsTodaySnap.forEach(doc => {
    revenue += doc.data().amount || 0;
  });

  // 👥 Total users
  const totalUsersSnap = await db.collection('users').get();

  const dateLabel = now.toDateString();

  await ctx.reply(
    `📈 DAILY ADMIN REPORT\n` +
    `🌏 ${dateLabel}\n` +
    `────────────────────\n\n` +
    `👤 New users today: ${usersTodaySnap.size}\n` +
    `💳 Successful payments today: ${paymentsTodaySnap.size}\n` +
    `💰 Revenue today: KES ${revenue}\n\n` +
    `👥 Total users: ${totalUsersSnap.size}`
  );
});


bot.command('whoami', ctx => {
  ctx.reply(
    `🆔 Telegram ID: ${ctx.from.id}\n` +
    `👤 First Name: ${ctx.from.first_name}`
  );
});
bot.command('testadmin', ctx => {
  if (isAdmin(ctx)) {
    return ctx.reply('👑 You are the admin');
  }
  ctx.reply('👤 You are a normal user');
});

bot.command('report', async ctx => {

  // 🔐 Admin-only
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply('⛔ This command is for admins only.');
  }

  const db = admin.firestore();

  const now = new Date();

  // 🕛 Start of today
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  );

  // 🗓 Start of month
  const startOfMonth = new Date(
    now.getFullYear(),
    now.getMonth(),
    1
  );

  // 🔢 Queries
  const totalUsersSnap = await db.collection('users').get();

  const todayUsersSnap = await db
    .collection('users')
    .where('firstSeenAt', '>=', startOfToday)
    .get();

  const monthUsersSnap = await db
    .collection('users')
    .where('firstSeenAt', '>=', startOfMonth)
    .get();

  // 📊 Counts
  const totalUsers = totalUsersSnap.size;
  const todayUsers = todayUsersSnap.size;
  const monthUsers = monthUsersSnap.size;

  // 🗓 Friendly date
  const dateString = now.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'numeric',
    year: 'numeric'
  });

  // 📈 Report message
  const report =
`📈 Bot review report
🌏 ${dateString}
_______________________________

📊 Today new users: ${todayUsers}
📊 Today visits: 0

📊 This month new users: ${monthUsers}
📊 This month visits: 0

🔰 Users total number: ${totalUsers}
_______________________________`;

  await ctx.reply(report);
});

/* ============================
   👑 ADMIN MENU
============================ */
bot.command('admin', async ctx => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply('⛔ Admin only command.');
  }

  return ctx.reply(
    '👑 Admin Control Panel\n\nChoose an action:',
    Markup.inlineKeyboard([
      [Markup.button.callback('📊 System Stats', 'ADMIN_STATS')],
      [Markup.button.callback('📈 Daily Report', 'ADMIN_DAILY')],
      [Markup.button.callback('💰 Revenue', 'ADMIN_REVENUE_MENU')],
      [Markup.button.callback('👤 Activate User', 'ADMIN_ACTIVATE_HELP')]
    ])
  );
});

bot.action('ADMIN_STATS', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  await ctx.answerCbQuery();
  return ctx.reply('Running /stats …').then(() => {
    ctx.telegram.sendMessage(ctx.chat.id, '/stats');
  });
});
 
bot.action('ADMIN_DAILY', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  await ctx.answerCbQuery();
  return ctx.reply('Running /daily …').then(() => {
    ctx.telegram.sendMessage(ctx.chat.id, '/daily');
  });
});

bot.action('ADMIN_REVENUE_MENU', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  await ctx.answerCbQuery();

  return ctx.reply(
    '💰 Revenue Reports',
    Markup.inlineKeyboard([
      [Markup.button.callback('📆 Today', 'ADMIN_REVENUE_TODAY')],
      [Markup.button.callback('🗓 This Month', 'ADMIN_REVENUE_MONTH')],
      [Markup.button.callback('🏦 All Time', 'ADMIN_REVENUE_ALL')],
      [Markup.button.callback('⬅️ Back', 'ADMIN_BACK')]
    ])
  );
});

bot.action('ADMIN_REVENUE_TODAY', async ctx => {
  await ctx.answerCbQuery();
  ctx.telegram.sendMessage(ctx.chat.id, '/revenue_today');
});

bot.action('ADMIN_REVENUE_MONTH', async ctx => {
  await ctx.answerCbQuery();
  ctx.telegram.sendMessage(ctx.chat.id, '/revenue_month');
});

bot.action('ADMIN_REVENUE_ALL', async ctx => {
  await ctx.answerCbQuery();
  ctx.telegram.sendMessage(ctx.chat.id, '/revenue_all');
});

bot.action('ADMIN_BACK', async ctx => {
  await ctx.answerCbQuery();
  ctx.telegram.sendMessage(ctx.chat.id, '/admin');
});

bot.action('ADMIN_ACTIVATE_HELP', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  await ctx.answerCbQuery();

  return ctx.reply(
`👤 USER ACTIVATION GUIDE

To activate a user manually:

/activate <telegramId> <plan>

📌 Example:
/activate 8529710084 monthly

📦 Available plans:
• daily
• weekly
• monthly

⚠️ If user is ACTIVE, time is extended.
⬅️ Use /admin to go back`
  );
});


/* --------------------
   BOT FLOW
-------------------- */
bot.start(async ctx => {
  /* ============================
     📊 VISIT TRACKING (STEP 1)
  ============================ */
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const month = today.slice(0, 7);                     // YYYY-MM

  const statsRef = db.collection('stats').doc('global');

  await db.runTransaction(async t => {
    const snap = await t.get(statsRef);
    const data = snap.exists ? snap.data() : {};

    const daily = data.daily || {};
    const monthly = data.monthly || {};

    daily[today] ??= { visits: 0, newUsers: 0 };
    monthly[month] ??= { visits: 0, newUsers: 0 };

    daily[today].visits += 1;
    monthly[month].visits += 1;

    t.set(
      statsRef,
      {
        totalVisits: (data.totalVisits || 0) + 1,
        daily,
        monthly
      },
      { merge: true }
    );
  });

  /* ============================
     👑 ADMIN AUTO-ACTIVATION
  ============================ */
  const isAdmin = ctx.from.id === ADMIN_ID;

  if (isAdmin) {
    await db.collection('users').doc(String(ctx.from.id)).set({
      telegramId: ctx.from.id,
      name: ctx.from.first_name,
      role: 'ADMIN',
      status: 'ACTIVE',
      plan: 'ADMIN',
      expiresAt: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return ctx.reply(
      `👑 Welcome Admin ${ctx.from.first_name}\n\n` +
      `You are auto-activated.\n` +
      `No payment required.`
    );
  }

  /* ============================
     👤 NORMAL USER FLOW
  ============================ */
  const userRef = db.collection('users').doc(String(ctx.from.id));
  const snap = await userRef.get();

  const isNewUser = !snap.exists;

  await userRef.set({
    telegramId: ctx.from.id,
    name: ctx.from.first_name,
    role: 'USER',
    firstSeenAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  // 📈 Count NEW users
  if (isNewUser) {
    await statsRef.update({
      totalUsers: admin.firestore.FieldValue.increment(1),
      [`daily.${today}.newUsers`]: admin.firestore.FieldValue.increment(1),
      [`monthly.${month}.newUsers`]: admin.firestore.FieldValue.increment(1)
    });
  }

  await ctx.reply(
    `Hi ${ctx.from.first_name}, choose a plan:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('Daily @100', 'daily')],
      [Markup.button.callback('Weekly @200', 'weekly')],
      [Markup.button.callback('Monthly @400', 'monthly')]
    ])
  );
});


bot.action(/daily|weekly|monthly/, async ctx => {

  // 🚫 Block admin from payment flow
  if (ctx.from.id === ADMIN_ID) {
    return ctx.reply(
      '👑 Admin account detected.\n' +
      'You are auto-activated and do not require payment.'
    );
  }

  ctx.session.plan = ctx.match[0];
  await ctx.reply('Enter your Safaricom number (07XXXXXXXX)');
});



bot.on('text', async ctx => {

  // 🚫 Absolute admin payment lock
  if (ctx.from.id === ADMIN_ID) return;

  const text = ctx.message.text;


  // 🚦 Let Telegraf handle ALL commands
  if (text.startsWith('/')) return;

  // 🚫 No active flow
  if (!ctx.session.plan && !ctx.session.retry) return;

  const phone = text.trim();

  if (!/^(07|01)\d{8}$/.test(phone)) {
    return ctx.reply('❌ Invalid Safaricom number.');
  }

  /* 🔁 RETRY FLOW */
  if (ctx.session.retry) {
    const { plan, amount } = ctx.session.retry;

    const txRef = await db.collection('transactions').add({
      telegramId: ctx.from.id,
      name: ctx.from.first_name,
      plan,
      amount,
      status: 'PENDING',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromDate(
        new Date(Date.now() + 3 * 60 * 1000)
      )
    });

    try {
      const stkRes = await stkPush({
        phone,
        amount,
        accountRef: txRef.id
      });

      await db.collection('transactions').doc(txRef.id).update({
        checkoutRequestId: stkRes.CheckoutRequestID,
        merchantRequestId: stkRes.MerchantRequestID
      });

    } catch (err) {
      await ctx.reply('❌ Failed to resend STK Push.');
      return;
    }

    delete ctx.session.retry;

    return ctx.reply(
      '📲 STK resent. Complete payment on your phone.',
      Markup.inlineKeyboard([
        [Markup.button.callback('Retry M-Pesa', `retry:${txRef.id}`)]
      ])
    );
  }

  /* 🆕 NORMAL FLOW */
  const plan = plans[ctx.session.plan];

  const txRef = await db.collection('transactions').add({
    telegramId: ctx.from.id,
    name: ctx.from.first_name,
    plan: ctx.session.plan,
    amount: plan.price,
    status: 'PENDING',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: admin.firestore.Timestamp.fromDate(
      new Date(Date.now() + 3 * 60 * 1000)
    )
  });

  try {
    const stkRes = await stkPush({
      phone,
      amount: plan.price,
      accountRef: txRef.id
    });

    await db.collection('transactions').doc(txRef.id).update({
      checkoutRequestId: stkRes.CheckoutRequestID,
      merchantRequestId: stkRes.MerchantRequestID
    });

  } catch (err) {
    await ctx.reply('❌ Failed to send STK Push.');
    return;
  }

  delete ctx.session.plan;

  await ctx.reply(
    '📲 STK sent. Complete payment on your phone.',
    Markup.inlineKeyboard([
      [Markup.button.callback('Retry M-Pesa', `retry:${txRef.id}`)]
    ])
  );
});






/* --------------------
   M-PESA CALLBACK
-------------------- */
app.post('/mpesa/callback', async (req, res) => {
  try {
    const stkCallback = req.body?.Body?.stkCallback;
    if (!stkCallback) {
      return res.status(400).send('Invalid payload');
    }

    const {
      CheckoutRequestID,
      ResultCode,
      ResultDesc
    } = stkCallback;

    // 1️⃣ Find transaction
    const snap = await db
      .collection('transactions')
      .where('checkoutRequestId', '==', CheckoutRequestID)
      .limit(1)
      .get();

    if (snap.empty) {
      console.warn('⚠️ Unknown CheckoutRequestID', CheckoutRequestID);
      return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }

    const txRef = snap.docs[0].ref;

    // 2️⃣ 🔐 IDMPOTENT CORE (THIS IS YOUR BLOCK)
    let shouldActivate = false;
    let telegramId;
    let plan;

    await db.runTransaction(async t => {
      const fresh = await t.get(txRef);
      if (!fresh.exists) return;

      const data = fresh.data();

      // 🔒 Idempotency guard
      if (data.status !== 'PENDING') return;

      // ❌ Payment failed
      if (ResultCode !== 0) {
        t.update(txRef, {
          status: 'FAILED',
          failureReason: ResultDesc,
          completedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return;
      }

      // ✅ Payment success
      t.update(txRef, {
        status: 'SUCCESS',
        completedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Prepare activation
      shouldActivate = true;
      telegramId = data.telegramId;
      plan = data.plan;
    });

    // 3️⃣ Activate OUTSIDE transaction
    if (shouldActivate) {
      await activateSubscription(telegramId, plan);
    }

    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  } catch (err) {
    console.error('❌ CALLBACK ERROR', err);
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }
});

/* ======================================================
   🧪 SANDBOX MOCK CALLBACK (TEST ONLY)
====================================================== */
app.post('/sandbox/mock-callback/:transactionId', async (req, res) => {
  const { transactionId } = req.params;

  const txRef = db.collection('transactions').doc(transactionId);
  const snap = await txRef.get();

  if (!snap.exists) {
    return res.status(404).send('Transaction not found');
  }

  const tx = snap.data();

  const fakeCallback = {
    Body: {
      stkCallback: {
        MerchantRequestID: 'MOCK_MERCHANT',
        CheckoutRequestID: tx.checkoutRequestId,
        ResultCode: 0,
        ResultDesc: 'Success'
      }
    }
  };

  // Re-route to real callback
  req.body = fakeCallback;
  req.url = '/mpesa/callback';
  req.method = 'POST';

  return app._router.handle(req, res, () => {});
});

/* ======================================================
   ⏲️ LOCAL CRON TRIGGERS (SAFE AGAINST SLEEP)
====================================================== */


app.post('/jobs/reconcile', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).send('Forbidden');
  }

  try {
    console.log('⏱️ Cloud Scheduler reconcile started');

    await expirePendingTransactions();
    await expireSubscriptions();

    console.log('✅ Reconcile completed');
    res.status(200).send('OK');
  } catch (err) {
    console.error('❌ Reconcile failed', err);
    res.status(500).send('FAILED');
  }
});




/* --------------------
   MENU-ONLY COMMANDS ENFORCEMENT
-------------------- */

/* --------------------
   ROLE-BASED MENU COMMANDS
-------------------- */
async function setMenus() {
  // USER MENU
 await bot.telegram.setMyCommands(
  [
    { command: 'start', description: 'Start the bot' },
    { command: 'plans', description: 'Subscription plans' },
    { command: 'status', description: 'Subscription status' },
    { command: 'help', description: 'Contact support' },
    { command: 'cancel', description: 'Cancel current operation' }
  ],
  { scope: { type: 'default' } }
);


  // ADMIN MENU
  await bot.telegram.setMyCommands(
    [
      { command: 'users', description: 'List all users' },
      { command: 'activate', description: 'Manually activate user' },
      { command: 'revenue_today', description: 'Revenue today' },
      { command: 'revenue_month', description: 'Revenue this month' },
      { command: 'revenue_all', description: 'Total revenue' },
      { command: 'stats', description: 'System stats' }
    ],
    {
      scope: {
        type: 'chat',
        chat_id: ADMIN_ID
      }
    }
  );

  console.log('📜 Command menus set');
}

/* --------------------
   START
-------------------- */
app.listen(process.env.PORT, () =>
  console.log(`🌍 Server running on port ${process.env.PORT}`)
);

bot.launch().then(setMenus);
console.log('🤖 Telegram bot running');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

