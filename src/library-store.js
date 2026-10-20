import {MAX_DOCUMENTS,MAX_IMPORT_FILES} from './limits.js';

export const newRevision = () => `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(2)).join('-')}`;

// Documents, image Blobs, and progress live separately from the worker's app cache.
export function createLibraryStore(onClear=()=>{}) {
  const scope = new URL('./',location.href).href;
  const name = `inkread-library:${scope}`;
  const checkpointKey = `${name}:checkpoint`;
  let connection, epoch, queue = Promise.resolve(), channel;
  try {
    channel = new BroadcastChannel(name);
    channel.onmessage = event => {
      if (event.data?.type === 'clear' && typeof event.data.epoch === 'string' && epoch !== event.data.epoch) {
        epoch = event.data.epoch; onClear();
      }
    };
  } catch { /* IndexedDB remains usable when BroadcastChannel is unavailable. */ }
  function open() {
    if (connection) return connection;
    connection = new Promise((resolve,reject)=>{
      let settled = false;
      const fail = error => { if (!settled) { settled=true; clearTimeout(timer); reject(error); } };
      const timer = setTimeout(()=>fail(new Error('Storage unavailable')),5000);
      let request;
      try { request = indexedDB.open(name,1); } catch (error) { fail(error); return; }
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const store of ['documents','assets','positions']) db.createObjectStore(store,{keyPath:'path'});
        db.createObjectStore('meta').put(newRevision(),'epoch');
      };
      request.onerror = () => fail(request.error);
      request.onblocked = () => fail(new Error('Storage blocked by another tab'));
      request.onsuccess = () => {
        const db = request.result;
        if (settled) { db.close(); return; }
        settled=true; clearTimeout(timer);
        db.onversionchange = () => { db.close(); connection=undefined; };
        resolve(db);
      };
    }).catch(error=>{ connection=undefined; throw error; });
    return connection;
  }
  const requestValue = request => new Promise((resolve,reject)=>{ request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error); });
  const enqueue = action => { const pending=queue.then(action); queue=pending.catch(()=>{}); return pending; };
  function mutate(action,{reset=false}={}) {
    const expected = epoch;
    return enqueue(async()=>{
      const db = await open();
      return new Promise((resolve,reject)=>{
        const tx = db.transaction(['documents','assets','positions','meta'],'readwrite',{durability:'strict'});
        let failure;
        tx.oncomplete=()=>resolve();
        tx.onabort=()=>reject(failure || tx.error || new Error('Storage transaction aborted'));
        const request=tx.objectStore('meta').get('epoch');
        request.onsuccess=()=>{
          if (!reset && request.result !== expected) {
            epoch=request.result; failure=new Error('Library cleared in another tab'); failure.code='LIBRARY_CLEARED';
            tx.abort(); onClear(); return;
          }
          try { action(tx); } catch(error) { failure=error; tx.abort(); }
        };
      });
    });
  }
  return {
    async load() {
      const previousEpoch=epoch;
      const db = await open();
      const tx=db.transaction(['documents','assets','positions','meta'],'readonly');
      const [documents,assets,positions,current,generation] = await Promise.all([
        requestValue(tx.objectStore('documents').getAll(undefined,MAX_DOCUMENTS+1)),
        requestValue(tx.objectStore('assets').getAll(undefined,MAX_IMPORT_FILES+1)),
        requestValue(tx.objectStore('positions').getAll(undefined,MAX_DOCUMENTS+1)),
        requestValue(tx.objectStore('meta').get('current')),
        requestValue(tx.objectStore('meta').get('epoch')),
      ]);
      if (epoch===previousEpoch) epoch=generation;
      let checkpoint;
      try { checkpoint=JSON.parse(localStorage.getItem(checkpointKey)); } catch { /* Optional shutdown checkpoint. */ }
      if (checkpoint?.epoch !== epoch) checkpoint=undefined;
      return {documents,assets,positions,current,checkpoint};
    },
    write({documents=[],assets=[],positions=[],current}) {
      return mutate(tx=>{
        for (const doc of documents) tx.objectStore('documents').put(doc);
        for (const asset of assets) tx.objectStore('assets').put(asset);
        for (const position of positions) {
          const request=tx.objectStore('documents').get(position.path);
          request.onsuccess=()=>{
            // An older tab cannot attach old progress to newly imported content.
            if (request.result?.revision === position.revision) tx.objectStore('positions').put(position);
          };
        }
        if (current !== undefined) tx.objectStore('meta').put(current,'current');
      });
    },
    checkpoint(current,position) {
      try { localStorage.setItem(checkpointKey,JSON.stringify({epoch,current,position})); } catch { /* IDB still saves periodically. */ }
    },
    async clear() {
      const next = newRevision();
      await mutate(tx=>{
        for (const store of ['documents','assets','positions','meta']) tx.objectStore(store).clear();
        tx.objectStore('meta').put(next,'epoch');
      },{reset:true});
      epoch=next;
      try { localStorage.removeItem(checkpointKey); } catch { /* No checkpoint to clear. */ }
      channel?.postMessage({type:'clear',epoch});
    },
  };
}
