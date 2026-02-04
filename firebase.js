const admin = require('firebase-admin');

admin.initializeApp({
  credential: admin.credential.cert(
    require(process.env.FIREBASE_KEY_PATH)
  )
});

const db = admin.firestore();

module.exports = { admin, db };

