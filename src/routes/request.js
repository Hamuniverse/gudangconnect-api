const express  = require('express');
const pool     = require('../config/db');
const { notify } = require('../utils/fcm');
const { authenticate, adminOnly } = require('../middleware/auth');

const router = express.Router();

// Helper: generate request code
const generateRequestCode = async () => {
  const date   = new Date();
  const prefix = `REQ-${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  const count  = await pool.query(
    "SELECT COUNT(*) FROM stock_requests WHERE request_code LIKE $1",
    [`${prefix}%`]
  );
  const seq = String(parseInt(count.rows[0].count) + 1).padStart(3, '0');
  return `${prefix}-${seq}`;
};

// GET /api/requests — daftar request
router.get('/', authenticate, async (req, res) => {
  try {
    const { status, location_id } = req.query;

    let query  = `SELECT sr.*, l.name AS location_name,
                         u.name AS requested_by_name,
                         r.name AS reviewed_by_name
                  FROM stock_requests sr
                  JOIN locations l ON sr.location_id = l.id
                  JOIN users u ON sr.requested_by = u.id
                  LEFT JOIN users r ON sr.reviewed_by = r.id
                  WHERE 1=1`;
    const params = [];
    let idx = 1;

    // Kepala cabang hanya bisa lihat request miliknya
    if (req.user.role === 'kepala_cabang') {
      query += ` AND sr.requested_by = $${idx++}`;
      params.push(req.user.id);
    } else if (location_id) {
      query += ` AND sr.location_id = $${idx++}`;
      params.push(location_id);
    }

    if (status) {
      query += ` AND sr.status = $${idx++}`;
      params.push(status);
    }

    query += ' ORDER BY sr.created_at DESC';

    const result = await pool.query(query, params);
    return res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/requests/:id — detail request + items
router.get('/:id', authenticate, async (req, res) => {
  try {
    const requestResult = await pool.query(
      `SELECT sr.*, l.name AS location_name,
              u.name AS requested_by_name,
              r.name AS reviewed_by_name
       FROM stock_requests sr
       JOIN locations l ON sr.location_id = l.id
       JOIN users u ON sr.requested_by = u.id
       LEFT JOIN users r ON sr.reviewed_by = r.id
       WHERE sr.id = $1`,
      [req.params.id]
    );

    if (requestResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Request tidak ditemukan.' });
    }

    const itemsResult = await pool.query(
      `SELECT sri.*, p.name AS product_name, p.code AS product_code,
              p.unit, p.image_url, ws.quantity AS available_stock
       FROM stock_request_items sri
       JOIN products p ON sri.product_id = p.id
       LEFT JOIN warehouse_stocks ws ON p.id = ws.product_id
       WHERE sri.request_id = $1`,
      [req.params.id]
    );

    return res.json({
      success: true,
      data: {
        ...requestResult.rows[0],
        items: itemsResult.rows,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/requests — buat request baru (kepala cabang)
router.post('/', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'kepala_cabang') {
      return res.status(403).json({
        success: false,
        message: 'Hanya kepala cabang yang dapat membuat request.',
      });
    }

    const { items, notes } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Items request tidak boleh kosong.',
      });
    }

    // Ambil lokasi kepala cabang
    const locResult = await pool.query(
      `SELECT location_id FROM user_locations WHERE user_id = $1 LIMIT 1`,
      [req.user.id]
    );

    if (locResult.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Lokasi cabang tidak ditemukan. Hubungi admin.',
      });
    }

    const locationId   = locResult.rows[0].location_id;
    const requestCode  = await generateRequestCode();

    // Buat request
    const requestResult = await pool.query(
      `INSERT INTO stock_requests (request_code, location_id, requested_by, notes)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [requestCode, locationId, req.user.id, notes || null]
    );

    const request = requestResult.rows[0];

    // Simpan items
    for (const item of items) {
      await pool.query(
        `INSERT INTO stock_request_items (request_id, product_id, requested_qty, notes)
         VALUES ($1, $2, $3, $4)`,
        [request.id, item.product_id, item.quantity, item.notes || null]
      );
    }

    // Notifikasi ke semua admin gudang
    const admins = await pool.query(
      "SELECT id FROM users WHERE role IN ('super_admin', 'admin_gudang') AND is_active = true"
    );

    const location = await pool.query('SELECT name FROM locations WHERE id = $1', [locationId]);

    for (const admin of admins.rows) {
      await notify(
        admin.id,
        'Request Stok Baru',
        `${location.rows[0]?.name} mengajukan request stok baru (${requestCode}). Segera ditinjau.`,
        'request',
        request.id,
        'stock_requests'
      );
    }

    return res.status(201).json({
      success: true,
      message: 'Request stok berhasil diajukan.',
      data: request,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/requests/:id/approve — setujui request (admin)
router.put('/:id/approve', authenticate, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { approved_items, notes } = req.body;

    const request = await pool.query(
      "SELECT * FROM stock_requests WHERE id = $1 AND status = 'pending'",
      [id]
    );

    if (request.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Request tidak ditemukan atau sudah diproses.',
      });
    }

    // Update approved_qty per item jika ada
    if (approved_items && Array.isArray(approved_items)) {
      for (const item of approved_items) {
        await pool.query(
          'UPDATE stock_request_items SET approved_qty = $1 WHERE id = $2',
          [item.approved_qty, item.id]
        );
      }
    }

    await pool.query(
      `UPDATE stock_requests SET status = 'approved', reviewed_by = $1,
       notes = COALESCE($2, notes), updated_at = NOW() WHERE id = $3`,
      [req.user.id, notes || null, id]
    );

    // Notifikasi ke kepala cabang
    await notify(
      request.rows[0].requested_by,
      'Request Disetujui',
      `Request stok Anda (${request.rows[0].request_code}) telah disetujui. Barang akan segera disiapkan.`,
      'request',
      id,
      'stock_requests'
    );

    return res.json({ success: true, message: 'Request berhasil disetujui.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/requests/:id/reject — tolak request (admin)
router.put('/:id/reject', authenticate, adminOnly, async (req, res) => {
  try {
    const { id }               = req.params;
    const { rejection_reason } = req.body;

    if (!rejection_reason) {
      return res.status(400).json({
        success: false,
        message: 'Alasan penolakan wajib diisi.',
      });
    }

    const request = await pool.query(
      "SELECT * FROM stock_requests WHERE id = $1 AND status = 'pending'",
      [id]
    );

    if (request.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Request tidak ditemukan atau sudah diproses.',
      });
    }

    await pool.query(
      `UPDATE stock_requests SET status = 'rejected', reviewed_by = $1,
       rejection_reason = $2, updated_at = NOW() WHERE id = $3`,
      [req.user.id, rejection_reason, id]
    );

    // Notifikasi ke kepala cabang
    await notify(
      request.rows[0].requested_by,
      'Request Ditolak',
      `Request stok Anda (${request.rows[0].request_code}) ditolak. Alasan: ${rejection_reason}`,
      'request',
      id,
      'stock_requests'
    );

    return res.json({ success: true, message: 'Request berhasil ditolak.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;