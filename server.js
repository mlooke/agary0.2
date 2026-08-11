const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pdfParse = require('pdf-parse');
const multer = require('multer');
const https = require('https');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';

// --- إعداد Firebase (قاعدة بيانات سحابية مشتركة) ---
// الأولوية: متغير بيئة FIREBASE_SERVICE_ACCOUNT (للاستضافة السحابية) ثم ملف serviceAccountKey.json (محلياً)
function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  }
  const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
  if (!fs.existsSync(serviceAccountPath)) {
    console.error('❌ مفتاح Firebase غير موجود!');
    console.error('ضع ملف serviceAccountKey.json بجانب server.js، أو ضع محتواه في متغير FIREBASE_SERVICE_ACCOUNT');
    process.exit(1);
  }
  return require(serviceAccountPath);
}
admin.initializeApp({
  credential: admin.credential.cert(loadServiceAccount()),
  databaseURL: 'https://alqaih-default-rtdb.europe-west1.firebasedatabase.app'
});
const rtdb = admin.database();
const contractsRef = rtdb.ref('contracts');
const settingsRef = rtdb.ref('settings');
const usersRef = rtdb.ref('users');
const adminRef = rtdb.ref('admin');

// --- نظام الحسابات (جلسات في الذاكرة) ---
const sessions = new Map(); // token -> { username, role, expires }
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 يوم

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

function newSessionToken(username, role) {
  const token = randomToken();
  sessions.set(token, { username, role: role || 'user', expires: Date.now() + SESSION_TTL_MS });
  return token;
}

// وسيط يمنع الوصول لمسارات API بدون تسجيل دخول
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'يرجى تسجيل الدخول أولاً' });
  const sess = sessions.get(token);
  if (!sess || sess.expires < Date.now()) {
    sessions.delete(token);
    return res.status(401).json({ error: 'انتهت الجلسة، سجّل الدخول مجدداً' });
  }
  req.user = sess.username;
  req.isAdmin = sess.role === 'admin';
  next();
}

// وسيط يمنع الوصول لمسارات الإدارة إلا للمدير فقط
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.isAdmin) return res.status(403).json({ error: 'غير مصرح — هذا الإجراء للمدير فقط' });
    next();
  });
}

// --- إعداد مجلد PDF ---
const pdfDir = path.join(__dirname, 'pdf');
if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir);

// --- إعداد Multer لرفع ملفات PDF ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, pdfDir),
  filename: (req, file, cb) => {
    const uniqueName = `contract_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.pdf`;
    cb(null, uniqueName);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('يُسمح فقط بملفات PDF'));
  }
});

// --- Middleware ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/pdf', express.static(pdfDir));

// --- أدوات مساعدة ---
async function getContractsFull(owner) {
  const snap = await contractsRef.once('value');
  const data = snap.val() || {};
  const list = Object.entries(data)
    .filter(([id, c]) => c.owner === owner)
    .map(([id, c]) => ({
    id,
    propertyName: c.propertyName || '',
    tenantName: c.tenantName || '',
    tenantPhone: c.tenantPhone || '',
    tenantRepresentative: c.tenantRepresentative || '',
    cancelled: !!c.cancelled,
    startDate: c.startDate || '',
    endDate: c.endDate || '',
    totalValue: c.totalValue || 0,
    hasTax: c.hasTax !== undefined ? !!c.hasTax : true,
    taxRate: c.taxRate || 15,
    paymentFrequency: c.paymentFrequency || 'custom',
    createdAt: c.createdAt || 0,
    endReminderSent: c.endReminderSent || false,
    payments: Object.values(c.payments || {}).map((p) => ({
      label: p.label || '',
      date: p.date || '',
      status: p.status || 'unpaid',
      amount: p.amount || 0,
      paidAmount: p.paidAmount || 0,
      reminderSent: p.reminderSent || false,
    })),
  }));
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return list;
}

