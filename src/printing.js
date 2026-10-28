function waitFor(work,signal,timeout) {
  return new Promise((resolve,reject)=>{
    let timer;
    const finish=(done,value)=>{clearTimeout(timer);signal.removeEventListener('abort',abort);done(value);};
    const abort=()=>finish(reject,signal.reason);
    if(signal.aborted){reject(signal.reason);return;}
    signal.addEventListener('abort',abort,{once:true});
    if(timeout)timer=setTimeout(()=>finish(resolve),timeout);
    Promise.resolve(work).then(value=>finish(resolve,value),error=>finish(reject,error));
  });
}

export function setupPrinting({button,status,content,prepareFeatures,onError}) {
  let attempt;
  button.addEventListener('click',async()=>{
    if(attempt)return;
    const controller=new AbortController(),{signal}=controller;
    attempt=controller;
    const label=button.getAttribute('aria-label'),title=button.title;
    button.disabled=true;
    button.setAttribute('aria-busy','true');
    button.setAttribute('aria-label','正在準備列印');
    button.title='正在準備列印';
    const notice=setTimeout(()=>{status.hidden=false;status.textContent='正在準備列印，載入圖片、圖表與公式…';},250);
    try {
      // Start image downloads/decoding before awaiting optional renderers.
      const images=Promise.allSettled([...content.querySelectorAll('img')].map(img=>{img.loading='eager';return img.decode();}));
      // Plain text must not join the shared queue of an older diagram render.
      if(content.querySelector('[data-diagram-index],[data-math-index]'))await waitFor(prepareFeatures(),signal);
      // Retain the existing five-second image grace period after rendering.
      await waitFor(images,signal,5000);
      await waitFor(document.fonts.ready,signal);
      if(!signal.aborted)window.print();
    } catch(error) {
      if(!signal.aborted)onError(error);
    } finally {
      clearTimeout(notice);status.hidden=true;
      button.disabled=false;button.removeAttribute('aria-busy');
      button.setAttribute('aria-label',label);button.title=title;
      attempt=undefined;
    }
  });
  return {cancel:()=>attempt?.abort()};
}
