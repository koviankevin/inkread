// The worker downloads feature files without executing the optional engines.
export function prepareOffline() {
  const status = document.getElementById('offline-status');
  const retry = document.getElementById('offline-retry');
  const show = (text,state,title='') => {
    status.textContent = text;
    status.dataset.state = state;
    status.title = title;
    retry.hidden = state !== 'error';
  };
  if (location.protocol === 'file:') { show('本機離線版','local'); return; }
  if (!isSecureContext || !('serviceWorker' in navigator)) {
    show('離線使用請下載網站 ZIP','unsupported'); return;
  }
  let registration, running = false, ready = false;
  const observed = new WeakSet();
  function ask(worker,type) {
    return new Promise((resolve,reject) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => { channel.port1.close(); reject(new Error('Offline status timed out')); },type === 'REPAIR_CACHE' ? 120000 : 10000);
      channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data); };
      worker.postMessage({type},[channel.port2]);
    });
  }
  async function refresh(failed=false) {
    const worker = navigator.serviceWorker.controller || registration?.active;
    if (worker?.state === 'activated') {
      try {
        const result = await ask(worker,'OFFLINE_STATUS');
        ready = result?.ready === true;
        if (ready) {
          show(registration?.waiting ? '可離線使用 · 更新已備妥' : '可離線使用（含圖表與公式）','ready',registration?.waiting ? '關閉所有墨閱分頁後再開啟，即會使用新版。' : '可斷網重新開啟此網址；文件與進度的保存狀態另列於旁邊。');
          return;
        }
      } catch { ready = false; }
    }
    const pending = registration?.installing || registration?.waiting || registration?.active?.state === 'activating';
    if (failed || !pending) show('離線準備未完成','error','請保持連線並按重試；也可下載離線網站 ZIP。');
    else show('正在下載離線功能…','preparing');
  }
  function watch(worker) {
    if (!worker || observed.has(worker)) return;
    observed.add(worker);
    worker.addEventListener('statechange',()=>{ void refresh(worker.state === 'redundant'); });
  }
  async function start() {
    if (running) return;
    running = true;
    if (!ready) show('正在下載離線功能…','preparing');
    try {
      registration = await navigator.serviceWorker.register('./sw.js',{scope:'./',updateViaCache:'none'});
      if (!observed.has(registration)) {
        observed.add(registration);
        registration.addEventListener('updatefound',()=>{ watch(registration.installing); void refresh(); });
      }
      watch(registration.installing);
      if (!registration.installing && registration.active) {
        const state = await ask(registration.active,'OFFLINE_STATUS');
        if (!state?.ready) await ask(registration.active,'REPAIR_CACHE');
      }
      await refresh();
    } catch { await refresh(true); }
    finally { running = false; }
  }
  retry.addEventListener('click',()=>{ void start(); });
  window.addEventListener('online',()=>{ if (!ready) void start(); });
  navigator.serviceWorker.addEventListener('controllerchange',()=>{ void refresh(); });
  // Keep the initial reading path ahead of the full offline download.
  const schedule = () => {
    if ('requestIdleCallback' in window) requestIdleCallback(()=>{ void start(); },{timeout:2000});
    else setTimeout(()=>{ void start(); },0);
  };
  if (document.readyState === 'complete') schedule();
  else window.addEventListener('load',schedule,{once:true});
}