function newId() {
  return 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

// --- مسارات المصادقة ---

// إنشاء حساب جديد (يتطلب جلسة مدير)
app.post('/api/auth/register', requireAdmin, async (req, res) => {
  const { username, password } = req.body;
  try {
    const name = String(username || '').trim();
    if (name.length < 3) return res.status(400).json({ error: 'اسم المستخدم قصير جداً (3 أحرف على الأقل)' });
    if (!password || String(password).length < 4) return res.status(400).json({ error: 'كلمة المرور قصيرة جداً (4 أحرف على الأقل)' });

    const existing = await usersRef.child(name).once('value');
    if (existing.exists()) return res.status(409).json({ error: 'اسم المستخدم موجود مسبقاً' });

    const salt = crypto.randomBytes(16).toString('hex');
    await usersRef.child(name).set({
      salt,
      passHash: hashPassword(password, salt),
      passPlain: String(password),
      createdAt: Date.now()
    });
    res.status(201).json({ ok: true, username: name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر إنشاء الحساب' });
  }
});

// إنشاء حساب المدير (يُستخدم مرة واحدة فقط عند أول تشغيل)
app.post('/api/auth/setup', async (req, res) => {
  const { username, password } = req.body;
  try {
    const name = String(username || '').trim();
    if (name.length < 3) return res.status(400).json({ error: 'اسم المستخدم قصير جداً (3 أحرف على الأقل)' });
    if (!password || String(password).length < 4) return res.status(400).json({ error: 'كلمة المرور قصيرة جداً (4 أحرف على الأقل)' });

    const adminSnap = await adminRef.once('value');
    if (adminSnap.exists()) return res.status(403).json({ error: 'حساب المدير موجود مسبقاً' });

    const salt = crypto.randomBytes(16).toString('hex');
    await adminRef.set({
      username: name,
      salt,
      passHash: hashPassword(password, salt),
      passPlain: String(password),
      createdAt: Date.now()
    });

    // أول حساب (المدير) يستلم العقود القديمة التي لا تملك مالكاً
    const contractsSnap = await contractsRef.once('value');
    const all = contractsSnap.val() || {};
    const updates = {};
    Object.entries(all).forEach(([id, c]) => {
      if (!c.owner) updates[id] = { ...c, owner: name };
    });
    if (Object.keys(updates).length) await contractsRef.update(updates);

    res.status(201).json({ token: newSessionToken(name, 'admin'), username: name, isAdmin: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر إنشاء حساب المدير' });
  }
});

// تسجيل الدخول
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const name = String(username || '').trim();
    // دخول المدير
    const adminSnap = await adminRef.once('value');
    const adminAcc = adminSnap.val();
    if (adminAcc && name === adminAcc.username) {
      if (hashPassword(password || '', adminAcc.salt) !== adminAcc.passHash) {
        return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
      }
      return res.json({ token: newSessionToken(name, 'admin'), username: name, isAdmin: true });
    }
    // دخول مستخدم عادي
    const snap = await usersRef.child(name).once('value');
    const user = snap.val();
    if (!user || hashPassword(password || '', user.salt) !== user.passHash) {
      return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }
    res.json({ token: newSessionToken(name, 'user'), username: name, isAdmin: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر تسجيل الدخول' });
  }
});

// تسجيل الخروج
app.post('/api/auth/logout', requireAuth, (req, res) => {
  const token = (req.headers.authorization || '').slice(7);
  sessions.delete(token);
  res.json({ ok: true });
});

// التحقق من الجلسة الحالية
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ username: req.user, isAdmin: req.isAdmin });
});

