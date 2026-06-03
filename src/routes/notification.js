const express  = require('express');
const pool     = require('../config/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// GET /api/notifications
router.get('/', authenticate, async (req, res) => {
  try {
    const notifications = await pool.query(
      `SELECT id, title, message, type, reference_id, reference_type,
              is_read, read_at, created_at
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.user.id]
    );

    const unreadCount = notifications.rows.filter(n => !n.is_read).length;

    // Tandai semua sebagai dibaca
    await pool.query(
      `UPDATE notifications SET is_read = true, read_at = NOW()
       WHERE user_id = $1 AND is_read = false`,
      [req.user.id]
    );

    return res.json({
      success:      true,
      unread_count: unreadCount,
      data:         notifications.rows,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/notifications/unread-count
router.get('/unread-count', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false',
      [req.user.id]
    );
    return res.json({
      success: true,
      unread_count: parseInt(result.rows[0].count),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/notifications — hapus semua notifikasi
router.delete('/', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM notifications WHERE user_id = $1',
      [req.user.id]
    );
    return res.json({
      success: true,
      message: `${result.rowCount} notifikasi berhasil dihapus.`,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/notifications/:id — hapus satu notifikasi
router.delete('/:id', authenticate, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM notifications WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    return res.json({ success: true, message: 'Notifikasi berhasil dihapus.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;