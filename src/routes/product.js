const express  = require('express');
const pool     = require('../config/db');
const upload   = require('../middleware/upload');
const { authenticate, adminOnly } = require('../middleware/auth');

const router = express.Router();

// CATEGORY ROUTES

// GET /api/products/categories
router.get('/categories', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM categories WHERE is_active = true ORDER BY name'
    );
    return res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/products/categories
router.post('/categories', authenticate, adminOnly, async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, message: 'Nama kategori wajib diisi.' });
    }

    const result = await pool.query(
      'INSERT INTO categories (name, description) VALUES ($1, $2) RETURNING *',
      [name, description || null]
    );

    return res.status(201).json({
      success: true,
      message: 'Kategori berhasil ditambahkan.',
      data: result.rows[0],
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/products/categories/:id
router.put('/categories/:id', authenticate, adminOnly, async (req, res) => {
  try {
    const { name, description } = req.body;
    await pool.query(
      `UPDATE categories SET name = COALESCE($1, name),
       description = COALESCE($2, description) WHERE id = $3`,
      [name || null, description || null, req.params.id]
    );
    const updated = await pool.query('SELECT * FROM categories WHERE id = $1', [req.params.id]);
    return res.json({ success: true, message: 'Kategori berhasil diperbarui.', data: updated.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// PRODUCT ROUTES

// GET /api/products
router.get('/', authenticate, async (req, res) => {
  try {
    const { category_id, search } = req.query;

    let query  = `SELECT p.*, c.name AS category_name,
                         ws.quantity AS stock_quantity,
                         ws.min_stock
                  FROM products p
                  JOIN categories c ON p.category_id = c.id
                  LEFT JOIN warehouse_stocks ws ON p.id = ws.product_id
                  LEFT JOIN locations l ON ws.location_id = l.id AND l.type = 'gudang'
                  WHERE p.is_active = true`;
    const params = [];
    let idx = 1;

    if (category_id) {
      query += ` AND p.category_id = $${idx++}`;
      params.push(category_id);
    }
    if (search) {
      query += ` AND (p.name ILIKE $${idx} OR p.code ILIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }

    query += ' ORDER BY c.name, p.name';

    const result = await pool.query(query, params);
    return res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/products/:id
router.get('/:id', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, c.name AS category_name,
              ws.quantity AS stock_quantity, ws.min_stock
       FROM products p
       JOIN categories c ON p.category_id = c.id
       LEFT JOIN warehouse_stocks ws ON p.id = ws.product_id
       WHERE p.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Produk tidak ditemukan.' });
    }

    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/products
router.post('/', authenticate, adminOnly, upload.single('image'), async (req, res) => {
  try {
    const { category_id, name, code, unit, description } = req.body;

    if (!category_id || !name || !code || !unit) {
      return res.status(400).json({
        success: false,
        message: 'Kategori, nama, kode, dan satuan wajib diisi.',
      });
    }

    const existing = await pool.query('SELECT id FROM products WHERE code = $1', [code]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'Kode produk sudah digunakan.' });
    }

    const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;

    const result = await pool.query(
      `INSERT INTO products (category_id, name, code, unit, description, image_url)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [category_id, name, code, unit, description || null, imageUrl]
    );

    const newProduct = result.rows[0];

    const gudang = await pool.query(
      "SELECT id FROM locations WHERE type = 'gudang' AND is_active = true LIMIT 1"
    );
    if (gudang.rows.length > 0) {
      await pool.query(
        `INSERT INTO warehouse_stocks (product_id, location_id, quantity, min_stock, updated_by)
         VALUES ($1, $2, 0, 0, $3)
         ON CONFLICT (product_id, location_id) DO NOTHING`,
        [newProduct.id, gudang.rows[0].id, req.user.id]
      );
    }

    return res.status(201).json({
      success: true,
      message: 'Produk berhasil ditambahkan.',
      data: newProduct,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/products/:id
router.put('/:id', authenticate, adminOnly, upload.single('image'), async (req, res) => {
  try {
    const { category_id, name, code, unit, description } = req.body;
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;

    await pool.query(
      `UPDATE products SET
        category_id = COALESCE($1, category_id),
        name        = COALESCE($2, name),
        code        = COALESCE($3, code),
        unit        = COALESCE($4, unit),
        description = COALESCE($5, description),
        image_url   = COALESCE($6, image_url),
        updated_at  = NOW()
       WHERE id = $7`,
      [category_id || null, name || null, code || null,
       unit || null, description || null, imageUrl, req.params.id]
    );

    const updated = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    return res.json({
      success: true,
      message: 'Produk berhasil diperbarui.',
      data: updated.rows[0],
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/products/:id
router.delete('/:id', authenticate, adminOnly, async (req, res) => {
  try {
    await pool.query(
      'UPDATE products SET is_active = false, updated_at = NOW() WHERE id = $1',
      [req.params.id]
    );
    return res.json({ success: true, message: 'Produk berhasil dinonaktifkan.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;