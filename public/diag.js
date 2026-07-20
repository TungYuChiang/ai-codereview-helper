// 診斷模式：只在網址帶 ?diag=1 時載入。
// 目的是抓「瀏覽器凍住 / 分頁死掉」這種 console 會一起消失的狀況，
// 所以每筆記錄都立刻送回 server 寫進檔案，而不是留在記憶體裡。
(() => {
  const send = (payload) => {
    try {
      const body = JSON.stringify({ t: Date.now(), ...payload });
      // sendBeacon 在分頁被砍掉時仍會盡力送出
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/diag', new Blob([body], { type: 'application/json' }));
      } else {
        fetch('/api/diag', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true });
      }
    } catch (_) { /* 診斷本身絕不能拖垮頁面 */ }
  };

  send({ kind: 'session-start', ua: navigator.userAgent, url: location.href });

  // 最近一次使用者動作。凍住時這就是「當下在做什麼」。
  document.addEventListener('click', (e) => {
    const el = e.target;
    send({
      kind: 'click',
      tag: el.tagName,
      cls: (el.className || '').toString().slice(0, 80),
      key: el.closest('[data-key]') ? el.closest('[data-key]').dataset.key : null,
      text: (el.textContent || '').trim().slice(0, 40)
    });
  }, true);

  document.addEventListener('keydown', (e) => {
    send({ kind: 'key', key: e.key, target: e.target.tagName });
  }, true);

  // 主執行緒被卡住多久
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration >= 150) send({ kind: 'longtask', ms: Math.round(entry.duration) });
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch (_) {}

  // 心跳：如果記錄突然中斷，最後一筆心跳就是凍住的時間點
  setInterval(() => {
    send({
      kind: 'heartbeat',
      mem: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      els: document.querySelectorAll('*').length,
      cps: document.querySelectorAll('.changepoint').length
    });
  }, 2000);

  window.addEventListener('error', (e) => send({ kind: 'error', msg: String(e.message), src: e.filename, line: e.lineno }));
  window.addEventListener('unhandledrejection', (e) => send({ kind: 'rejection', msg: String(e.reason && e.reason.message || e.reason) }));
})();
