const http = require('http');
const { exec } = require('child_process');

function checkAlerts() {
  http.get('http://localhost:3000/api/contracts', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const contracts = JSON.parse(data);
        const today = new Date().toISOString().split('T')[0];
        let overdue = 0, dueSoon = 0, ending = 0;

        contracts.forEach(c => {
          if (c.endDate) {
            const diff = Math.ceil((new Date(c.endDate) - new Date(today)) / (1000 * 60 * 60 * 24));
            if (diff >= 0 && diff <= 30) ending++;
          }
          (c.payments || []).forEach(p => {
            if (p.status !== 'paid') {
              const diff = Math.ceil((new Date(p.date) - new Date(today)) / (1000 * 60 * 60 * 24));
              if (diff < 0) overdue++;
              else if (diff <= 7) dueSoon++;
            }
          });
        });

        let lines = [];
        if (overdue > 0) lines.push(overdue + ' دفعات متأخرة');
        if (dueSoon > 0) lines.push(dueSoon + ' دفعات مستحقة قريبًا');
        if (ending > 0) lines.push(ending + ' عقود تقترب من الانتهاء');

        if (lines.length > 0) {
          const body = lines.join(' | ');
          const cmd = `powershell -Command "New-BurntToastNotification -Text 'تنبيه العقود','${body.replace(/'/g, "''")}'"`;
          exec(cmd);
          console.log('[' + new Date().toLocaleTimeString() + '] تم إرسال تنبيه: ' + body);
        } else {
          console.log('[' + new Date().toLocaleTimeString() + '] لا يوجد تنبيهات');
        }
      } catch (e) {
        console.log('[' + new Date().toLocaleTimeString() + '] خطأ: ' + e.message);
      }
    });
  }).on('error', () => {
    console.log('[' + new Date().toLocaleTimeString() + '] تعذر الاتصال بالخادم');
  });
}

console.log('مراقب التنبيهات يعمل...');
checkAlerts();
setInterval(checkAlerts, 60 * 60 * 1000);