// حالة النظام: هل يوجد حساب مدير؟
app.get('/api/auth/status', async (req, res) => {
  try {
    const adminSnap = await adminRef.once('value');
    res.json({ hasAdmin: adminSnap.exists() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر جلب الحالة' });
  }
});

// إدارة الحسابات (للمدير فقط)

// جلب قائمة الحسابات (للمدير فقط)
app.get('/api/auth/users', requireAdmin, async (req, res) => {
  try {
    const adminAcc = (await adminRef.once('value')).val() || {};
    const list = [];
    if (adminAcc.username) {
      list.push({ name: adminAcc.username, passPlain: adminAcc.passPlain || '', createdAt: adminAcc.createdAt || 0, contractsCount: 0, isAdmin: true });
    }
    const snap = await usersRef.once('value');
    const data = snap.val() || {};
    Object.entries(data).forEach(([name, u]) => {
      list.push({ name, passPlain: u.passPlain || '', createdAt: u.createdAt || 0, contractsCount: 0, isAdmin: false });
    });
    const contractsSnap = await contractsRef.once('value');
    const contracts = contractsSnap.val() || {};
    list.forEach((u) => {
      u.contractsCount = Object.values(contracts).filter((c) => c.owner === u.name).length;
    });
    list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر جلب الحسابات' });
  }
});

// حذف حساب (للمدير فقط)
app.delete('/api/auth/users/:name', requireAdmin, async (req, res) => {
  const name = String(req.params.name || '').trim();
  try {
    const existing = await usersRef.child(name).once('value');
    if (!existing.exists()) return res.status(404).json({ error: 'الحساب غير موجود' });
    const adminAcc = (await adminRef.once('value')).val();
    if (adminAcc && name === adminAcc.username) return res.status(400).json({ error: 'لا يمكن حذف حساب المدير' });
    // عقود الحساب المحذوف تنتقل إلى المدير حتى لا تختفي
    const contractsSnap = await contractsRef.once('value');
    const contracts = contractsSnap.val() || {};
    const updates = {};
    Object.entries(contracts).forEach(([id, c]) => {
      if (c.owner === name) updates[id] = { ...c, owner: adminAcc && adminAcc.username ? adminAcc.username : '' };
    });
    if (Object.keys(updates).length) await contractsRef.update(updates);
    await usersRef.child(name).remove();
    // إلغاء جلسات الحساب المحذوف
    for (const [token, sess] of sessions) {
      if (sess.username === name) sessions.delete(token);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر حذف الحساب' });
  }
});

// تعديل كلمة مرور حساب (للمدير فقط)
app.put('/api/auth/users/:name/password', requireAdmin, async (req, res) => {
  const name = String(req.params.name || '').trim();
  const password = String(req.body.password || '');
  if (password.length < 4) return res.status(400).json({ error: 'كلمة المرور قصيرة جداً (4 أحرف على الأقل)' });
  try {
    const salt = crypto.randomBytes(16).toString('hex');
    const adminAcc = (await adminRef.once('value')).val() || {};
    if (adminAcc.username && name === adminAcc.username) {
      await adminRef.update({ salt, passHash: hashPassword(password, salt), passPlain: password });
    } else {
      const existing = await usersRef.child(name).once('value');
      if (!existing.exists()) return res.status(404).json({ error: 'الحساب غير موجود' });
      await usersRef.child(name).update({ salt, passHash: hashPassword(password, salt), passPlain: password });
    }
    // إنهاء جلسات الحساب الأخرى ليُسجّل دخوله بكلمة المرور الجديدة
    const currentToken = (req.headers.authorization || '').slice(7);
    for (const [token, sess] of sessions) {
      if (sess.username === name && token !== currentToken) sessions.delete(token);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر تعديل كلمة المرور' });
  }
});

// --- مسارات API ---

// جلب كل العقود (عقود الحساب فقط)
app.get('/api/contracts', requireAuth, async (req, res) => {
  try {
    res.json(await getContractsFull(req.user));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر جلب العقود' });
  }
});

async function insertContractFn(c, id, owner) {
  await contractsRef.child(id).set({
    owner,
    propertyName: c.propertyName || '',
    tenantName: c.tenantName || '',
    tenantPhone: c.tenantPhone || '',
    tenantRepresentative: c.tenantRepresentative || '',
    cancelled: !!c.cancelled,
    startDate: c.startDate || '',
    endDate: c.endDate || '',
    totalValue: c.totalValue || 0,
    hasTax: c.hasTax !== undefined ? !!c.hasTax : true,
    taxRate: c.taxRate || 15,
    paymentFrequency: c.paymentFrequency || 'custom',
    createdAt: admin.database.ServerValue.TIMESTAMP,
    payments: (c.payments || []).map((p) => ({
      label: p.label || '',
      date: p.date || '',
      status: p.status || 'unpaid',
      amount: p.amount || 0,
      paidAmount: p.paidAmount || 0,
      reminderSent: p.reminderSent || false,
    })),
  });
}

// إضافة عقد جديد
app.post('/api/contracts', requireAuth, async (req, res) => {
  const c = req.body;
  const id = newId();

  try {
    const existing = await getContractsFull(req.user);
    const duplicate = existing.find((x) =>
      x.propertyName === (c.propertyName || '') &&
      x.tenantName === (c.tenantName || '') &&
      x.startDate === (c.startDate || '') &&
      x.endDate === (c.endDate || '') &&
      x.totalValue === (c.totalValue || 0)
    );

    if (duplicate) {
      return res.status(409).json({ error: 'هذا العقد موجود مسبقاً', duplicateId: duplicate.id });
    }

    await insertContractFn(c, id, req.user);
    res.status(201).json({ id });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'تعذر إنشاء العقد' });
  }
});

// إضافة عقد جديد بدون فحص تكرار
app.post('/api/contracts/force', requireAuth, async (req, res) => {
  try {
    const id = newId();
    await insertContractFn(req.body, id, req.user);
    res.status(201).json({ id });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'تعذر إنشاء العقد' });
  }
});

