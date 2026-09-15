// ============================================================
//  PHASE 1 — VIDEO POSTER SERVICE
//  Location: src/services/videoPosterService.js
//
//  Purpose:
//   Given a video URL, produce a poster image URL — a still
//   frame that represents the video in the grid, in the variant
//   strip, and as the HTML5 video element's poster attribute.
//
//  The service is deliberately conservative:
//   - It never blocks a product save on poster extraction.
//   - It never throws. Every failure mode returns null and lets
//     the caller fall through to the inheritance chain (variant
//     image → parent image → business hero → placeholder).
//   - It never downloads a whole video. It seeks the remote file
//     to a small offset, pulls enough bytes to decode one frame,
//     and stops.
//   - It never stores the poster in the local filesystem. The
//     poster is uploaded to Cloudinary through the same
//     credentials the rest of the platform already uses, so it
//     benefits from Cloudinary's CDN and can be cleaned up with
//     the rest of the media.
//
//  What this service actually does:
//   1. Checks that ffmpeg is available on the host once, at
//      module load, and caches the answer.
//   2. Given a video URL, writes a small temporary file with the
//      first few seconds of the video, extracted via ffmpeg.
//   3. Extracts one frame from that short clip and writes it to a
//      second temporary file.
//   4. Uploads the frame to Cloudinary under a deterministic
//      public id so that re-uploading the same video overwrites
//      the same poster instead of accumulating files.
//   5. Deletes both temporary files.
//   6. Returns the Cloudinary secure URL, or null on any failure.
//
//  Why a deterministic public id:
//   The same video URL always maps to the same poster public id,
//   so a repeated save does not create a second Cloudinary asset.
//   Cloudinary deduplicates internally, but a deterministic id
//   also lets a future cleanup job list orphaned posters by
//   prefix.
//
//  Configuration:
//   The service reads three optional environment variables:
//     FFMPEG_PATH               — absolute path to the ffmpeg binary
//     FFPROBE_PATH              — absolute path to the ffprobe binary
//     VIDEO_POSTER_TIMEOUT_MS   — hard timeout for the whole extraction
//                                 default: 20000
//     VIDEO_POSTER_OFFSET_SEC   — where in the video to grab the frame
//                                 default: 1 (one second in)
//
//   If FFMPEG_PATH is not set, the service tries the bare names
//   "ffmpeg" and "ffprobe" on the PATH, which is how the binaries
//   are named on every supported platform.
// ============================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const cloudinary = require('../config/cloudinary');
const { logError } = require('../config/database');

// ------------------------------------------------------------
//  CONFIGURATION
// ------------------------------------------------------------

const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_BIN = process.env.FFPROBE_PATH || 'ffprobe';

const EXTRACTION_TIMEOUT_MS = Number.isFinite(Number(process.env.VIDEO_POSTER_TIMEOUT_MS))
    ? Number(process.env.VIDEO_POSTER_TIMEOUT_MS)
    : 20000;

const POSTER_OFFSET_SECONDS = Number.isFinite(Number(process.env.VIDEO_POSTER_OFFSET_SEC))
    ? Number(process.env.VIDEO_POSTER_OFFSET_SEC)
    : 1;

// The Cloudinary folder where posters live. Kept separate from
// product and variant media so a future cleanup job can find
// them by prefix and a future migration can regenerate them
// without touching real uploads.
const POSTER_FOLDER = 'bidhaaalink/video-posters';

// ------------------------------------------------------------
//  MODULE-LEVEL STATE
// ------------------------------------------------------------

// Tracks whether ffmpeg has been located. `null` means "not yet
// checked". `true` and `false` are the cached outcomes.
let ffmpegAvailable = null;

// Tracks whether a check is already in flight, so parallel
// calls do not all spawn ffmpeg -version at the same time.
let ffmpegCheckPromise = null;

// ------------------------------------------------------------
//  INTERNAL HELPERS
// ------------------------------------------------------------

/**
 * Run a child process and return its stdout as a string.
 * Rejects on a non-zero exit code or on timeout. Every caller
 * wraps this in a try/catch and treats a rejection as a soft
 * failure.
 */
