const express  = require('express');
const pool     = require('../config/db');
const upload   = require('../middleware/upload');
const { notify } = require('../utils/fcm');
const { authenticate, adminOnly } = require('../middleware/auth');

const router = express.Router();

// Helper: generate delivery code
const generateDeliveryCode = async () => {
  const date   = new Date();
  const prefix = `DLV-${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  const count  = await pool.query(
    "SELECT COUNT(*) FROM deliveries WHERE delivery_code LIKE $1",
    [`${prefix}%`]
  );
  const seq = String(parseInt(count.rows[0].count) + 1).padStart(3, '0');
  return `${prefix}-${seq}`;
};

// GET /api/deliveries — daftar pengiriman
router.get('/', authenticate, async (req, res) => {
  try {
    const { status } = req.query;

    let query  = `SELECT d.*,
                         fl.name AS from_location_name,
                         tl.name AS to_location_name,
                         u.name AS handled_by_name,
                         sr.request_code
                  FROM deliveries d
                  JOIN locations fl ON d.from_location = fl.id
                  JOIN locations tl ON d.to_location = tl.id
                  JOIN users u ON d.handled_by = u.id
                  JOIN stock_requests sr ON d.request_id = sr.id
                  WHERE 1=1`;
    const params = [];
    let idx = 1;

    // Kepala cabang hanya bisa lihat pengiriman ke lokasinya
    if (req.user.role === 'kepala_cabang') {
      const locResult = await pool.query(
        'SELECT location_id FROM user_locations WHERE user_id = $1 LIMIT 1',
        [req.user.id]
      );
      if (locResult.rows.length > 0) {
        query += ` AND d.to_location = $${idx++}`;
        params.push(locResult.rows[0].location_id);
      }
    }

    if (status) {
      query += ` AND d.status = $${idx++}`;
      params.push(status);
    }

    query += ' ORDER BY d.created_at DESC';

    const result = await pool.query(query, params);
    return res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/deliveries/:id — detail pengiriman
router.get('/:id', authenticate, async (req, res) => {
  try {
    const deliveryResult = await pool.query(
      `SELECT d.*,
              fl.name AS from_location_name,
              tl.name AS to_location_name,
              tl.address AS to_location_address,
              tl.latitude AS to_latitude,
              tl.longitude AS to_longitude,
              u.name AS handled_by_name,
              sr.request_code
       FROM deliveries d
       JOIN locations fl ON d.from_location = fl.id
       JOIN locations tl ON d.to_location = tl.id
       JOIN users u ON d.handled_by = u.id
       JOIN stock_requests sr ON d.request_id = sr.id
       WHERE d.id = $1`,
      [req.params.id]
    );

    if (deliveryResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Pengiriman tidak ditemukan.' });
    }

    // Ambil items pengiriman
    const itemsResult = await pool.query(
      `SELECT sri.*, p.name AS product_name, p.code, p.unit, p.image_url
       FROM stock_request_items sri
       JOIN products p ON sri.product_id = p.id
       WHERE sri.request_id = $1`,
      [deliveryResult.rows[0].request_id]
    );

    // Ambil konfirmasi jika sudah received
    const confirmResult = await pool.query(
      `SELECT dc.*, u.name AS confirmed_by_name
       FROM delivery_confirmations dc
       JOIN users u ON dc.confirmed_by = u.id
       WHERE dc.delivery_id = $1`,
      [req.params.id]
    );

    return res.json({
      success: true,
      data: {
        ...deliveryResult.rows[0],
        items:        itemsResult.rows,
        confirmation: confirmResult.rows[0] || null,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/deliveries — buat pengiriman (admin)
router.post('/', authenticate, adminOnly, async (req, res) => {
  try {
    const { request_id, notes } = req.body;

    if (!request_id) {
      return res.status(400).json({ success: false, message: 'Request ID wajib diisi.' });
    }

    // Cek request sudah approved
    const requestResult = await pool.query(
      "SELECT * FROM stock_requests WHERE id = $1 AND status = 'approved'",
      [request_id]
    );

    if (requestResult.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Request tidak ditemukan atau belum disetujui.',
      });
    }

    const request = requestResult.rows[0];

    // Cek belum ada delivery untuk request ini
    const existingDelivery = await pool.query(
      'SELECT id FROM deliveries WHERE request_id = $1',
      [request_id]
    );

    if (existingDelivery.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Pengiriman untuk request ini sudah dibuat.',
      });
    }

    // Ambil lokasi gudang
    const gudang = await pool.query(
      "SELECT id FROM locations WHERE type = 'gudang' AND is_active = true LIMIT 1"
    );

    const deliveryCode = await generateDeliveryCode();

    const result = await pool.query(
      `INSERT INTO deliveries
         (delivery_code, request_id, from_location, to_location, handled_by, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [deliveryCode, request_id, gudang.rows[0].id,
       request.location_id, req.user.id, notes || null]
    );

    // Update status request
    await pool.query(
      "UPDATE stock_requests SET status = 'delivered', updated_at = NOW() WHERE id = $1",
      [request_id]
    );

    // Notifikasi ke kepala cabang
    await notify(
      request.requested_by,
      'Barang Sedang Dikirim',
      `Pengiriman (${deliveryCode}) untuk request Anda sedang dalam perjalanan.`,
      'delivery',
      result.rows[0].id,
      'deliveries'
    );

    return res.status(201).json({
      success: true,
      message: 'Pengiriman berhasil dibuat.',
      data: result.rows[0],
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/deliveries/:id/ship — update status shipped (admin)
router.put('/:id/ship', authenticate, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;

    const delivery = await pool.query(
      "SELECT * FROM deliveries WHERE id = $1 AND status = 'preparing'",
      [id]
    );

    if (delivery.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Pengiriman tidak ditemukan atau sudah dikirim.',
      });
    }

    await pool.query(
      `UPDATE deliveries SET status = 'shipped', shipped_at = NOW(),
       updated_at = NOW() WHERE id = $1`,
      [id]
    );

    // Notifikasi ke kepala cabang
    const request = await pool.query(
      'SELECT requested_by FROM stock_requests WHERE id = $1',
      [delivery.rows[0].request_id]
    );

    await notify(
      request.rows[0].requested_by,
      'Barang Dalam Perjalanan',
      `Pengiriman (${delivery.rows[0].delivery_code}) sudah dalam perjalanan menuju cabang Anda.`,
      'delivery',
      id,
      'deliveries'
    );

    return res.json({ success: true, message: 'Status pengiriman diperbarui ke "Dikirim".' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/deliveries/:id/confirm — konfirmasi terima (kepala cabang)
router.post('/:id/confirm', authenticate, upload.single('photo'), async (req, res) => {
  try {
    if (req.user.role !== 'kepala_cabang') {
      return res.status(403).json({
        success: false,
        message: 'Hanya kepala cabang yang dapat mengkonfirmasi penerimaan.',
      });
    }

    const { id }              = req.params;
    const { latitude, longitude, notes } = req.body;

    if (!latitude || !longitude) {
      return res.status(400).json({
        success: false,
        message: 'Koordinat GPS wajib diisi.',
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Foto bukti penerimaan wajib diupload.',
      });
    }

    const delivery = await pool.query(
      "SELECT * FROM deliveries WHERE id = $1 AND status = 'shipped'",
      [id]
    );

    if (delivery.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Pengiriman tidak ditemukan atau belum dikirim.',
      });
    }

    const photoUrl = `/uploads/${req.file.filename}`;

    // Simpan konfirmasi
    await pool.query(
      `INSERT INTO delivery_confirmations
         (delivery_id, confirmed_by, latitude, longitude, photo_url, notes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, req.user.id, latitude, longitude, photoUrl, notes || null]
    );

    // Update status delivery
    await pool.query(
      `UPDATE deliveries SET status = 'received', received_at = NOW(),
       updated_at = NOW() WHERE id = $1`,
      [id]
    );

    // Update status request
    await pool.query(
      `UPDATE stock_requests SET status = 'received', updated_at = NOW()
       WHERE id = $1`,
      [delivery.rows[0].request_id]
    );

    // Kurangi stok gudang & catat log
    const gudang = await pool.query(
      "SELECT id FROM locations WHERE type = 'gudang' LIMIT 1"
    );

    const items = await pool.query(
      'SELECT * FROM stock_request_items WHERE request_id = $1',
      [delivery.rows[0].request_id]
    );

    for (const item of items.rows) {
      const qty        = item.approved_qty || item.requested_qty;
      const stockCheck = await pool.query(
        'SELECT quantity FROM warehouse_stocks WHERE product_id = $1 AND location_id = $2',
        [item.product_id, gudang.rows[0].id]
      );

      if (stockCheck.rows.length > 0) {
        const before = stockCheck.rows[0].quantity;
        const after  = Math.max(0, before - qty);

        await pool.query(
          `UPDATE warehouse_stocks SET quantity = $1, updated_at = NOW()
           WHERE product_id = $2 AND location_id = $3`,
          [after, item.product_id, gudang.rows[0].id]
        );

        await pool.query(
          `INSERT INTO stock_logs
             (product_id, location_id, type, quantity, quantity_before, quantity_after,
              reference_id, notes, created_by)
           VALUES ($1, $2, 'out', $3, $4, $5, $6, $7, $8)`,
          [item.product_id, gudang.rows[0].id, qty, before, after,
           id, `Pengiriman ${delivery.rows[0].delivery_code}`, req.user.id]
        );
      }
    }

    // Notifikasi ke admin gudang
    const admins = await pool.query(
      "SELECT id FROM users WHERE role IN ('super_admin', 'admin_gudang') AND is_active = true"
    );

    for (const admin of admins.rows) {
      await notify(
        admin.id,
        'Barang Diterima',
        `Pengiriman (${delivery.rows[0].delivery_code}) telah dikonfirmasi diterima oleh cabang.`,
        'delivery',
        id,
        'deliveries'
      );
    }

    return res.json({
      success: true,
      message: 'Penerimaan barang berhasil dikonfirmasi.',
      data: { photo_url: photoUrl },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;