const admin = require('firebase-admin');
require('dotenv').config();

if (!admin.apps.length) {
  try {
    let serviceAccount;

    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      serviceAccount = require(
        require('path').resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH)
      );
    } else {
      throw new Error('Firebase credentials tidak ditemukan. Set FIREBASE_SERVICE_ACCOUNT atau FIREBASE_SERVICE_ACCOUNT_PATH');
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    console.log('Firebase Admin initialized');
  } catch (error) {
    console.error('Firebase Admin initialization error:', error.message);
  }
}

module.exports = admin;