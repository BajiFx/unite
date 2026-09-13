const cloudinary = require('cloudinary').v2;
const path = require('path');
const fs = require('fs');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

console.log('✅ Cloudinary configured');

// ============================================================
//  SECTION 2 FIX — video-safe upload
//
//  The previous version applied an image-only transformation
//  (width/height/crop + fetch_format:auto) to every upload,
//  including videos. Cloudinary rejected video uploads as a
//  result. The fix below detects the caller's resource_type
//  and applies a video-appropriate option set instead.
//
//  Callers already pass { resource_type: 'video' } for videos
//  (business-admin.js, ad-management.js), so no caller change
//  is needed.
// ============================================================

async function uploadToCloudinary(filePath, options = {}) {
  try {
    const isVideo = options.resource_type === 'video';

    const defaultOptions = isVideo
      ? {
          folder: 'business_shop',
          resource_type: 'video'
          // No image transformation for video.
          // Cloudinary's defaults for video are already sensible.
        }
      : {
          folder: 'business_shop',
          transformation: [
            { width: 1920, height: 600, crop: 'limit' },
            { quality: 'auto:good' },
            { fetch_format: 'auto' }
          ]
        };

    const mergedOptions = { ...defaultOptions, ...options };
    const result = await cloudinary.uploader.upload(filePath, mergedOptions);
    return result.secure_url;
  } catch (err) {
    console.error('❌ Cloudinary upload error:', err);
    const localPath = '/uploads/' + path.basename(filePath);
    console.log('⚠️ Using local fallback:', localPath);
    return localPath;
  }
}

function getHeroImage(row) {
  if (!row) return null;
  return row.heroImage || row.heroimage || null;
}

function getOptimizedImage(url, width = 500, height = 500) {
  if (!url || !url.includes('cloudinary')) return url;
  return url.replace('/upload/', `/upload/w_${width},h_${height},c_fill/`);
}

module.exports = { cloudinary, uploadToCloudinary, getHeroImage, getOptimizedImage };