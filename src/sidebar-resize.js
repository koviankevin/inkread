import './sidebar-resize.css';

export function setupSidebarResize({preference,beforeChange,onChange}) {
  const sidebar=document.getElementById('sidebar'),handle=document.getElementById('sidebar-resize');
  const mobile=matchMedia('(max-width:720px)');
  const stored=Number(preference('sidebar-width'));
  let preferred=Number.isFinite(stored) && stored>=220 && stored<=480 ? stored : null;
  let drag,frame=0,pending;
  const maximum=()=>Math.min(480,innerWidth-420);
  function sync() {
    if(mobile.matches){sidebar.classList.remove('sidebar-resized');return;}
    const width=sidebar.getBoundingClientRect().width;
    if(!width)return;
    handle.style.left=`${width-24}px`;
    handle.setAttribute('aria-valuemin','220');
    handle.setAttribute('aria-valuemax',String(maximum()));
    handle.setAttribute('aria-valuenow',String(Math.round(width)));
    handle.setAttribute('aria-valuetext',`${Math.round(width)} 像素`);
  }
  function apply() {
    if(mobile.matches){sync();return;}
    beforeChange();
    sidebar.classList.toggle('sidebar-resized',preferred!==null);
    if(preferred!==null)sidebar.style.setProperty('--sidebar-width',`${Math.min(preferred,maximum())}px`);
    sync();onChange();
  }
  function flush() {
    cancelAnimationFrame(frame);frame=0;
    if(pending===undefined)return;
    preferred=Math.max(220,Math.min(maximum(),pending));pending=undefined;apply();
  }
  function finish(event) {
    if(!drag || event && event.pointerId!==drag.id)return;
    flush();const id=drag.id;drag=undefined;
    document.body.classList.remove('sidebar-resizing');
    if(handle.hasPointerCapture(id))handle.releasePointerCapture(id);
    if(preferred!==null)preference('sidebar-width',String(preferred));
  }
  handle.addEventListener('pointerdown',event=>{
    if(event.button!==0 || !event.isPrimary || mobile.matches || drag)return;
    event.preventDefault();handle.focus({preventScroll:true});beforeChange();
    drag={id:event.pointerId,x:event.clientX,width:sidebar.getBoundingClientRect().width};
    handle.setPointerCapture(event.pointerId);document.body.classList.add('sidebar-resizing');
  });
  handle.addEventListener('pointermove',event=>{
    if(!drag || event.pointerId!==drag.id)return;
    pending=drag.width+event.clientX-drag.x;
    if(!frame)frame=requestAnimationFrame(flush);
  });
  for(const type of ['pointerup','pointercancel','lostpointercapture'])handle.addEventListener(type,finish);
  handle.addEventListener('keydown',event=>{
    if(mobile.matches || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();
    const width=sidebar.getBoundingClientRect().width;
    pending=event.key==='Home'?220:event.key==='End'?maximum():width+(event.key==='ArrowRight'?16:-16);
    flush();preference('sidebar-width',String(preferred));
  });
  window.addEventListener('resize',()=>{finish();apply();});
  window.addEventListener('blur',()=>finish());
  new ResizeObserver(sync).observe(sidebar);
  apply();
}
