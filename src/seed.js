'use strict';
const { createUser } = require('./users');
const { createDocument } = require('./documents');
const { transaction } = require('./db');

// Demo accounts. These passwords are published in the README on purpose so judges can sign in;
// change them (or set SEED_DEMO=false) for any real use.
const DEMO_USERS = [
  { key: 'admin', username: 'admin', displayName: 'Ira Admin', email: 'admin@trustvault.example', role: 'admin', password: 'AdminVault#2026' },
  { key: 'alice', username: 'alice', displayName: 'Alice Fernandes (HR)', email: 'alice@trustvault.example', role: 'owner', password: 'OwnerAlice#2026' },
  { key: 'bob', username: 'bob', displayName: 'Bob Okafor (Legal)', email: 'bob@trustvault.example', role: 'owner', password: 'OwnerBob#2026' },
  { key: 'carol', username: 'carol', displayName: 'Carol Diaz (Employee)', email: 'carol@trustvault.example', role: 'viewer', password: 'ViewerCarol#2026' },
  { key: 'dave', username: 'dave', displayName: 'Dave Lin (Northwind, external)', email: 'dave@northwind.example', role: 'viewer', password: 'ViewerDave#2026' },
];

// Builds a small, valid one-page PDF containing the given lines of ASCII text.
function simplePdf(lines) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const stream = ['BT', '/F1 12 Tf', '72 740 Td', '18 TL', ...lines.map((l) => `(${esc(l)}) Tj T*`), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const pdf = (name, lines) => ({ buffer: simplePdf(lines), name, extension: 'pdf', mime: 'application/pdf' });
const txt = (name, body, ext = 'txt') => ({
  buffer: Buffer.from(body, 'utf8'), name, extension: ext, mime: ext === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8',
});

async function seedDemoData(ctx) {
  const { db, audit } = ctx;
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return false;

  const u = {};
  for (const spec of DEMO_USERS) u[spec.key] = await createUser(db, spec);
  audit.record({ actor: null, action: 'system.seed', details: { users: DEMO_USERS.map((x) => x.username) } });

  const doc = (owner, title, description, category, file) =>
    createDocument(ctx, { req: null, owner, title, description, category, file });

  const salary = doc(u.alice, 'Salary letter - Carol Diaz 2026', 'Annual compensation letter. Confidential to the employee and HR.', 'HR',
    pdf('salary-letter-carol-diaz-2026.pdf', ['TrustVault demo document', '', 'Salary letter - Carol Diaz', 'Effective 1 April 2026', 'Annual gross: INR 9,60,000', '', 'Confidential: HR and the named employee only.']));
  const handbook = doc(u.alice, 'Employee Handbook 2026', 'Policies for all employees: leave, conduct, security.', 'HR',
    txt('employee-handbook-2026.txt', 'EMPLOYEE HANDBOOK 2026\n\n1. Leave policy\n2. Code of conduct\n3. Information security: never share documents outside TrustVault.\n'));
  const payroll = doc(u.alice, 'Payroll summary Q3 2026', 'Quarterly payroll totals by department. HR only.', 'Finance',
    txt('payroll-q3-2026.csv', 'department,headcount,total_inr\nEngineering,42,1.92 Cr\nSales,18,0.71 Cr\nHR,6,0.22 Cr\n', 'csv'));
  const msa = doc(u.bob, 'Master Services Agreement - Northwind', 'Contract under negotiation with Northwind Traders.', 'Legal',
    pdf('msa-northwind-draft.pdf', ['Master Services Agreement', 'Between Contoso Ltd and Northwind Traders', '', 'DRAFT v1 - for negotiation', 'Clause 7: Liability is capped at fees paid.']));
  const minutes = doc(u.bob, 'Board minutes - September 2026', 'Minutes of the September board meeting. Restricted.', 'Legal',
    pdf('board-minutes-2026-09.pdf', ['Board minutes - September 2026', '', 'Item 1: Approval of FY27 budget', 'Item 2: Acquisition discussion (restricted)']));
  const drawing = doc(u.bob, 'Site drawing - Building C', 'Layout drawing shared with the external contractor.', 'Engineering',
    txt('building-c-layout.txt', 'BUILDING C - FLOOR PLAN NOTES\nGrid A-F, levels 0-3. Fire exits at A1, F3.\n'));

  const grant = (owner, documentId, grantee, level, expiresAt = null) => transaction(db, () => {
    db.prepare('INSERT INTO permissions (document_id, user_id, level, granted_by, granted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(documentId, grantee.id, level, owner.id, Date.now(), expiresAt);
    const title = db.prepare('SELECT title FROM documents WHERE id = ?').get(documentId).title;
    audit.record({ actor: owner, action: 'permission.grant', documentId, targetUserId: grantee.id, details: { title, grantee: grantee.username, level, expiresAt } });
  });

  grant(u.alice, salary, u.carol, 'read');
  grant(u.alice, handbook, u.carol, 'read');
  grant(u.alice, handbook, u.dave, 'read');
  grant(u.bob, msa, u.dave, 'edit');
  grant(u.bob, drawing, u.dave, 'read', Date.now() + 7 * 24 * 3600 * 1000);
  void payroll; void minutes; // deliberately shared with nobody: good targets for access tests
  return true;
}

module.exports = { seedDemoData, DEMO_USERS, simplePdf };