// تحديث عقد
app.put('/api/contracts/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  const c = req.body;

  try {
    const ref = contractsRef.child(id);
    const snap = await ref.once('value');
    const cur = snap.val();
    if (!cur || cur.owner !== req.user) return res.status(404).json({ error: 'العقد غير موجود' });

    await ref.set({
      owner: req.user,
      propertyName: c.propertyName || '',
      tenantName: c.tenantName || '',
      tenantPhone: c.tenantPhone || '',
      tenantRepresentative: c.tenantRepresentative || '',
      cancelled: !!c.cancelled,
      startDate: c.startDate || '',
      endDate: c.endDate || '',
      totalValue: c.totalValue || 0,
      hasTax: c.hasTax !== undefined ? !!c.hasTax : true,
      taxRate: c.taxRate || 15,
      paymentFrequency: c.paymentFrequency || 'custom',
      createdAt: admin.database.ServerValue.TIMESTAMP,
      endReminderSent: cur.endReminderSent || false,
      payments: (c.payments || []).map((p) => ({
        label: p.label || '',
        date: p.date || '',
        status: p.status || 'unpaid',
        amount: p.amount || 0,
        paidAmount: p.paidAmount || 0,
        reminderSent: p.reminderSent || false,
      })),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(404).json({ error: 'العقد غير موجود' });
  }
});

// تحديث حقل على العقد (مثل تذكير انتهاء العقد)
app.patch('/api/contracts/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  const fields = {};
  if (req.body.endReminderSent !== undefined) fields.endReminderSent = !!req.body.endReminderSent;
  try {
    const ref = contractsRef.child(id);
    const snap = await ref.once('value');
    const cur = snap.val();
    if (!cur || cur.owner !== req.user) return res.status(404).json({ error: 'العقد غير موجود' });
    await ref.update(fields);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر تحديث العقد' });
  }
});

// تبديل حالة سداد دفعة واحدة
app.patch('/api/contracts/:id/payments/:index', requireAuth, async (req, res) => {
  const { id, index } = req.params;
  const { status, paidAmount, reminderSent } = req.body;
  try {
    const ref = contractsRef.child(id);
    const snap = await ref.once('value');
    const c = snap.val();
    if (!c || c.owner !== req.user) return res.status(404).json({ error: 'الدفعة غير موجودة' });
    const payments = Object.values(c.payments || {}).map((p) => ({ ...p }));
    const target = payments[Number(index)];
    if (!target) return res.status(404).json({ error: 'الدفعة غير موجودة' });
    const updated = { ...target };
    if (status !== undefined) updated.status = status;
    if (paidAmount !== undefined) updated.paidAmount = Math.max(0, Number(paidAmount) || 0);
    if (reminderSent !== undefined) updated.reminderSent = !!reminderSent;
    payments[Number(index)] = updated;
    await ref.update({ payments });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر تحديث الدفعة' });
  }
});

// حذف عقد
app.delete('/api/contracts/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  try {
    const snap = await contractsRef.child(id).once('value');
    const cur = snap.val();
    if (!cur || cur.owner !== req.user) return res.status(404).json({ error: 'العقد غير موجود' });
    await contractsRef.child(id).remove();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر حذف العقد' });
  }
});

// مسح ملف PDF واستخراج بيانات العقد عبر DeepSeek AI
app.post('/api/contracts/scan-pdf', requireAuth, upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'لم يتم رفع ملف PDF' });
  try {
    const dataBuffer = fs.readFileSync(req.file.path);
    const pdfData = await pdfParse(dataBuffer);
    const text = pdfData.text || '';

    // محاولة الاستخراج بالذكاء الاصطناعي
    try {
      const extracted = await callDeepSeek(text);
      applyPropertyNameRule(extracted);
      return res.json({
        filename: req.file.filename,
        filepath: `/pdf/${req.file.filename}`,
        extracted,
        source: 'ai'
      });
    } catch (aiErr) {
      console.log('AI فشل، استخدام الاستخراج المحلي:', aiErr.message);
    }

    // fallback محلي
    const extracted = extractContractData(text);
    applyPropertyNameRule(extracted);
    res.json({
      filename: req.file.filename,
      filepath: `/pdf/${req.file.filename}`,
      extracted,
      source: 'local'
    });
  } catch (err) {
    console.error('PDF parse error:', err);
    res.status(500).json({ error: 'تعذر قراءة ملف PDF' });
  }
});

// اسم العقار يُجعل مطابقاً لاسم المستأجر تلقائياً بعد الاستخراج
function applyPropertyNameRule(extracted) {
  if (extracted && extracted.tenantName) extracted.propertyName = extracted.tenantName;
  return extracted;
}

