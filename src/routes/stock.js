const express  = require('express');
const pool     = require('../config/db');
const { notify } = require('../utils/fcm');
const { authenticate, adminOnly } = require('../middleware/auth');

const router = express.Router();

// GET /api/stocks — stok gudang
router.get('/', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ws.*, p.name AS product_name, p.code AS product_code,
              p.unit, p.image_url, c.name AS category_name,
              l.name AS location_name
       FROM warehouse_stocks ws
       JOIN products p ON ws.product_id = p.id
       JOIN categories c ON p.category_id = c.id
       JOIN locations l ON ws.location_id = l.id
       WHERE p.is_active = true
       ORDER BY c.name, p.name`
    );
    return res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/stocks/low — stok menipis
router.get('/low', authenticate, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ws.*, p.name AS product_name, p.code AS product_code,
              p.unit, c.name AS category_name
       FROM warehouse_stocks ws
       JOIN products p ON ws.product_id = p.id
       JOIN categories c ON p.category_id = c.id
       WHERE ws.quantity <= ws.min_stock AND ws.min_stock > 0
       ORDER BY ws.quantity ASC`
    );
    return res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/stocks/logs — riwayat perubahan stok
// PENTING: harus di atas /:product_id agar tidak tertangkap sebagai product_id
router.get('/logs', authenticate, adminOnly, async (req, res) => {
  try {
    const { product_id, limit = 50 } = req.query;

    let query  = `SELECT sl.*, p.name AS product_name, p.unit,
                         u.name AS created_by_name
                  FROM stock_logs sl
                  JOIN products p ON sl.product_id = p.id
                  LEFT JOIN users u ON sl.created_by = u.id
                  WHERE 1=1`;
    const params = [];
    let idx = 1;

    if (product_id) {
      query += ` AND sl.product_id = $${idx++}`;
      params.push(product_id);
    }

    query += ` ORDER BY sl.created_at DESC LIMIT $${idx}`;
    params.push(Math.min(parseInt(limit), 200));

    const result = await pool.query(query, params);
    return res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/stocks/:product_id — update stok manual
router.put('/:product_id', authenticate, adminOnly, async (req, res) => {
  try {
    const { product_id } = req.params;
    const { quantity, min_stock, notes, location_id } = req.body;

    if (quantity === undefined || quantity < 0) {
      return res.status(400).json({
        success: false,
        message: 'Jumlah stok tidak valid.',
      });
    }

    // Ambil lokasi gudang jika tidak diisi
    let locationId = location_id;
    if (!locationId) {
      const loc = await pool.query(
        "SELECT id FROM locations WHERE type = 'gudang' AND is_active = true LIMIT 1"
      );
      if (loc.rows.length === 0) {
        return res.status(400).json({ success: false, message: 'Gudang tidak ditemukan.' });
      }
      locationId = loc.rows[0].id;
    }

    // Cek stok saat ini
    const current = await pool.query(
      'SELECT * FROM warehouse_stocks WHERE product_id = $1 AND location_id = $2',
      [product_id, locationId]
    );

    const quantityBefore = current.rows.length > 0 ? current.rows[0].quantity : 0;
    const diff           = quantity - quantityBefore;
    const type           = diff >= 0 ? 'in' : 'out';

    if (current.rows.length === 0) {
      await pool.query(
        `INSERT INTO warehouse_stocks (product_id, location_id, quantity, min_stock, updated_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [product_id, locationId, quantity, min_stock || 0, req.user.id]
      );
    } else {
      await pool.query(
        `UPDATE warehouse_stocks SET
           quantity   = $1,
           min_stock  = COALESCE($2, min_stock),
           updated_by = $3,
           updated_at = NOW()
         WHERE product_id = $4 AND location_id = $5`,
        [quantity, min_stock ?? null, req.user.id, product_id, locationId]
      );
    }

    // Simpan log perubahan stok
    if (diff !== 0) {
      await pool.query(
        `INSERT INTO stock_logs
           (product_id, location_id, type, quantity, quantity_before, quantity_after, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [product_id, locationId, type, Math.abs(diff),
         quantityBefore, quantity, notes || 'Update manual', req.user.id]
      );
    }

    // Notifikasi jika stok menipis
    if (min_stock && quantity <= min_stock) {
      const product = await pool.query('SELECT name FROM products WHERE id = $1', [product_id]);
      const admins  = await pool.query(
        "SELECT id FROM users WHERE role IN ('super_admin', 'admin_gudang') AND is_active = true"
      );
      for (const admin of admins.rows) {
        await notify(
          admin.id,
          'Stok Menipis !!!',
          `Stok ${product.rows[0]?.name} tinggal ${quantity} unit. Segera lakukan pengisian.`,
          'stock',
          product_id,
          'products'
        );
      }
    }

    const updated = await pool.query(
      `SELECT ws.*, p.name AS product_name, p.unit
       FROM warehouse_stocks ws
       JOIN products p ON ws.product_id = p.id
       WHERE ws.product_id = $1`,
      [product_id]
    );

    return res.json({
      success: true,
      message: 'Stok berhasil diperbarui.',
      data: updated.rows[0],
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;