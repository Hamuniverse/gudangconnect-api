const admin = require('../config/firebase');
const pool  = require('../config/db');

/**
 * Kirim push notification ke satu user spesifik
 * @param {string} userId - UUID user tujuan
 * @param {string} title  - Judul notifikasi
 * @param {string} message - Isi notifikasi
 * @param {object} data   - Data tambahan (opsional)
 */
const sendNotificationToUser = async (userId, title, message, data = {}) => {
  try {
    // Ambil FCM token user dari database
    const result = await pool.query(
      `SELECT fcm_token FROM personal_access_tokens
       WHERE user_id = $1 AND fcm_token IS NOT NULL
       ORDER BY last_used_at DESC LIMIT 1`,
      [userId]
    );

    if (result.rows.length === 0 || !result.rows[0].fcm_token) {
      console.log(`No FCM token for user ${userId}`);
      return false;
    }

    const fcmToken = result.rows[0].fcm_token;

    // Kirim notifikasi via FCM
    const fcmMessage = {
      token: fcmToken,
      notification: { title, body: message },
      data: {
        ...data,
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'gudangconnect_channel',
        },
      },
    };

    await admin.messaging().send(fcmMessage);
    console.log(`Notification sent to user ${userId}`);
    return true;
  } catch (err) {
    console.error(`FCM error for user ${userId}:`, err.message);
    return false;
  }
};

/**
 * Kirim push notification ke banyak user sekaligus
 * @param {string[]} userIds - Array UUID user tujuan
 * @param {string} title
 * @param {string} message
 * @param {object} data
 */
const sendNotificationToMany = async (userIds, title, message, data = {}) => {
  const results = await Promise.all(
    userIds.map((userId) => sendNotificationToUser(userId, title, message, data))
  );
  return results;
};

/**
 * Simpan notifikasi ke database
 * @param {string} userId
 * @param {string} title
 * @param {string} message
 * @param {string} type       - request | delivery | stock | system
 * @param {string} referenceId - UUID referensi (request_id / delivery_id)
 * @param {string} referenceType - stock_requests | deliveries
 */
const saveNotification = async (
  userId,
  title,
  message,
  type = 'system',
  referenceId = null,
  referenceType = null
) => {
  try {
    await pool.query(
      `INSERT INTO notifications
         (user_id, title, message, type, reference_id, reference_type)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, title, message, type, referenceId, referenceType]
    );
  } catch (err) {
    console.error('FCM error:', err.message);
  }
};

/**
 * Kirim notifikasi + simpan ke database sekaligus
 */
const notify = async (
  userId,
  title,
  message,
  type = 'system',
  referenceId = null,
  referenceType = null,
  data = {}
) => {
  await saveNotification(userId, title, message, type, referenceId, referenceType);
  await sendNotificationToUser(userId, title, message, {
    ...data,
    type,
    reference_id:   referenceId   || '',
    reference_type: referenceType || '',
  });
};

module.exports = {
  sendNotificationToUser,
  sendNotificationToMany,
  saveNotification,
  notify,
};