// استخراج بيانات العقد من النص المستخرج من PDF
function extractContractData(text) {
  const result = {
    propertyName: '',
    tenantName: '',
    tenantRepresentative: '',
    tenantPhone: '',
    startDate: '',
    endDate: '',
    totalValue: 0
  };

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    const lower = line.toLowerCase();

    // اسم العقار / العقار / الموضوع
    if (/^(اسم العقار|العقار|الموضوع|العنوان|عقار)[\s:：\-]*/i.test(line)) {
      result.propertyName = line.replace(/^(اسم العقار|العقار|الموضوع|العنوان|عقار)[\s:：\-]*/i, '').trim();
    }

    // اسم المستأجر
    if (/^(اسم المستأجر|المستأجر|المستأجرون?)[\s:：\-]*/i.test(line)) {
      result.tenantName = line.replace(/^(اسم المستأجر|المستأجر|المستأجرون?)[\s:：\-]*/i, '').trim();
    }

    // ممثل المستأجر
    if (/^(اسم الممثل|ممثل المستأجر|الممثل)[\s:：\-]*/i.test(line)) {
      result.tenantRepresentative = line.replace(/^(اسم الممثل|ممثل المستأجر|الممثل)[\s:：\-]*/i, '').trim();
    }

    // هاتف المستأجر
    if (/^(هاتف المستأجر|جوال المستأجر|التليفون|الجوال|هاتف|موبايل)[\s:：\-]*/i.test(line)) {
      let phone = line.replace(/^(هاتف المستأجر|جوال المستأجر|التليفون|الجوال|هاتف|موبايل)[\s:：\-]*/i, '').trim();
      phone = phone.replace(/[^0-9+]/g, '');
      if (phone.startsWith('+966')) phone = '0' + phone.slice(4);
      else if (phone.startsWith('966') && phone.length > 3) phone = '0' + phone.slice(3);
      if (!result.tenantPhone) result.tenantPhone = phone;
    }

    // تاريخ البداية
    if (/^(تاريخ البداية|تاريخCommencement|بداية العقد|من تاريخ|من)[\s:：\-]*/i.test(line)) {
      result.startDate = parseDate(line.replace(/^(تاريخ البداية|تاريخCommencement|بداية العقد|من تاريخ|من)[\s:：\-]*/i, '').trim());
    }

    // تاريخ النهاية
    if (/^(تاريخ النهاية|نهاية العقد|إلى تاريخ|إلى|حتى)[\s:：\-]*/i.test(line)) {
      result.endDate = parseDate(line.replace(/^(تاريخ النهاية|نهاية العقد|إلى تاريخ|إلى|حتى)[\s:：\-]*/i, '').trim());
    }

    // القيمة / المبلغ / الإيجار
    if (/^(القيمة الإجمالية|المبلغ الإجمالي|قيمة العقد|الإيجار السنوي|المبلغ|القيمة|إجمالي|إيجار)[\s:：\-]*/i.test(line)) {
      const num = line.replace(/^(القيمة الإجمالية|المبلغ الإجمالي|قيمة العقد|الإيجار السنوي|المبلغ|القيمة|إجمالي|إيجار)[\s:：\-]*/i, '').trim();
      const parsed = parseFloat(num.replace(/[^\d.]/g, ''));
      if (!isNaN(parsed) && parsed > 0) result.totalValue = parsed;
    }
  }

  // محاولة استخراج التواريخ إذا لم يتم العثور عليها باليغة واضحة
  if (!result.startDate || !result.endDate) {
    const datePattern = /(\d{1,4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,4})/g;
    const dates = [...text.matchAll(datePattern)].map(m => m[1]);
    if (dates.length >= 2 && !result.startDate) result.startDate = parseDate(dates[0]);
    if (dates.length >= 2 && !result.endDate) result.endDate = parseDate(dates[dates.length - 1]);
  }

  // محاولة استخراج القيمة إذا لم يتم العثور عليها
  if (!result.totalValue) {
    const moneyPattern = /(\d[\d,]*\.?\d*)\s*(ريال|ر\.س| SAR|USD|\$)/gi;
    const moneyMatch = text.match(moneyPattern);
    if (moneyMatch) {
      const lastMatch = moneyMatch[moneyMatch.length - 1];
      const parsed = parseFloat(lastMatch.replace(/[^\d.]/g, ''));
      if (!isNaN(parsed) && parsed > 0) result.totalValue = parsed;
    }
  }

  return result;
}

