const express    = require('express');
const bcrypt     = require('bcryptjs');
const pool       = require('../config/db');
const { authenticate, superAdminOnly, adminOnly } = require('../middleware/auth');

const router = express.Router();

// GET /api/users — semua user (super admin only)
router.get('/', authenticate, superAdminOnly, async (req, res) => {
  try {
    const { role, is_active } = req.query;

    let query  = `SELECT u.id, u.name, u.email, u.role, u.avatar_url,
                         u.is_active, u.created_at,
                         l.name AS location_name
                  FROM users u
                  LEFT JOIN user_locations ul ON u.id = ul.user_id
                  LEFT JOIN locations l ON ul.location_id = l.id
                  WHERE 1=1`;
    const params = [];
    let idx = 1;

    if (role) {
      query += ` AND u.role = $${idx++}`;
      params.push(role);
    }
    if (is_active !== undefined) {
      query += ` AND u.is_active = $${idx++}`;
      params.push(is_active === 'true');
    }

    query += ' ORDER BY u.created_at DESC';

    const result = await pool.query(query, params);
    return res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/users — tambah user baru (super admin only)
router.post('/', authenticate, superAdminOnly, async (req, res) => {
  try {
    const { name, email, password, role, location_id } = req.body;

    if (!name || !email || !password || !role) {
      return res.status(400).json({
        success: false,
        message: 'Nama, email, password, dan role wajib diisi.',
      });
    }

    const validRoles = ['super_admin', 'admin_gudang', 'kepala_cabang'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({
        success: false,
        message: 'Role tidak valid.',
      });
    }

    // Cek email duplikat
    const existing = await pool.query(
      'SELECT id, is_active FROM users WHERE email = $1',
      [email]
    );

    if (existing.rows.length > 0) {
      if (existing.rows[0].is_active) {
        return res.status(400).json({
          success: false,
          message: 'Email sudah digunakan.',
        });
      } else {
        // Aktifkan kembali user yang sudah dinonaktifkan
        const hashed = await bcrypt.hash(password, 10);
        const result = await pool.query(
          `UPDATE users SET name=$1, password=$2, role=$3,
           is_active=true, updated_at=NOW()
           WHERE id=$4 RETURNING id, name, email, role, is_active`,
          [name, hashed, role, existing.rows[0].id]
        );

        if (role === 'kepala_cabang' && location_id) {
          await pool.query(
            `INSERT INTO user_locations (user_id, location_id)
             VALUES ($1, $2) ON CONFLICT (user_id, location_id) DO NOTHING`,
            [result.rows[0].id, location_id]
          );
        }

        return res.status(201).json({
          success: true,
          message: 'User berhasil ditambahkan.',
          data: result.rows[0],
        });
      }
    }

    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (name, email, password, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, role, is_active`,
      [name, email, hashed, role]
    );

    const newUser = result.rows[0];

    // Assign lokasi jika kepala cabang
    if (role === 'kepala_cabang' && location_id) {
      await pool.query(
        `INSERT INTO user_locations (user_id, location_id) VALUES ($1, $2)`,
        [newUser.id, location_id]
      );
    }

    return res.status(201).json({
      success: true,
      message: 'User berhasil ditambahkan.',
      data: newUser,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/users/:id — edit user (super admin only)
router.put('/:id', authenticate, superAdminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, password, role, is_active, location_id } = req.body;

    const existing = await pool.query('SELECT id FROM users WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User tidak ditemukan.' });
    }

    // Cek email duplikat jika diubah
    if (email) {
      const emailCheck = await pool.query(
        'SELECT id FROM users WHERE email = $1 AND id != $2',
        [email, id]
      );
      if (emailCheck.rows.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Email sudah digunakan oleh user lain.',
        });
      }
    }

    let hashedPassword = null;
    if (password) hashedPassword = await bcrypt.hash(password, 10);

    await pool.query(
      `UPDATE users SET
        name       = COALESCE($1, name),
        email      = COALESCE($2, email),
        password   = COALESCE($3, password),
        role       = COALESCE($4, role),
        is_active  = COALESCE($5, is_active),
        updated_at = NOW()
       WHERE id = $6`,
      [name || null, email || null, hashedPassword, role || null, is_active ?? null, id]
    );

    // Update lokasi jika kepala cabang
    if (location_id) {
      await pool.query('DELETE FROM user_locations WHERE user_id = $1', [id]);
      await pool.query(
        'INSERT INTO user_locations (user_id, location_id) VALUES ($1, $2)',
        [id, location_id]
      );
    }

    // Jika dinonaktifkan, hapus semua sesi login
    if (is_active === false) {
      await pool.query(
        'DELETE FROM personal_access_tokens WHERE user_id = $1',
        [id]
      );
    }

    const updated = await pool.query(
      'SELECT id, name, email, role, is_active FROM users WHERE id = $1',
      [id]
    );

    return res.json({
      success: true,
      message: 'User berhasil diperbarui.',
      data: updated.rows[0],
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/users/:id — nonaktifkan user (super admin only)
router.delete('/:id', authenticate, superAdminOnly, async (req, res) => {
  try {
    const { id } = req.params;

    // Tidak boleh hapus diri sendiri
    if (id === req.user.id) {
      return res.status(400).json({
        success: false,
        message: 'Tidak dapat menonaktifkan akun sendiri.',
      });
    }

    const existing = await pool.query(
      'SELECT id FROM users WHERE id = $1 AND is_active = true',
      [id]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User tidak ditemukan atau sudah dinonaktifkan.',
      });
    }

    await pool.query(
      'UPDATE users SET is_active = false, updated_at = NOW() WHERE id = $1',
      [id]
    );

    await pool.query(
      'DELETE FROM personal_access_tokens WHERE user_id = $1',
      [id]
    );

    return res.json({ success: true, message: 'User berhasil dinonaktifkan.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;