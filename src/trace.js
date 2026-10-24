'use strict';
const crypto = require('node:crypto');
const zlib = require('node:zlib');

// ---------------------------------------------------------------------------------------------
// Leak forensics. Every download is turned into a unique copy that carries a trace ID, so a
// leaked file can be matched to the exact download (person, time, version) in the audit trail.
//
// The stored, encrypted original is never changed. Stamping happens on the way out, after the
// integrity check, and the audit entry records both the trace ID and the SHA-256 of the exact
// bytes that were delivered. That gives two ways to identify a leaked copy:
//   1. the trace ID found inside it, or
//   2. its SHA-256, if the file was leaked unmodified.
// Each format is stamped in a place that keeps the file valid and opening normally.
// ---------------------------------------------------------------------------------------------
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I, so IDs are easy to read out
const TRACE_RE = /TV-[A-Z2-9]{5}-[A-Z2-9]{5}/;
const TRACE_EXACT = /^TV-[A-Z2-9]{5}-[A-Z2-9]{5}$/;

function newTraceId() {
  // 256 is a multiple of 32, so taking each byte mod 32 is unbiased.
  const s = [...crypto.randomBytes(10)].map((b) => ALPHABET[b % 32]).join('');
  return `TV-${s.slice(0, 5)}-${s.slice(5)}`;
}

function note(traceId, username, at) {
  return `TrustVault trace ${traceId} | downloaded by ${username} | ${new Date(at).toISOString()}`;
}

// ZIP-based Office files: write the note into the archive comment of the end-of-central-directory
// record. Only done when the existing comment is empty and the record is exactly at the end.
function stampZip(buf, text) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue;
    const commentLength = buf.readUInt16LE(i + 20);
    if (i + 22 + commentLength !== buf.length || commentLength !== 0) return null;
    const comment = Buffer.from(text, 'latin1');
    const len = Buffer.alloc(2);
    len.writeUInt16LE(comment.length);
    return Buffer.concat([buf.subarray(0, i + 20), len, comment]);
  }
  return null;
}

// PNG: insert a tEXt chunk (with a correct CRC) just before the final IEND chunk.
function stampPng(buf, text) {
  const iend = buf.lastIndexOf(Buffer.from('IEND', 'latin1'));
  if (iend < 12 || iend !== buf.length - 8) return null; // IEND must be the final chunk
  const start = iend - 4; // the chunk's length field
  const body = Buffer.concat([Buffer.from('tEXt', 'latin1'), Buffer.from('TrustVaultTrace\0', 'latin1'), Buffer.from(text, 'latin1')]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length - 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([buf.subarray(0, start), len, body, crc, buf.subarray(start)]);
}

// JPEG: insert a COM (comment) segment right after the start-of-image marker.
function stampJpeg(buf, text) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const data = Buffer.from(text, 'latin1');
  const header = Buffer.from([0xff, 0xfe, 0, 0]);
  header.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([buf.subarray(0, 2), header, data, buf.subarray(2)]);
}

// Returns { buffer, method }. method is null when the format could not be stamped safely
// (the trace ID is then still recorded, and the delivered SHA-256 still identifies the copy).
function stamp(buffer, extension, { traceId, username, at = Date.now() }) {
  const text = note(traceId, username, at);
  let out = null;
  let method = null;
  switch (extension) {
    case 'txt':
      out = Buffer.concat([buffer, Buffer.from(`\n\n-- ${text} --\n`, 'utf8')]);
      method = 'visible footer';
      break;
    case 'csv':
      out = Buffer.concat([buffer, Buffer.from(`${buffer[buffer.length - 1] === 0x0a ? '' : '\n'}# ${text}\n`, 'utf8')]);
      method = 'comment row';
      break;
    case 'pdf':
      out = Buffer.concat([buffer, Buffer.from(`\n%${text}\n`, 'latin1')]);
      method = 'PDF comment';
      break;
    case 'docx':
    case 'xlsx':
    case 'pptx':
      out = stampZip(buffer, text);
      method = out ? 'archive comment' : null;
      break;
    case 'png':
      out = stampPng(buffer, text);
      method = out ? 'PNG text chunk' : null;
      break;
    case 'jpg':
    case 'jpeg':
      out = stampJpeg(buffer, text);
      method = out ? 'JPEG comment' : null;
      break;
    default:
      break;
  }
  return { buffer: out || buffer, method };
}

// Finds a trace ID anywhere inside a (possibly leaked) file.
function findTraceId(buffer) {
  const m = buffer.toString('latin1').match(TRACE_RE);
  return m ? m[0] : null;
}

module.exports = { newTraceId, stamp, findTraceId, TRACE_EXACT };
