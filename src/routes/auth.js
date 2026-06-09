const express         = require('express');
const bcrypt          = require('bcryptjs');
const jwt             = require('jsonwebtoken');
const nodemailer      = require('nodemailer');
const { OAuth2Client } = require('google-auth-library');
const pool            = require('../config/db');
const { authenticate } = require('../middleware/auth');
require('dotenv').config();

const router = express.Router();

// Google OAuth Client
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID_WEB);

// Nodemailer transporter
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASSWORD,
  },
});

// Helper: generate JWT + simpan ke DB
const generateToken = async (user, deviceInfo = null, fcmToken = null) => {
  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
  );

  // Hapus token lama dari device yang sama jika ada
  await pool.query('DELETE FROM personal_access_tokens WHERE user_id = $1', [user.id]);

  // Simpan token baru
  await pool.query(
    `INSERT INTO personal_access_tokens (user_id, token, device_info, fcm_token)
     VALUES ($1, $2, $3, $4)`,
    [user.id, token, deviceInfo || null, fcmToken || null]
  );

  return token;
};

// POST /api/auth/login

router.post('/login', async (req, res) => {
  try {
    const { email, password, fcm_token, device_info } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email dan password wajib diisi.',
      });
    }

    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Email atau password salah.',
      });
    }

    const user = result.rows[0];

    // Cek apakah user login via Google (tidak punya password)
    if (!user.password) {
      return res.status(401).json({
        success: false,
        message: 'Akun ini terdaftar via Google. Gunakan login Google.',
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Email atau password salah.',
      });
    }

    if (!user.is_active) {
      return res.status(403).json({
        success: false,
        message: 'Akun Anda telah dinonaktifkan. Hubungi admin.',
      });
    }

    const token = await generateToken(user, device_info, fcm_token);

    // Ambil lokasi user jika kepala cabang
    let location = null;
    if (user.role === 'kepala_cabang') {
      const locResult = await pool.query(
        `SELECT l.* FROM locations l
         JOIN user_locations ul ON l.id = ul.location_id
         WHERE ul.user_id = $1 LIMIT 1`,
        [user.id]
      );
      if (locResult.rows.length > 0) location = locResult.rows[0];
    }

    return res.json({
      success: true,
      message: 'Login berhasil.',
      data: {
        token,
        user: {
          id:        user.id,
          name:      user.name,
          email:     user.email,
          role:      user.role,
          avatar_url: user.avatar_url,
          is_active: user.is_active,
        },
        location,
      },
    });
  } catch (err) {
    console.error('Login error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/auth/biometric-login
router.post('/biometric-login', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({
        success: false,
        message: 'Token tidak ditemukan.',
      });
    }

    // Verifikasi JWT saja (tidak cek di database)
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Cek user masih aktif
    const userResult = await pool.query(
      'SELECT id, name, email, role, is_active, avatar_url FROM users WHERE id = $1',
      [decoded.id]
    );

    if (userResult.rows.length === 0 || !userResult.rows[0].is_active) {
      return res.status(403).json({
        success: false,
        message: 'Akun tidak aktif atau tidak ditemukan.',
      });
    }

    const user = userResult.rows[0];

    // Generate token baru + simpan ke DB
    const newToken = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
    );

    await pool.query(
      'DELETE FROM personal_access_tokens WHERE user_id = $1',
      [user.id]
    );
    await pool.query(
      'INSERT INTO personal_access_tokens (user_id, token) VALUES ($1, $2)',
      [user.id, newToken]
    );

    // Ambil lokasi jika kepala cabang
    let location = null;
    if (user.role === 'kepala_cabang') {
      const locResult = await pool.query(
        `SELECT l.* FROM locations l
         JOIN user_locations ul ON l.id = ul.location_id
         WHERE ul.user_id = $1 LIMIT 1`,
        [user.id]
      );
      if (locResult.rows.length > 0) location = locResult.rows[0];
    }

    return res.json({
      success: true,
      message: 'Biometric login berhasil.',
      data: {
        token: newToken,
        user: {
          id:         user.id,
          name:       user.name,
          email:      user.email,
          role:       user.role,
          avatar_url: user.avatar_url,
          is_active:  user.is_active,
        },
        location,
      },
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Sesi telah berakhir. Silakan login ulang dengan password.',
      });
    }
    return res.status(401).json({
      success: false,
      message: 'Token tidak valid.',
    });
  }
});

