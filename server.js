const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;

// --- إعداد قاعدة البيانات ---
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
const db = new Database(path.join(dataDir, 'contracts.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY,
  property_name TEXT NOT NULL,
  tenant_name TEXT NOT NULL DEFAULT '',
  cancelled INTEGER NOT NULL DEFAULT 0,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  total_value REAL NOT NULL DEFAULT 0,
  has_tax INTEGER NOT NULL DEFAULT 1,
  tax_rate REAL NOT NULL DEFAULT 15,
  payment_frequency TEXT NOT NULL DEFAULT 'custom',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  label TEXT NOT NULL,
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unpaid',
  amount REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// --- ترقية آمنة لقواعد بيانات قديمة تم إنشاؤها قبل إضافة هذه الأعمدة ---
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = cols.some((c) => c.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('contracts', 'tenant_name', "TEXT NOT NULL DEFAULT ''");
ensureColumn('contracts', 'tenant_phone', "TEXT NOT NULL DEFAULT ''");
ensureColumn('contracts', 'additional_phone', "TEXT NOT NULL DEFAULT ''");
ensureColumn('contracts', 'tenant_representative', "TEXT NOT NULL DEFAULT ''");
ensureColumn('contracts', 'payment_frequency', "TEXT NOT NULL DEFAULT 'custom'");
ensureColumn('payments', 'amount', 'REAL NOT NULL DEFAULT 0');

const seedSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
seedSetting.run('paymentAlertDays', '7');
seedSetting.run('endAlertDays', '30');

// --- Middleware ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- أدوات مساعدة ---
function getContractsFull() {
  const contracts = db.prepare('SELECT * FROM contracts ORDER BY created_at DESC').all();
  const paymentsStmt = db.prepare('SELECT * FROM payments WHERE contract_id = ? ORDER BY position ASC');
  return contracts.map((c) => ({
    id: c.id,
    propertyName: c.property_name,
    tenantName: c.tenant_name,
    tenantPhone: c.tenant_phone,
    additionalPhone: c.additional_phone,
    tenantRepresentative: c.tenant_representative,
    cancelled: !!c.cancelled,
    startDate: c.start_date,
    endDate: c.end_date,
    totalValue: c.total_value,
    hasTax: !!c.has_tax,
    taxRate: c.tax_rate,
    paymentFrequency: c.payment_frequency,
    payments: paymentsStmt
      .all(c.id)
      .map((p) => ({ label: p.label, date: p.date, status: p.status, amount: p.amount })),
  }));
}

function newId() {
  return 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

// --- مسارات API ---

// جلب كل العقود
app.get('/api/contracts', (req, res) => {
  res.json(getContractsFull());
});

// إضافة عقد جديد
app.post('/api/contracts', (req, res) => {
  const c = req.body;
  const id = newId();

  const insertContract = db.prepare(`
    INSERT INTO contracts (id, property_name, tenant_name, tenant_phone, additional_phone, tenant_representative, cancelled, start_date, end_date, total_value, has_tax, tax_rate, payment_frequency)
    VALUES (@id, @propertyName, @tenantName, @tenantPhone, @additionalPhone, @tenantRepresentative, @cancelled, @startDate, @endDate, @totalValue, @hasTax, @taxRate, @paymentFrequency)
  `);
  const insertPayment = db.prepare(
    'INSERT INTO payments (contract_id, position, label, date, status, amount) VALUES (?, ?, ?, ?, ?, ?)'
  );

  const tx = db.transaction(() => {
    insertContract.run({
      id,
      propertyName: c.propertyName,
      tenantName: c.tenantName || '',
      tenantPhone: c.tenantPhone || '',
      additionalPhone: c.additionalPhone || '',
      tenantRepresentative: c.tenantRepresentative || '',
      cancelled: c.cancelled ? 1 : 0,
      startDate: c.startDate,
      endDate: c.endDate,
      totalValue: c.totalValue,
      hasTax: c.hasTax ? 1 : 0,
      taxRate: c.taxRate,
      paymentFrequency: c.paymentFrequency || 'custom',
    });
    (c.payments || []).forEach((p, idx) => {
      insertPayment.run(id, idx, p.label, p.date, p.status, p.amount || 0);
    });
  });

  try {
    tx();
    res.status(201).json({ id });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'تعذر إنشاء العقد' });
  }
});

// تحديث عقد
app.put('/api/contracts/:id', (req, res) => {
  const id = req.params.id;
  const c = req.body;

  const updateContract = db.prepare(`
    UPDATE contracts SET property_name=@propertyName, tenant_name=@tenantName, tenant_phone=@tenantPhone,
      additional_phone=@additionalPhone, tenant_representative=@tenantRepresentative, cancelled=@cancelled, start_date=@startDate,
      end_date=@endDate, total_value=@totalValue, has_tax=@hasTax, tax_rate=@taxRate,
      payment_frequency=@paymentFrequency WHERE id=@id
  `);
  const deletePayments = db.prepare('DELETE FROM payments WHERE contract_id = ?');
  const insertPayment = db.prepare(
    'INSERT INTO payments (contract_id, position, label, date, status, amount) VALUES (?, ?, ?, ?, ?, ?)'
  );

  const tx = db.transaction(() => {
    const result = updateContract.run({
      id,
      propertyName: c.propertyName,
      tenantName: c.tenantName || '',
      tenantPhone: c.tenantPhone || '',
      additionalPhone: c.additionalPhone || '',
      tenantRepresentative: c.tenantRepresentative || '',
      cancelled: c.cancelled ? 1 : 0,
      startDate: c.startDate,
      endDate: c.endDate,
      totalValue: c.totalValue,
      hasTax: c.hasTax ? 1 : 0,
      taxRate: c.taxRate,
      paymentFrequency: c.paymentFrequency || 'custom',
    });
    if (result.changes === 0) throw new Error('العقد غير موجود');
    deletePayments.run(id);
    (c.payments || []).forEach((p, idx) => {
      insertPayment.run(id, idx, p.label, p.date, p.status, p.amount || 0);
    });
  });

  try {
    tx();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(404).json({ error: 'العقد غير موجود' });
  }
});

// تبديل حالة سداد دفعة واحدة
app.patch('/api/contracts/:id/payments/:index', (req, res) => {
  const { id, index } = req.params;
  const { status } = req.body;
  const payments = db.prepare('SELECT id FROM payments WHERE contract_id = ? ORDER BY position ASC').all(id);
  const target = payments[Number(index)];
  if (!target) return res.status(404).json({ error: 'الدفعة غير موجودة' });
  db.prepare('UPDATE payments SET status = ? WHERE id = ?').run(status, target.id);
  res.json({ ok: true });
});

// حذف عقد
app.delete('/api/contracts/:id', (req, res) => {
  const id = req.params.id;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM payments WHERE contract_id = ?').run(id);
    db.prepare('DELETE FROM contracts WHERE id = ?').run(id);
  });
  tx();
  res.json({ ok: true });
});

// إعدادات التنبيهات
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT * FROM settings').all();
  const obj = {};
  rows.forEach((r) => (obj[r.key] = Number(r.value)));
  res.json(obj);
});

app.put('/api/settings', (req, res) => {
  const { paymentAlertDays, endAlertDays } = req.body;
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  );
  upsert.run('paymentAlertDays', String(paymentAlertDays));
  upsert.run('endAlertDays', String(endAlertDays));
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`✅ الخادم يعمل على http://localhost:${PORT}`);
  console.log(`📁 قاعدة البيانات: ${path.join(dataDir, 'contracts.db')}`);
});
