const express  = require('express');
const pool     = require('../config/db');
const { authenticate, superAdminOnly } = require('../middleware/auth');

const router = express.Router();

// GET /api/locations — semua lokasi
router.get('/', authenticate, async (req, res) => {
  try {
    const { type } = req.query;

    let query  = `SELECT l.*,
                         u.name AS kepala_name,
                         u.email AS kepala_email
                  FROM locations l
                  LEFT JOIN user_locations ul ON l.id = ul.location_id
                  LEFT JOIN users u ON ul.user_id = u.id AND u.role = 'kepala_cabang'
                  WHERE l.is_active = true`;
    const params = [];

    if (type) {
      query += ' AND l.type = $1';
      params.push(type);
    }

    query += ' ORDER BY l.type, l.name';

    const result = await pool.query(query, params);
    return res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/locations/nearby — lokasi terdekat dari koordinat
router.get('/nearby', authenticate, async (req, res) => {
  try {
    const { lat, lng, radius = 50, type } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({
        success: false,
        message: 'Latitude dan longitude wajib diisi.',
      });
    }

    const latitude  = parseFloat(lat);
    const longitude = parseFloat(lng);
    const radiusKm  = parseFloat(radius);

    // Haversine Formula untuk hitung jarak antar koordinat
    let query = `
      SELECT l.*,
             u.name AS kepala_name,
             (
               6371 * acos(
                 cos(radians($1)) * cos(radians(l.latitude)) *
                 cos(radians(l.longitude) - radians($2)) +
                 sin(radians($1)) * sin(radians(l.latitude))
               )
             ) AS distance_km
      FROM locations l
      LEFT JOIN user_locations ul ON l.id = ul.location_id
      LEFT JOIN users u ON ul.user_id = u.id AND u.role = 'kepala_cabang'
      WHERE l.is_active = true
        AND (
          6371 * acos(
            cos(radians($1)) * cos(radians(l.latitude)) *
            cos(radians(l.longitude) - radians($2)) +
            sin(radians($1)) * sin(radians(l.latitude))
          )
        ) <= $3`;

    const params = [latitude, longitude, radiusKm];
    let idx = 4;

    if (type) {
      query += ` AND l.type = $${idx++}`;
      params.push(type);
    }

    query += ' ORDER BY distance_km ASC';

    const result = await pool.query(query, params);
    return res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/locations/:id — detail lokasi
router.get('/:id', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.*,
              u.name AS kepala_name,
              u.email AS kepala_email
       FROM locations l
       LEFT JOIN user_locations ul ON l.id = ul.location_id
       LEFT JOIN users u ON ul.user_id = u.id AND u.role = 'kepala_cabang'
       WHERE l.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Lokasi tidak ditemukan.' });
    }

    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/locations — tambah lokasi (super admin only)

router.post('/', authenticate, superAdminOnly, async (req, res) => {
  try {
    const { name, type, address, latitude, longitude, phone } = req.body;

    if (!name || !type || !latitude || !longitude) {
      return res.status(400).json({
        success: false,
        message: 'Nama, tipe, latitude, dan longitude wajib diisi.',
      });
    }

    // Hanya boleh ada 1 gudang
    if (type === 'gudang') {
      const existing = await pool.query(
        "SELECT id FROM locations WHERE type = 'gudang' AND is_active = true"
      );
      if (existing.rows.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Gudang pusat sudah ada. Hanya boleh 1 gudang pusat.',
        });
      }
    }

    const result = await pool.query(
      `INSERT INTO locations (name, type, address, latitude, longitude, phone)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, type, address || null, latitude, longitude, phone || null]
    );

    return res.status(201).json({
      success: true,
      message: 'Lokasi berhasil ditambahkan.',
      data: result.rows[0],
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/locations/:id — edit lokasi (super admin only)
router.put('/:id', authenticate, superAdminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, address, latitude, longitude, phone } = req.body;

    const existing = await pool.query('SELECT id FROM locations WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Lokasi tidak ditemukan.' });
    }

    await pool.query(
      `UPDATE locations SET
        name       = COALESCE($1, name),
        address    = COALESCE($2, address),
        latitude   = COALESCE($3, latitude),
        longitude  = COALESCE($4, longitude),
        phone      = COALESCE($5, phone),
        updated_at = NOW()
       WHERE id = $6`,
      [name || null, address || null, latitude || null, longitude || null, phone || null, id]
    );

    const updated = await pool.query('SELECT * FROM locations WHERE id = $1', [id]);
    return res.json({
      success: true,
      message: 'Lokasi berhasil diperbarui.',
      data: updated.rows[0],
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/locations/:id — nonaktifkan lokasi (super admin only)
router.delete('/:id', authenticate, superAdminOnly, async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await pool.query(
      'SELECT id, type FROM locations WHERE id = $1 AND is_active = true',
      [id]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Lokasi tidak ditemukan.' });
    }

    if (existing.rows[0].type === 'gudang') {
      return res.status(400).json({
        success: false,
        message: 'Gudang pusat tidak dapat dinonaktifkan.',
      });
    }

    await pool.query(
      'UPDATE locations SET is_active = false, updated_at = NOW() WHERE id = $1',
      [id]
    );

    return res.json({ success: true, message: 'Lokasi berhasil dinonaktifkan.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;