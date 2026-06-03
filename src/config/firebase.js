const admin = require('firebase-admin');
require('dotenv').config();

if (!admin.apps.length) {
  const serviceAccount = require(
    require('path').resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH)
  );

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  console.log('Firebase Admin initialized');
}

module.exports = admin;