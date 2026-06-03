const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
require('dotenv').config();

const uploadPath = process.env.UPLOAD_PATH || './uploads';

// Buat folder uploads jika belum ada
if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    // Ambil ekstensi dari mimetype jika tidak ada di filename
    let ext = path.extname(file.originalname).toLowerCase();
    if (!ext || ext === '.') {
      const mimeToExt = {
        'image/jpeg': '.jpg',
        'image/jpg':  '.jpg',
        'image/png':  '.png',
        'image/webp': '.webp',
        'image/heic': '.heic',
        'image/heif': '.heif',
      };
      ext = mimeToExt[file.mimetype] || '.jpg';
    }
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, uniqueName);
  },
});

const fileFilter = (req, file, cb) => {
  const allowedMimes = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
  ];

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    // Fallback: jika dari field photo/image, izinkan saja
    // karena kamera Android kadang kirim mimetype tidak standar
    if (file.fieldname === 'photo' || file.fieldname === 'image') {
      cb(null, true);
    } else {
      cb(new Error('Hanya file gambar yang diizinkan (jpeg, jpg, png, webp)'));
    }
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024,
  },
});

module.exports = upload;