// POST /api/auth/google

router.post('/google', async (req, res) => {
  try {
    const { id_token, fcm_token, device_info } = req.body;

    if (!id_token) {
      return res.status(400).json({
        success: false,
        message: 'Google ID token wajib diisi.',
      });
    }

    // Verifikasi Google token
    const ticket = await googleClient.verifyIdToken({
      idToken:  id_token,
      audience: [
        process.env.GOOGLE_CLIENT_ID_WEB,
        process.env.GOOGLE_CLIENT_ID_ANDROID,
      ],
    });

    const payload   = ticket.getPayload();
    const googleId  = payload['sub'];
    const email     = payload['email'];
    const name      = payload['name'];
    const avatarUrl = payload['picture'];

    // Cek apakah user sudah terdaftar
    let userResult = await pool.query(
      'SELECT * FROM users WHERE email = $1 OR google_id = $2',
      [email, googleId]
    );

    if (userResult.rows.length === 0) {
      // User belum terdaftar — tolak, harus dibuat oleh admin dulu
      return res.status(403).json({
        success: false,
        message: 'Akun tidak ditemukan. Hubungi admin untuk mendaftarkan akun Anda.',
      });
    }

    const user = userResult.rows[0];

    if (!user.is_active) {
      return res.status(403).json({
        success: false,
        message: 'Akun Anda telah dinonaktifkan. Hubungi admin.',
      });
    }

    // Update google_id dan avatar jika belum ada
    if (!user.google_id) {
      await pool.query(
        'UPDATE users SET google_id = $1, avatar_url = $2, updated_at = NOW() WHERE id = $3',
        [googleId, avatarUrl, user.id]
      );
    }

    const token = await generateToken(user, device_info, fcm_token);

    // Ambil lokasi jika kepala cabang
    let location = null;
    if (user.role === 'kepala_cabang') {
      const locResult = await pool.query(
        `SELECT l.* FROM locations l
         JOIN user_locations ul ON l.id = ul.location_id
         WHERE ul.user_id = $1 LIMIT 1`,
        [user.id]
      );
      if (locResult.rows.length > 0) location = locResult.rows[0];
    }

    return res.json({
      success: true,
      message: 'Login dengan Google berhasil.',
      data: {
        token,
        user: {
          id:         user.id,
          name:       user.name,
          email:      user.email,
          role:       user.role,
          avatar_url: avatarUrl || user.avatar_url,
          is_active:  user.is_active,
        },
        location,
      },
    });
  } catch (err) {
    console.error('Google login error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/auth/logout

router.post('/logout', authenticate, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM personal_access_tokens WHERE token = $1',
      [req.token]
    );

    return res.json({ success: true, message: 'Logout berhasil.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/auth/profile
router.get('/profile', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, role, avatar_url, is_active, created_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    // Ambil lokasi jika kepala cabang
    let location = null;
    if (req.user.role === 'kepala_cabang') {
      const locResult = await pool.query(
        `SELECT l.* FROM locations l
         JOIN user_locations ul ON l.id = ul.location_id
         WHERE ul.user_id = $1 LIMIT 1`,
        [req.user.id]
      );
      if (locResult.rows.length > 0) location = locResult.rows[0];
    }

    return res.json({
      success: true,
      data: { ...result.rows[0], location },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/auth/profile
router.put('/profile', authenticate, async (req, res) => {
  try {
    const { name, email, password } = req.body;

    let newPassword = null;
    if (password) newPassword = await bcrypt.hash(password, 10);

    await pool.query(
      `UPDATE users SET
        name       = COALESCE($1, name),
        email      = COALESCE($2, email),
        password   = COALESCE($3, password),
        updated_at = NOW()
       WHERE id = $4`,
      [name || null, email || null, newPassword, req.user.id]
    );

    const updated = await pool.query(
      'SELECT id, name, email, role, avatar_url, is_active FROM users WHERE id = $1',
      [req.user.id]
    );

    return res.json({
      success: true,
      message: 'Profil berhasil diperbarui.',
      data: updated.rows[0],
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/auth/fcm-token
router.put('/fcm-token', authenticate, async (req, res) => {
  try {
    const { fcm_token } = req.body;

    if (!fcm_token) {
      return res.status(400).json({
        success: false,
        message: 'FCM token wajib diisi.',
      });
    }

    await pool.query(
      'UPDATE personal_access_tokens SET fcm_token = $1 WHERE token = $2',
      [fcm_token, req.token]
    );

    return res.json({ success: true, message: 'FCM token berhasil diperbarui.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1 AND is_active = true',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Email tidak ditemukan atau akun tidak aktif.',
      });
    }

    const user = result.rows[0];

    // Hapus OTP lama
    await pool.query('DELETE FROM password_reset_tokens WHERE email = $1', [email]);

    // Generate OTP 6 digit
    const otp    = Math.floor(100000 + Math.random() * 900000).toString();
    const hashed = await bcrypt.hash(otp, 10);

    await pool.query(
      `INSERT INTO password_reset_tokens (email, token, created_at, expires_at)
       VALUES ($1, $2, NOW() AT TIME ZONE 'UTC',
               (NOW() AT TIME ZONE 'UTC') + INTERVAL '10 minutes')`,
      [email, hashed]
    );

    await transporter.sendMail({
      from:    process.env.MAIL_FROM,
      to:      email,
      subject: 'Kode Reset Password - GudangConnect',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.1)">
          <div style="background:#0xFF234F52;padding:30px;text-align:center">
            <h1 style="color:#fff;margin:0;font-size:24px">GudangConnect</h1>
            <p style="color:#ffffff99;margin:8px 0 0 0;font-size:14px">Sistem Manajemen Distribusi Gudang</p>
          </div>
          <div style="padding:32px">
            <p style="color:#333;font-size:15px">Halo, <strong>${user.name}</strong>!</p>
            <p style="color:#333;font-size:15px">Gunakan kode OTP berikut untuk mereset password:</p>
            <div style="background:#e3f2fd;border:2px dashed #0xFF234F52;border-radius:12px;padding:24px;text-align:center;margin:24px 0">
              <p style="color:#666;font-size:13px;margin:0 0 8px 0">Kode OTP Reset Password</p>
              <p style="color:#0xFF234F52;font-size:40px;font-weight:bold;letter-spacing:8px;margin:0">${otp}</p>
              <p style="color:#999;font-size:12px;margin:8px 0 0 0">Berlaku selama 10 menit</p>
            </div>
            <p style="color:#333;font-size:14px">Jika Anda tidak meminta reset password, abaikan email ini.</p>
          </div>
          <div style="background:#f5f5f5;padding:20px;text-align:center">
            <p style="color:#999;font-size:12px;margin:0">© 2025 GudangConnect</p>
          </div>
        </div>
      `,
    });

    return res.json({
      success: true,
      message: 'Kode OTP telah dikirim ke email Anda. Berlaku selama 10 menit.',
    });
  } catch (err) {
    console.error('Forgot password error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { email, otp, password, password_confirmation } = req.body;

    if (!email || !otp || !password || !password_confirmation) {
      return res.status(400).json({
        success: false,
        message: 'Semua field wajib diisi.',
      });
    }

    if (password !== password_confirmation) {
      return res.status(400).json({
        success: false,
        message: 'Konfirmasi password tidak cocok.',
      });
    }

    // Cek token yang masih berlaku
    const result = await pool.query(
      `SELECT * FROM password_reset_tokens
       WHERE email = $1 AND expires_at > NOW() AT TIME ZONE 'UTC'`,
      [email]
    );

    if (result.rows.length === 0) {
      await pool.query('DELETE FROM password_reset_tokens WHERE email = $1', [email]);
      return res.status(400).json({
        success: false,
        message: 'Kode OTP tidak valid atau sudah expired. Silakan minta kode baru.',
      });
    }

    const isMatch = await bcrypt.compare(otp, result.rows[0].token);
    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: 'Kode OTP salah.',
      });
    }

    // Update password
    const hashed = await bcrypt.hash(password, 10);
    await pool.query(
      'UPDATE users SET password = $1, updated_at = NOW() WHERE email = $2',
      [hashed, email]
    );

    // Hapus OTP dan semua sesi login
    await pool.query('DELETE FROM password_reset_tokens WHERE email = $1', [email]);
    const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (userResult.rows.length > 0) {
      await pool.query(
        'DELETE FROM personal_access_tokens WHERE user_id = $1',
        [userResult.rows[0].id]
      );
    }

    return res.json({
      success: true,
      message: 'Password berhasil direset. Silakan login dengan password baru.',
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;