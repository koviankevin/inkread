import './accessibility.css';

export function labelReadingContent(container) {
  for (const input of container.querySelectorAll('.task-list-item-checkbox')) {
    input.setAttribute('aria-label',input.closest('li')?.textContent.trim() || '待辦事項');
  }
  for (const pre of container.querySelectorAll('.code-block pre')) {
    pre.tabIndex=0;
    pre.setAttribute('role','region');
    pre.setAttribute('aria-label','程式碼，可使用方向鍵捲動');
  }
}

export function setupAccessibleNavigation({onLayout,openFile,preference}) {
  const $=id=>document.getElementById(id),body=document.body;
  const mobile=matchMedia('(max-width:720px)'),narrow=matchMedia('(max-width:1000px)');
  const sidebar=$('sidebar'),toc=$('toc'),workspace=document.querySelector('.workspace');
  const visible=el=>el?.isConnected && !el.closest('[inert]') && !!el.getClientRects().length;
  const focus=el=>{if(visible(el))el.focus({preventScroll:true});};
  const focusables=root=>[...root.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex]')].filter(el=>!el.disabled && el.tabIndex>=0 && visible(el));
  const sideOpen=()=>mobile.matches && body.classList.contains('sidebar-mobile-open');
  const tocOpen=()=>narrow.matches && body.classList.contains('toc-open');
  function sync() {
    $('sidebar-toggle').setAttribute('aria-expanded',String(mobile.matches ? sideOpen() : !body.classList.contains('sidebar-collapsed')));
    $('toc-toggle').setAttribute('aria-expanded',String(narrow.matches ? tocOpen() : !body.classList.contains('toc-hidden')));
    workspace.inert=sideOpen();
    sidebar.inert=mobile.matches && !sideOpen();
    if(sideOpen()){sidebar.setAttribute('role','dialog');sidebar.setAttribute('aria-modal','true');}
    else {sidebar.setAttribute('role','complementary');sidebar.removeAttribute('aria-modal');}
    requestAnimationFrame(onLayout);
  }
  function closeSidebar(restore=true) {
    const owned=sidebar.contains(document.activeElement);
    body.classList.remove('sidebar-mobile-open');sync();
    if(restore && owned)focus($('sidebar-toggle'));
  }
  function closeToc(restore=true) {
    const owned=toc.contains(document.activeElement);
    body.classList.remove('toc-open');sync();
    if(restore && owned)focus($('toc-toggle'));
  }
  $('sidebar-toggle').addEventListener('click',()=>{
    if(mobile.matches){closeToc(false);body.classList.toggle('sidebar-mobile-open');}
    else body.classList.toggle('sidebar-collapsed');
    sync();if(sideOpen())focus($('sidebar-close'));
  });
  $('sidebar-close').addEventListener('click',()=>closeSidebar());
  $('toc-toggle').addEventListener('click',()=>{
    if(narrow.matches)body.classList.toggle('toc-open');else body.classList.toggle('toc-hidden');
    sync();if(tocOpen())focus(toc.querySelector('a') || $('toc-close'));
  });
  $('toc-close').addEventListener('click',()=>closeToc());
  document.addEventListener('click',event=>{
    if(sideOpen() && !sidebar.contains(event.target) && !$('sidebar-toggle').contains(event.target))closeSidebar();
    if(tocOpen() && !toc.contains(event.target) && !$('toc-toggle').contains(event.target))closeToc();
  });
  toc.addEventListener('focusout',()=>queueMicrotask(()=>{
    if(tocOpen() && !toc.contains(document.activeElement) && document.activeElement!==$('toc-toggle'))closeToc(false);
  }));
  function breakpoint() {
    const fromSidebar=sidebar.contains(document.activeElement),fromToc=toc.contains(document.activeElement);
    body.classList.remove('sidebar-mobile-open','toc-open');sync();
    if(fromSidebar && !visible(document.activeElement))focus($('sidebar-toggle'));
    if(fromToc && !visible(document.activeElement))focus($('toc-toggle'));
  }
  mobile.addEventListener('change',breakpoint);narrow.addEventListener('change',breakpoint);
  const shortcuts=$('character-shortcuts');shortcuts.checked=preference('character-shortcuts')!=='off';
  shortcuts.addEventListener('change',()=>preference('character-shortcuts',shortcuts.checked ? 'on' : 'off'));
  document.addEventListener('keydown',event=>{
    if(event.defaultPrevented || document.querySelector('dialog[open]'))return;
    if(event.key==='Escape'){
      if(sideOpen()){event.preventDefault();closeSidebar();}
      if(tocOpen()){event.preventDefault();closeToc();}
      return;
    }
    if(event.key==='Tab' && sideOpen()){
      const items=focusables(sidebar),first=items[0],last=items.at(-1),active=document.activeElement;
      if(!sidebar.contains(active) || event.shiftKey && active===first || !event.shiftKey && active===last){event.preventDefault();focus(event.shiftKey ? last : first);}
      return;
    }
    if(!shortcuts.checked || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.target.closest('input,textarea,select,[contenteditable]:not([contenteditable=false])'))return;
    if(event.key.toLowerCase()==='o'){event.preventDefault();openFile();}
    if(event.key==='/'){
      event.preventDefault();closeToc(false);
      if(mobile.matches)body.classList.add('sidebar-mobile-open');else body.classList.remove('sidebar-collapsed');
      sync();focus($('file-search'));
    }
  });
  // A native modal takes over from the mobile drawer. Return to its visible
  // toggle if the original invoking button is now in the closed drawer.
  for(const dialog of document.querySelectorAll('dialog')){
    new MutationObserver(()=>{if(dialog.open && sideOpen())closeSidebar(false);}).observe(dialog,{attributes:true,attributeFilter:['open']});
    dialog.addEventListener('close',()=>{
      if(document.querySelector('dialog[open]'))return;
      if(!visible(document.activeElement) || document.activeElement===body)focus($('sidebar-toggle'));
    });
  }
  sync();
  return {
    documentSelected(){closeSidebar(false);focus($('document'));},
    headingSelected(heading){closeToc(false);heading.tabIndex=-1;focus(heading);},
  };
}
