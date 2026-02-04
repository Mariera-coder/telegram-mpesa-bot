// subscription.js
const { admin, db } = require('./firebase');

async function activateSubscription(telegramId, plan) {
  const userRef = db.collection('users').doc(String(telegramId));

  await db.runTransaction(async t => {
    const snap = await t.get(userRef);
    if (!snap.exists) return;

    const now = admin.firestore.Timestamp.now();
    const data = snap.data();

    const currentExpiry = data.expiresAt || null;
    const status = data.status || 'INACTIVE';

    let baseDate;
    if (
      status === 'ACTIVE' &&
      currentExpiry &&
      currentExpiry.toMillis() > now.toMillis()
    ) {
      baseDate = currentExpiry.toDate();
    } else {
      baseDate = new Date();
    }

    const durations = { daily: 1, weekly: 7, monthly: 30 };
    const days = durations[plan];
    if (!days) return;

    const newExpiry = new Date(baseDate.getTime() + days * 86400000);

    // 🔐 idempotency guard
    if (currentExpiry && currentExpiry.toMillis() >= newExpiry.getTime()) {
      return;
    }

    t.set(
      userRef,
      {
        status: 'ACTIVE',
        plan,
        expiresAt: admin.firestore.Timestamp.fromDate(newExpiry),
        activatedAt: now,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  });
}

module.exports = { activateSubscription };