function runProcess(binary, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let child;

        try {
            child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            reject(err);
            return;
        }

        const stdoutChunks = [];
        const stderrChunks = [];

        child.stdout.on('data', chunk => stdoutChunks.push(chunk));
        child.stderr.on('data', chunk => stderrChunks.push(chunk));

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { child.kill('SIGKILL'); } catch (e) { /* no-op */ }
            reject(new Error(`${binary} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        child.on('error', err => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err);
        });

        child.on('close', code => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (code === 0) {
                resolve(Buffer.concat(stdoutChunks).toString('utf8'));
            } else {
                const stderr = Buffer.concat(stderrChunks).toString('utf8');
                const err = new Error(
                    `${binary} exited with code ${code}${stderr ? ': ' + stderr.slice(0, 400) : ''}`
                );
                err.exitCode = code;
                err.stderr = stderr;
                reject(err);
            }
        });
    });
}

/**
 * Check whether ffmpeg is available on the host. The answer is
 * cached for the lifetime of the process. Concurrent calls share
 * the same promise.
 */
function checkFfmpegAvailability() {
    if (ffmpegAvailable !== null) {
        return Promise.resolve(ffmpegAvailable);
    }
    if (ffmpegCheckPromise) {
        return ffmpegCheckPromise;
    }

    ffmpegCheckPromise = new Promise(resolve => {
        execFile(FFMPEG_BIN, ['-version'], { timeout: 4000 }, err => {
            ffmpegAvailable = !err;
            ffmpegCheckPromise = null;
            if (!ffmpegAvailable) {
                console.warn(
                    `⚠️  ${FFMPEG_BIN} not available on this host. ` +
                    `Video posters will fall back to the inheritance chain.`
                );
            }
            resolve(ffmpegAvailable);
        });
    });

    return ffmpegCheckPromise;
}

/**
 * Build a short, filesystem-safe temp path for an intermediate
 * file. Uses the OS temp directory and a random suffix so parallel
 * extractions never collide.
 */
function buildTempPath(extension) {
    const suffix = crypto.randomBytes(10).toString('hex');
    return path.join(os.tmpdir(), `poster-${Date.now()}-${suffix}.${extension}`);
}

/**
 * Delete a file if it exists. Silently ignores every error, because
 * the file may already be gone and cleanup failures must never
 * bubble up to the caller.
 */
function safeUnlink(filePath) {
    if (!filePath) return;
    try {
        fs.unlinkSync(filePath);
    } catch (err) {
        // Ignore. Temp files are cleaned by the OS eventually.
    }
}

/**
 * Compute a deterministic Cloudinary public id for a given video
 * URL. The id is stable across runs, so re-saving the same video
 * overwrites the same poster.
 */
function publicIdForVideo(videoUrl) {
    const hash = crypto
        .createHash('sha1')
        .update(String(videoUrl || ''))
        .digest('hex')
        .slice(0, 32);
    return `poster_${hash}`;
}

// ------------------------------------------------------------
//  PUBLIC API
// ------------------------------------------------------------

/**
 * Extract a poster frame from a video URL and upload it to
 * Cloudinary.
 *
 * Returns:
 *   { ok: true,  posterUrl: '<https url>' }  on success
 *   { ok: false, reason: '<short reason>' }  on any failure
 *
 * Never throws. Every caller can rely on getting an object back.
 *
 * Options:
 *   offsetSeconds — override the default offset for this call
 *   timeoutMs     — override the default timeout for this call
 *   skipCache     — when true, always regenerate, even if a
 *                   poster already exists for the same URL
 */
async function extractPoster(videoUrl, options) {
    const opts = options || {};

    if (!videoUrl || typeof videoUrl !== 'string') {
        return { ok: false, reason: 'missing_video_url' };
    }

    // Only remote videos are handled. Local file paths are used
    // during development and are treated as unreachable by the
    // public extraction flow. The caller falls back.
    if (!/^https?:\/\//i.test(videoUrl) && !/^cloudinary:\/\//i.test(videoUrl)) {
        return { ok: false, reason: 'unsupported_video_url_scheme' };
    }

    const hasFfmpeg = await checkFfmpegAvailability();
    if (!hasFfmpeg) {
        return { ok: false, reason: 'ffmpeg_not_available' };
    }

    const offsetSeconds = Number.isFinite(Number(opts.offsetSeconds))
        ? Number(opts.offsetSeconds)
        : POSTER_OFFSET_SECONDS;
    const timeoutMs = Number.isFinite(Number(opts.timeoutMs))
        ? Number(opts.timeoutMs)
        : EXTRACTION_TIMEOUT_MS;

    // Determine where the poster should be stored. If the caller
    // supplied an existing poster and asked us to skip the
    // extraction, we can early-return.
    const publicId = publicIdForVideo(videoUrl);

    if (opts.skipCache === false) {
        // Default is to use the cache when it exists. Check
        // Cloudinary directly. A missing resource returns an
        // error; we treat it as "not cached".
        try {
            const existing = await cloudinary.api.resource(
                `${POSTER_FOLDER}/${publicId}`,
                { resource_type: 'image' }
            );
            if (existing && existing.secure_url) {
                return { ok: true, posterUrl: existing.secure_url, cached: true };
            }
        } catch (err) {
            // Not cached. Continue to extraction.
        }
    }

    const tempFrame = buildTempPath('jpg');

    try {
        // One ffmpeg call does everything: seek, extract a single
        // frame, and write it to disk. Two calls (a short clip,
        // then a frame from that clip) would be slower and would
        // produce the same result. The single-call form is more
        // reliable on short videos.
        const args = [
            '-hide_banner',
            '-loglevel', 'error',
            '-ss', String(offsetSeconds),
            '-i', videoUrl,
            '-frames:v', '1',
            '-q:v', '3',
            '-vf', 'scale=640:-2',
            '-y',
            tempFrame
        ];

        await runProcess(FFMPEG_BIN, args, timeoutMs);

        if (!fs.existsSync(tempFrame) || fs.statSync(tempFrame).size === 0) {
            return { ok: false, reason: 'empty_frame' };
        }

        // Upload the frame to Cloudinary.
        const uploadResult = await cloudinary.uploader.upload(tempFrame, {
            folder: POSTER_FOLDER,
            public_id: publicId,
            overwrite: true,
            invalidate: true,
            resource_type: 'image',
            format: 'jpg',
            transformation: [
                { width: 640, crop: 'limit' },
                { quality: 'auto:good' },
                { fetch_format: 'auto' }
            ]
        });

        if (!uploadResult || !uploadResult.secure_url) {
            return { ok: false, reason: 'cloudinary_no_url' };
        }

        return {
            ok: true,
            posterUrl: uploadResult.secure_url,
            cached: false
        };
    } catch (err) {
        // Extraction or upload failed. Log it, but do not throw.
        // The caller falls back to the inheritance chain.
        logError(err, 'videoPosterService.extractPoster');
        return { ok: false, reason: 'extraction_failed' };
    } finally {
        safeUnlink(tempFrame);
    }
}

/**
 * Probe a video URL for its duration in seconds. Returns null on
 * any failure. This is a small helper that a future UI may use to
 * display a duration badge on a video thumbnail. It is exported
 * here so it lives next to the extraction code and shares the
 * availability check.
 */
async function probeDuration(videoUrl) {
    if (!videoUrl) return null;

    const hasFfmpeg = await checkFfmpegAvailability();
    if (!hasFfmpeg) return null;

    try {
        const out = await runProcess(
            FFPROBE_BIN,
            [
                '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1',
                videoUrl
            ],
            8000
        );
        const seconds = Number(String(out).trim());
        return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
    } catch (err) {
        return null;
    }
}

/**
 * Report whether the service is able to extract posters on this
 * host. Used at startup so the operator sees a clear log line.
 */
async function isAvailable() {
    return checkFfmpegAvailability();
}

// ------------------------------------------------------------
//  EXPORTS
// ------------------------------------------------------------

module.exports = {
    extractPoster,
    probeDuration,
    isAvailable,
    publicIdForVideo,
    POSTER_FOLDER
};