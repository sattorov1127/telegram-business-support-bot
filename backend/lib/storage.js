'use strict';

const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { requiredEnv, optionalEnv } = require('./env');

const DEFAULT_BUCKET = 'telegram-media';
const PUBLIC_BUCKET_FALLBACK = optionalEnv('TELEGRAM_MEDIA_BUCKET', DEFAULT_BUCKET);

const KIND_DEFAULT_MIME = Object.freeze({
  voice: 'audio/ogg',
  audio: 'audio/mpeg',
  photo: 'image/jpeg',
  video: 'video/mp4',
  video_note: 'video/mp4',
  animation: 'video/mp4',
  document: 'application/octet-stream',
  sticker: 'image/webp'
});

const MIME_EXT = Object.freeze({
  'audio/ogg': 'ogg',
  'audio/oga': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'text/plain': 'txt',
  'text/csv': 'csv'
});

function getBucketName(name) {
  return String(name || PUBLIC_BUCKET_FALLBACK || DEFAULT_BUCKET).trim() || DEFAULT_BUCKET;
}

function getSupabaseConfig() {
  return {
    url: requiredEnv('SUPABASE_URL').replace(/\/$/, ''),
    key: requiredEnv('SUPABASE_SERVICE_ROLE_KEY')
  };
}

function sanitizeStoragePath(value = '') {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\.\.+/g, '')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/[^A-Za-z0-9_./-]/g, '_')
    .trim();
}

function contentTypeForKind(kind, mimeType) {
  const explicit = String(mimeType || '').trim();
  if (explicit) return explicit;
  return KIND_DEFAULT_MIME[kind] || 'application/octet-stream';
}

function extFromMime(mime = '') {
  const clean = String(mime || '').split(';')[0].trim().toLowerCase();
  return MIME_EXT[clean] || '';
}

function extFromFileName(fileName = '') {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(String(fileName || ''));
  return match ? match[1].toLowerCase() : '';
}

function extForKind(kind, source = {}) {
  const fromName = extFromFileName(source.file_name || '');
  if (fromName) return fromName;
  const fromMime = extFromMime(source.mime_type || '');
  if (fromMime) return fromMime;
  if (kind === 'voice') return 'ogg';
  if (kind === 'audio') return 'mp3';
  if (kind === 'photo') return 'jpg';
  if (kind === 'video' || kind === 'video_note' || kind === 'animation') return 'mp4';
  if (kind === 'sticker') return 'webp';
  return 'bin';
}

function buildStoragePath({ kind, chatId, tgMessageId, source = {} }) {
  const safeChat = String(chatId === undefined || chatId === null ? 'unknown' : chatId).replace(/[^0-9A-Za-z_-]/g, '_');
  const safeMsg = String(tgMessageId || Date.now()).replace(/[^0-9A-Za-z_-]/g, '_');
  const uniqueId = String(source.file_unique_id || source.file_id || '').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 24);
  const ext = extForKind(kind, source);
  const tail = uniqueId ? `${safeMsg}-${uniqueId}` : safeMsg;
  return sanitizeStoragePath(`${kind}/${safeChat}/${tail}.${ext}`);
}

async function uploadStorageObject(bucket, path, bodyBuffer, contentType, { upsert = true } = {}) {
  if (!bodyBuffer) throw new Error('uploadStorageObject: bodyBuffer required');
  const safeBucket = getBucketName(bucket);
  const safePath = sanitizeStoragePath(path);
  if (!safePath) throw new Error('uploadStorageObject: path required');
  const { url, key } = getSupabaseConfig();
  const endpoint = `${url}/storage/v1/object/${encodeURIComponent(safeBucket)}/${safePath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      'Content-Type': contentType || 'application/octet-stream',
      'x-upsert': upsert ? 'true' : 'false',
      'cache-control': 'max-age=3600'
    },
    body: bodyBuffer
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Supabase Storage upload ${response.status}: ${text || response.statusText}`);
  }
  return { bucket: safeBucket, path: safePath };
}

async function streamStorageObject(bucket, path, res, { requestedType = '', fileName = '', cacheControl = 'private, max-age=86400' } = {}) {
  const safeBucket = getBucketName(bucket);
  const safePath = sanitizeStoragePath(path);
  if (!safePath) throw new Error('streamStorageObject: path required');
  const { url, key } = getSupabaseConfig();
  const endpoint = `${url}/storage/v1/object/${encodeURIComponent(safeBucket)}/${safePath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key
    }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const error = new Error(`Supabase Storage fetch ${response.status}: ${text || response.statusText}`);
    error.statusCode = response.status;
    throw error;
  }

  const upstreamType = String(response.headers.get('content-type') || '').trim();
  const fallbackName = fileName || safePath.split('/').pop() || 'media';
  const inferredFromName = (() => {
    const ext = extFromFileName(fallbackName);
    const reverse = Object.entries(MIME_EXT).find(([, value]) => value === ext);
    return reverse ? reverse[0] : '';
  })();
  const isUpstreamGeneric = !upstreamType || /octet-stream/i.test(upstreamType);
  const contentType = isUpstreamGeneric
    ? (requestedType || inferredFromName || upstreamType || 'application/octet-stream')
    : upstreamType;

  res.statusCode = 200;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', cacheControl);
  const contentLength = response.headers.get('content-length');
  if (contentLength) res.setHeader('Content-Length', contentLength);

  if (response.body && Readable.fromWeb) {
    await pipeline(Readable.fromWeb(response.body), res);
    return;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  res.setHeader('Content-Length', String(buffer.length));
  res.end(buffer);
}

module.exports = {
  DEFAULT_BUCKET,
  getBucketName,
  buildStoragePath,
  sanitizeStoragePath,
  contentTypeForKind,
  extForKind,
  uploadStorageObject,
  streamStorageObject
};
