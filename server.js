const express = require('express');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const multer = require('multer');
const https = require('https');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'sk-a9e3ac1277034e26922d521ae1315da2';

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
async function getContractsFull() {
  const snap = await contractsRef.once('value');
  const data = snap.val() || {};
  const list = Object.entries(data).map(([id, c]) => ({
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
    payments: Object.values(c.payments || {}).map((p) => ({
      label: p.label || '',
      date: p.date || '',
      status: p.status || 'unpaid',
      amount: p.amount || 0,
    })),
  }));
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return list;
}

function newId() {
  return 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

// --- مسارات API ---

// جلب كل العقود
app.get('/api/contracts', async (req, res) => {
  try {
    res.json(await getContractsFull());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر جلب العقود' });
  }
});

async function insertContractFn(c, id) {
  await contractsRef.child(id).set({
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
    })),
  });
}

// إضافة عقد جديد
app.post('/api/contracts', async (req, res) => {
  const c = req.body;
  const id = newId();

  try {
    const existing = await getContractsFull();
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

    await insertContractFn(c, id);
    res.status(201).json({ id });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'تعذر إنشاء العقد' });
  }
});

// إضافة عقد جديد بدون فحص تكرار
app.post('/api/contracts/force', async (req, res) => {
  try {
    const id = newId();
    await insertContractFn(req.body, id);
    res.status(201).json({ id });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'تعذر إنشاء العقد' });
  }
});

// تحديث عقد
app.put('/api/contracts/:id', async (req, res) => {
  const id = req.params.id;
  const c = req.body;

  try {
    const ref = contractsRef.child(id);
    const exists = (await ref.once('value')).exists();
    if (!exists) return res.status(404).json({ error: 'العقد غير موجود' });

    await ref.set({
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
      })),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(404).json({ error: 'العقد غير موجود' });
  }
});

// تبديل حالة سداد دفعة واحدة
app.patch('/api/contracts/:id/payments/:index', async (req, res) => {
  const { id, index } = req.params;
  const { status } = req.body;
  try {
    const ref = contractsRef.child(id);
    const snap = await ref.once('value');
    if (!snap.exists()) return res.status(404).json({ error: 'الدفعة غير موجودة' });
    const c = snap.val();
    const payments = Object.values(c.payments || {}).map((p) => ({ ...p }));
    const target = payments[Number(index)];
    if (!target) return res.status(404).json({ error: 'الدفعة غير موجودة' });
    payments[Number(index)] = { ...target, status };
    await ref.update({ payments });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر تحديث الدفعة' });
  }
});

// حذف عقد
app.delete('/api/contracts/:id', async (req, res) => {
  const id = req.params.id;
  try {
    await contractsRef.child(id).remove();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذر حذف العقد' });
  }
});

// مسح ملف PDF واستخراج بيانات العقد عبر DeepSeek AI
app.post('/api/contracts/scan-pdf', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'لم يتم رفع ملف PDF' });
  try {
    const dataBuffer = fs.readFileSync(req.file.path);
    const pdfData = await pdfParse(dataBuffer);
    const text = pdfData.text || '';

    // محاولة الاستخراج بالذكاء الاصطناعي
    try {
      const extracted = await callDeepSeek(text);
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

// --- إعدادات التنبيهات (مخزنة في Realtime Database) ---
app.get('/api/settings', async (req, res) => {
  try {
    const snap = await settingsRef.once('value');
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

app.put('/api/settings', async (req, res) => {
  const { paymentAlertDays, endAlertDays } = req.body;
  try {
    await settingsRef.set({
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