function parseDate(str) {
  if (!str) return '';
  str = str.trim();
  // Try DD/MM/YYYY or DD-MM-YYYY
  let match = str.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
  if (match) return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  // Try YYYY/MM/DD
  match = str.match(/(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/);
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  // Try DD-MM-YY
  match = str.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2})$/);
  if (match) return `20${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  return str;
}

// --- المساعد الشخصي الذكي ---

const ASSIST_MAX_HISTORY = 10; // آخر 10 رسائل (5 تبادلات) تُحفظ في ذاكرة المحادثة

// يحوّل عقود المستخدم إلى ملخص نصي يوضح للذكاء الاصطناعي بياناته فقط
function summarizeContracts(list) {
  return list.map((c) => {
    const paid = c.payments.filter((p) => p.status === 'paid' || p.paidAmount >= (p.amount || 0));
    const partial = c.payments.filter((p) => p.status !== 'paid' && p.paidAmount > 0);
    const overdue = c.payments.filter((p) => p.status !== 'paid' && p.paidAmount < (p.amount || 0) && new Date(p.date) < new Date());
    return {
      id: c.id,
      propertyName: c.propertyName,
      tenantName: c.tenantName,
      tenantPhone: c.tenantPhone,
      startDate: c.startDate,
      endDate: c.endDate,
      totalValue: c.totalValue,
      hasTax: c.hasTax,
      taxRate: c.taxRate,
      paymentFrequency: c.paymentFrequency,
      cancelled: c.cancelled,
      payments: c.payments.map((p) => ({
        label: p.label,
        date: p.date,
        amount: p.amount,
        paidAmount: p.paidAmount || 0,
        status: p.status,
      })),
      counts: { paid: paid.length, partial: partial.length, overdue: overdue.length, total: c.payments.length },
    };
  });
}

// إجماليات محسوبة على الخادم من دفعات المستخدم — يعتمد عليها الذكاء دون إعادة حساب
function computeAssistantTotals(list, alertDays, endAlertDays) {
  const totals = {
    active: 0, upcoming: 0, expired: 0, cancelled: 0,
    paidCount: 0, paidTotal: 0,
    unpaidCount: 0, unpaidTotal: 0,
    overdueCount: 0, overdueTotal: 0,
    dueSoonCount: 0, dueSoonTotal: 0,
    partialCount: 0, partialRemaining: 0,
    endingCount: 0, endingContractIds: [],
  };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  list.forEach((c) => {
    if (c.cancelled) { totals.cancelled++; return; }
    const s = new Date(c.startDate), e = new Date(c.endDate);
    if (today < s) totals.upcoming++;
    else if (today > e) totals.expired++;
    else totals.active++;
    if (!isNaN(e) && today <= e) {
      const endDiff = Math.round((e - today) / 86400000);
      if (endDiff >= 0 && endDiff <= endAlertDays) { totals.endingCount++; totals.endingContractIds.push(c.id); }
    }
    (c.payments || []).forEach((p) => {
      const amount = p.amount || 0;
      const paid = p.paidAmount || 0;
      const remaining = Math.max(0, amount - paid);
      if (p.status === 'paid' || paid >= amount) { totals.paidCount++; totals.paidTotal += amount; return; }
      totals.unpaidCount++; totals.unpaidTotal += remaining;
      if (paid > 0) { totals.partialCount++; totals.partialRemaining += remaining; }
      const due = new Date(p.date);
      const diff = Math.round((due - today) / 86400000);
      if (diff < 0) { totals.overdueCount++; totals.overdueTotal += remaining; }
      else if (diff <= alertDays) { totals.dueSoonCount++; totals.dueSoonTotal += remaining; }
    });
  });
  return totals;
}

function sseEvent(obj) { return 'data: ' + JSON.stringify(obj) + '\n\n'; }

// مساعد ذكي يجيب عن أسئلة المستخدم بناءً على عقوده فقط، مع ذاكرة محادثة وتدفق
app.post('/api/assistant', requireAuth, async (req, res) => {
  const question = String(req.body.question || '').trim();
  if (!question) return res.status(400).json({ error: 'اكتب سؤالك أولاً' });
  const isStream = req.body.stream === true;
  if (!DEEPSEEK_API_KEY) return res.status(500).json({ error: 'DEEPSEEK_API_KEY غير مضبوط — أضفه في متغيرات البيئة' });
  const token = (req.headers.authorization || '').slice(7);
  const sess = sessions.get(token);
  const history = sess && Array.isArray(sess.history) ? sess.history : [];

  try {
    const list = await getContractsFull(req.user);
    const settingsSnap = await settingsRef.child(req.user).once('value');
    const s = settingsSnap.val() || {};
    const alertDays = Number(s.paymentAlertDays) || 7;
    const endAlertDays = Number(s.endAlertDays) || 30;
    const totals = computeAssistantTotals(list, alertDays, endAlertDays);
    const now = new Date();
    const nowInfo = {
      iso: now.toISOString(),
      date: now.toLocaleDateString('en-CA'),
      weekday: now.toLocaleDateString('ar-SA', { weekday: 'long' }),
    };
    const context = JSON.stringify({ user: req.user, now: nowInfo, totals, contracts: summarizeContracts(list) });

    const prompt = `أنت مساعد شخصي خبير بمتابعة عقود الإيجار داخل تطبيق لإدارة العقود.

المستخدم: ${req.user}
التاريخ والوقت الحاليان الآن: ${nowInfo.iso} (${nowInfo.date} — ${nowInfo.weekday})
بيانات عقود المستخدم (JSON فقط — لا تعتمد على أي معلومات خارجها):
${context}

