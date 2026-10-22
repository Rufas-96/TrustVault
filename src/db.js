'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
const depth = new WeakMap();

function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

// Runs fn inside one transaction. Nested calls join the outer transaction, so a route can
// wrap "change + audit entry" and the audit module can still protect its own read-then-insert.
// fn must be synchronous (node:sqlite is synchronous), so no await inside.
function transaction(db, fn) {
  const current = depth.get(db) || 0;
  if (current > 0) {
    depth.set(db, current + 1);
    try { return fn(); } finally { depth.set(db, current); }
  }
  db.exec('BEGIN IMMEDIATE');
  depth.set(db, 1);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth.set(db, 0);
  }
}

module.exports = { openDatabase, transaction };
