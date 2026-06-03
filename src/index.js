const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');
const path    = require('path');
require('dotenv').config();

// Init Firebase sebelum routes
require('./config/firebase');

const app = express();

// Middleware 
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files (uploads)
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// Routes ────
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/users',         require('./routes/user'));
app.use('/api/locations',     require('./routes/location'));
app.use('/api/products',      require('./routes/product'));
app.use('/api/stocks',        require('./routes/stock'));
app.use('/api/requests',      require('./routes/request'));
app.use('/api/deliveries',    require('./routes/delivery'));
app.use('/api/notifications', require('./routes/notification'));

// Health check 
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'GudangConnect API is running',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.originalUrl} tidak ditemukan.`,
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(500).json({
    success: false,
    message: err.message || 'Internal server error.',
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nGudangConnect API running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
  console.log(`http://localhost:${PORT}\n`);
});