مهمتك: الإجابة عن سؤال المستخدم الحالي باللغة العربية، معتمدا فقط على بياناته أعلاه وعلى سياق المحادثة السابقة.

قواعد:
- كن مختصراً جداً: أجب بجملة أو جملتين، واذكر الأرقام والأسماء فقط دون شرح طويل.
- لا تكرر الأسئلة ولا تفتح بمقدمات مثل "بالتأكيد" أو "سأساعدك".
- ابدأ بالإجابة مباشرة، ثم إن لزم سطر واحد للتفصيل.
- إذا كان السؤال عن مبلغ متأخر أو قادم أو مدفوع، استخدم حقل totals المحسوب بدقة على الخادم واذكر النتيجة مباشرة دون إعادة الحساب.
- اعتمد على "now" في البيانات لتحديد الوقت الحالي، واحسب المدد والتواريخ (كم تبقى، كم مضى) من التاريخ الحالي الفعلي لا من أي تخمين.
- اذكر اسم العقار واسم المستأجر عند ذكر تفاصيل.
- إذا كانت البيانات لا تكفي للإجابة، اذكر ذلك بصراحة.
- لا تفصح عن أي معلومات لأي مستخدم آخر غير المستخدم أعلاه.
- إذا طلب إنشاء شيء منفصل عن متابعة العقود (كقصيدة أو وصفة أو برمجة)، اعتذر بلطف وذكّره أن مهمتك متابعة عقود الإيجار فقط، واعرض عليه المساعدة في استفسارات عقوده.

سياق المحادثة السابقة (آخر ${ASSIST_MAX_HISTORY} رسالة):
${history.length ? history.map((m) => (m.role === 'user' ? 'سؤال المستخدم: ' : 'إجابتك: ') + m.content).join('\n\n') : 'لا يوجد'}

سؤال المستخدم الحالي: ${question}`;

    const body = JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'أنت مساعد عقارات ذكي مختصر: أجيب مباشرة بجملة أو جملتين بالعربية، بأرقام واضحة، دون مقدمات أو شرح.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 1200,
      stream: isStream
    });

    const options = {
      hostname: 'api.deepseek.com',
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + DEEPSEEK_API_KEY,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 90000
    };

    function saveToHistory(answerText) {
      if (!sess) return;
      sess.history = sess.history || [];
      sess.history.push({ role: 'user', content: question });
      sess.history.push({ role: 'assistant', content: answerText });
      if (sess.history.length > ASSIST_MAX_HISTORY) sess.history = sess.history.slice(-ASSIST_MAX_HISTORY);
    }

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      let ended = false;
      const send = (evt) => { if (ended) return; res.write(sseEvent(evt)); };
      const end = (evt) => { if (ended) return; ended = true; if (evt) res.write(sseEvent(evt)); res.end(); };
      let answer = '';
      const httpReq = https.request(options, (response) => {
        if (response.statusCode !== 200) {
          let d = '';
          response.on('data', (chunk) => d += chunk);
          response.on('end', () => {
            let msg = 'تعذر استدعاء الذكاء الاصطناعي';
            try { const j = JSON.parse(d); if (j.error && j.error.message) msg += ': ' + j.error.message; } catch (e) {}
            end({ error: msg });
          });
          return;
        }
        response.setEncoding('utf8');
        let buffer = '';
        response.on('data', (chunk) => {
          buffer += chunk;
          let nl;
          while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const j = JSON.parse(payload);
              const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
              if (delta) { answer += delta; send({ delta }); }
            } catch (e) {}
          }
        });
        response.on('end', () => {
          saveToHistory(answer.trim());
          end({ done: true });
        });
        response.on('error', (e) => end({ error: 'انقطع الاتصال بالذكاء الاصطناعي: ' + e.message }));
      });
      httpReq.on('error', (e) => end({ error: 'تعذر الاتصال بالذكاء الاصطناعي: ' + e.message }));
      httpReq.on('timeout', () => { httpReq.destroy(); end({ error: 'انتهت مهلة الذكاء الاصطناعي' }); });
      httpReq.write(body);
      httpReq.end();
      return;
    }

    const httpReq = https.request(options, (response) => {
      let data = '';
      response.on('data', (chunk) => data += chunk);
      response.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return res.status(502).json({ error: 'تعذر استدعاء الذكاء الاصطناعي: ' + json.error.message });
          const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
          if (!content) return res.status(502).json({ error: 'رد فارغ من الذكاء الاصطناعي' });
          saveToHistory(content.trim());
          res.json({ answer: content.trim() });
        } catch (e) {
          res.status(502).json({ error: 'فشل تحليل رد الذكاء الاصطناعي' });
        }
      });
    });
    httpReq.on('error', (e) => res.status(502).json({ error: 'تعذر الاتصال بالذكاء الاصطناعي: ' + e.message }));
    httpReq.on('timeout', () => { httpReq.destroy(); res.status(502).json({ error: 'انتهت مهلة الذكاء الاصطناعي' }); });
    httpReq.write(body);
    httpReq.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر تجهيز بيانات المساعد' });
  }
});

// --- إعدادات التنبيهات (مخزنة في Realtime Database) ---
app.get('/api/settings', requireAuth, async (req, res) => {
  try {
    const snap = await settingsRef.child(req.user).once('value');
    const data = snap.val() || {};
    res.json({
      paymentAlertDays: Number(data.paymentAlertDays) || 7,
      endAlertDays: Number(data.endAlertDays) || 30,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر جلب الإعدادات' });
  }
});

app.put('/api/settings', requireAuth, async (req, res) => {
  const { paymentAlertDays, endAlertDays } = req.body;
  try {
    await settingsRef.child(req.user).set({
      paymentAlertDays: Number(paymentAlertDays) || 7,
      endAlertDays: Number(endAlertDays) || 30,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر حفظ الإعدادات' });
  }
});

function callDeepSeek(text) {
  return new Promise((resolve, reject) => {
    if(!DEEPSEEK_API_KEY){ reject(new Error('DEEPSEEK_API_KEY غير مضبوط — أضفه في متغيرات البيئة')); return; }
    const prompt = `استخرج بيانات عقد الإيجار هذا وأرجع JSON فقط

