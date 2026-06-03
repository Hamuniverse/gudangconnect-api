const jwt     = require('jsonwebtoken');
const pool    = require('../config/db');
require('dotenv').config();

// Middleware: authenticate JWT
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token      = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Token tidak ditemukan. Silakan login.',
      });
    }

    // Verifikasi JWT
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Cek token di database
    const tokenResult = await pool.query(
      'SELECT * FROM personal_access_tokens WHERE token = $1',
      [token]
    );

    if (tokenResult.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Token tidak valid atau sudah logout.',
      });
    }

    // Cek user masih aktif
    const userResult = await pool.query(
      'SELECT id, name, email, role, is_active FROM users WHERE id = $1',
      [decoded.id]
    );

    if (userResult.rows.length === 0 || !userResult.rows[0].is_active) {
      return res.status(403).json({
        success: false,
        message: 'Akun tidak aktif atau tidak ditemukan.',
      });
    }

    // Update last_used_at
    await pool.query(
      'UPDATE personal_access_tokens SET last_used_at = NOW() WHERE token = $1',
      [token]
    );

    req.user  = userResult.rows[0];
    req.token = token;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token sudah expired. Silakan login ulang.',
      });
    }
    return res.status(401).json({
      success: false,
      message: 'Token tidak valid.',
    });
  }
};

// Middleware: admin only (super_admin + admin_gudang)
const adminOnly = (req, res, next) => {
  if (!['super_admin', 'admin_gudang'].includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: 'Akses ditolak. Hanya admin yang diizinkan.',
    });
  }
  next();
};

// Middleware: super admin only
const superAdminOnly = (req, res, next) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({
      success: false,
      message: 'Akses ditolak. Hanya super admin yang diizinkan.',
    });
  }
  next();
};

module.exports = { authenticate, adminOnly, superAdminOnly };