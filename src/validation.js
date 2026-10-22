'use strict';
const { HttpError } = require('./http');

const startsWith = (buf, bytes) => buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b);
const ascii = (s) => [...Buffer.from(s, 'latin1')];

function isUtf8Text(buf) {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

// Office Open XML files are ZIP archives; the central directory lists entry names in plain
// text, so we can check for the parts that make a file a real .docx/.xlsx/.pptx.
const isOoxml = (folder) => (buf) =>
  startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) && buf.includes('[Content_Types].xml') && buf.includes(folder);

// Allow-list. The extension must be on this list AND the file's first bytes must match it.
// HTML, SVG, scripts and executables are deliberately absent.
const TYPES = {
  pdf:  { mime: 'application/pdf', check: (b) => startsWith(b, ascii('%PDF-')) },
  png:  { mime: 'image/png', check: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  jpg:  { mime: 'image/jpeg', check: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  jpeg: { mime: 'image/jpeg', check: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  txt:  { mime: 'text/plain; charset=utf-8', check: isUtf8Text },
  csv:  { mime: 'text/csv; charset=utf-8', check: isUtf8Text },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', check: isOoxml('word/') },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', check: isOoxml('xl/') },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', check: isOoxml('ppt/') },
};
const ALLOWED_EXTENSIONS = Object.keys(TYPES);

// Busboy decodes multipart filenames as latin1; browsers send UTF-8. Undo that when it is valid.
function decodeMultipartName(name) {
  const utf8 = Buffer.from(String(name || ''), 'latin1').toString('utf8');
  return utf8.includes('\ufffd') ? String(name || '') : utf8;
}

// The original name is only ever used for display and the download filename. It never
// becomes part of a path on disk.
function sanitizeFilename(raw) {
  let name = String(raw || '').normalize('NFC');
  name = name.split(/[\\/]/).pop();
  name = name.replace(/[\u0000-\u001f\u007f"<>:|?*]/g, '').replace(/^[.\s]+/, '').trim();
  if (name.length > 150) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot) : '';
    name = name.slice(0, 150 - ext.length) + ext;
  }
  return name || 'document';
}

// Validates a multer file object. Returns { buffer, name, extension, mime } or throws.
function inspectUpload(file, maxBytes) {
  if (!file || !file.buffer) throw new HttpError(400, 'Choose a file to upload');
  const name = sanitizeFilename(decodeMultipartName(file.originalname));
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const type = TYPES[extension];
  if (!type) {
    throw new HttpError(415, `File type not allowed. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`);
  }
  if (file.buffer.length === 0) throw new HttpError(400, 'The file is empty');
  if (file.buffer.length > maxBytes) throw new HttpError(413, 'The file is too large');
  if (!type.check(file.buffer)) {
    throw new HttpError(415, `The file's contents do not match a .${extension} file`);
  }
  return { buffer: file.buffer, name, extension, mime: type.mime };
}

// RFC 6266 / 5987 Content-Disposition with an ASCII fallback.
function contentDisposition(name) {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

module.exports = { inspectUpload, sanitizeFilename, contentDisposition, ALLOWED_EXTENSIONS };