الحقول المطلوبة:
- propertyName: اسم العقار (نص)
- tenantName: اسم المستأجر (نص)
- tenantPhone: رقم جوال المستأجر (نص)
- tenantRepresentative: مندوب المستأجر أو الممثل (نص)
- startDate: تاريخ بداية العقد (YYYY-MM-DD)
- endDate: تاريخ نهاية العقد (YYYY-MM-DD)
- totalValue: قيمة العقد الإجمالية بالأرقام فقط
- vatInclusive: هل القيمة شامل الضريبة؟ (true/false)
- vatRate: نسبة الضريبة بالأرقام (مثلاً 15)
- payments: مصفوفة من الدفعات، كل دفعة فيها:
  - label: اسم الدفعة أو رقمها
  - date: تاريخ استحقاق الدفعة (YYYY-MM-DD)
  - amount: مبلغ الدفعة بالأرقام
  - status: الحالة (paid أو unpaid)

ملاحظات مهمة:
- إذا العقد يذكر ضريبة 15% فـ vatInclusive = true
- إذا العقد لا يذكر ضريبة فـ vatInclusive = false
- استخرج كل الدفعات الموجودة في العقد بمواعيدها
- إذا ما في دفعات محددة، اجعل payments مصفوفة فاضية

العقد:
${text}`;

    const body = JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 4096
    });

    const options = {
      hostname: 'api.deepseek.com',
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + DEEPSEEK_API_KEY,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 30000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message));
          const content = json.choices[0].message.content;
          const clean = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          const result = JSON.parse(clean);
          // تحويل رقم الهاتف: +9665xxxxxxx → 05xxxxxxxx
          let phone = (result.tenantPhone || '').replace(/[^0-9+]/g, '');
          if (phone.startsWith('+966')) phone = '0' + phone.slice(4);
          else if (phone.startsWith('966') && phone.length > 3) phone = '0' + phone.slice(3);

          resolve({
            propertyName: result.propertyName || '',
            tenantName: result.tenantName || '',
            tenantPhone: phone,
            tenantRepresentative: result.tenantRepresentative || '',
            startDate: result.startDate || '',
            endDate: result.endDate || '',
            totalValue: parseFloat(result.totalValue) || 0,
            hasTax: result.vatInclusive !== undefined ? result.vatInclusive : (result.hasTax !== undefined ? result.hasTax : true),
            taxRate: parseFloat(result.vatRate || result.taxRate) || 15,
            payments: (result.payments || []).map(p => ({
              label: p.label || 'دفعة',
              date: p.date || '',
              status: p.status || 'unpaid',
              amount: parseFloat(p.amount) || 0
            }))
          });
        } catch (e) {
          reject(new Error('فشل تحليل رد الذكاء الاصطناعي'));
        }
      });
    });

    req.on('error', (e) => reject(new Error(e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('انتهت المهلة')); });
    req.write(body);
    req.end();
  });
}

app.listen(PORT, () => {
  console.log(`✅ الخادم يعمل على http://localhost:${PORT}`);
  console.log('☁️ قاعدة البيانات: Firebase Realtime Database (سحابية مشتركة)');
});
