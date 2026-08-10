// سكربت استرجاع بيانات حساب المدير المنسية
// التشغيل: node recover-admin.js
// يعرض اسم مستخدم المدير وكلمة مروره كما هي مخزنة في Firebase (تُخزَّن نصيةً)
const path = require('path');
const admin = require('firebase-admin');

const sa = require(path.join(__dirname, 'serviceAccountKey.json'));
admin.initializeApp({
  credential: admin.credential.cert(sa),
  databaseURL: 'https://alqaih-default-rtdb.europe-west1.firebasedatabase.app'
});

admin.database().ref('admin').once('value').then((snap) => {
  const data = snap.val();
  if (!data || !data.username) {
    console.log('لا يوجد حساب مدير مسجل بعد.');
    process.exit(0);
  }
  console.log('======================================');
  console.log(' اسم المستخدم: ' + data.username);
  console.log(' كلمة المرور: ' + (data.passPlain || '(غير مخزنة نصياً)'));
  console.log(' تاريخ الإنشاء: ' + new Date(data.createdAt || 0).toLocaleString('ar-SA'));
  console.log('======================================');
  process.exit(0);
}).catch((err) => {
  console.error('تعذر الاتصال بالقاعدة: ' + err.message);
  process.exit(1);
});
