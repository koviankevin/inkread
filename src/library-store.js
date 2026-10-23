import {MAX_DOCUMENTS,MAX_IMPORT_FILES} from './limits.js';

export const newRevision = () => `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(2)).join('-')}`;

// Documents, image Blobs, and progress live separately from the worker's app cache.
export function createLibraryStore(onClear=()=>{}) {
  const scope = new URL('./',location.href).href;
  const name = `inkread-library:${scope}`;
  const checkpointKey = `${name}:checkpoint`;
  const positionKey = (generation,path) => `${checkpointKey}:${generation}:${encodeURIComponent(path)}`;
  let connection, epoch, queue = Promise.resolve(), channel;
  function checkpointKeys() {
    try { return Object.keys(localStorage).filter(key=>key.startsWith(`${checkpointKey}:`)); }
    catch { return []; }
  }
  function discardCheckpoints(keys) {
    try {
      localStorage.removeItem(checkpointKey);
      // Captured before replacement: a new generation's keys cannot be removed
      // if another tab already loaded and checkpointed the replacement.
      for (const key of keys) localStorage.removeItem(key);
    } catch { /* Optional shutdown checkpoints. */ }
  }
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
  function mutate(action,{reset=false,expectedRevision}={}) {
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
          const apply=()=>{
            try {
              action(tx);
              tx.objectStore('meta').put(newRevision(),'revision');
            } catch(error) {
              failure=error;
              try { tx.abort(); } catch { /* Already aborted; onabort still reports the failure. */ }
            }
          };
          if (expectedRevision===undefined) apply();
          else {
            const revision=tx.objectStore('meta').get('revision');
            revision.onsuccess=()=>{
              if ((revision.result ?? null)!==expectedRevision) {
                failure=new Error('Library changed during restore preview'); failure.code='LIBRARY_CHANGED'; tx.abort();
              } else apply();
            };
          }
        };
      });
    });
  }
  return {
    async load() {
      const previousEpoch=epoch;
      const db = await open();
      const tx=db.transaction(['documents','assets','positions','meta'],'readonly');
      const [documents,assets,positions,current,generation,revision] = await Promise.all([
        requestValue(tx.objectStore('documents').getAll(undefined,MAX_DOCUMENTS+1)),
        requestValue(tx.objectStore('assets').getAll(undefined,MAX_IMPORT_FILES+1)),
        requestValue(tx.objectStore('positions').getAll(undefined,MAX_DOCUMENTS+1)),
        requestValue(tx.objectStore('meta').get('current')),
        requestValue(tx.objectStore('meta').get('epoch')),
        requestValue(tx.objectStore('meta').get('revision')),
      ]);
      if (epoch===previousEpoch) epoch=generation;
      let checkpoint;
      try { checkpoint=JSON.parse(localStorage.getItem(checkpointKey)); } catch { /* Optional shutdown checkpoint. */ }
      if (checkpoint?.epoch !== epoch) checkpoint=undefined;
      // Each document has its own synchronous shutdown slot. A single shared
      // slot loses all but one tab when pending IDB writes are aborted on exit.
      // Append candidates so existing validation can reject corrupt/stale rows
      // without hiding a valid committed position. Work is bounded by documents.
      for (const doc of documents) {
        if (typeof doc.path!=='string') continue;
        try {
          const saved=JSON.parse(localStorage.getItem(positionKey(epoch,doc.path)));
          if (saved?.epoch===epoch && saved.position?.path===doc.path) positions.push(saved.position);
        } catch { /* A malformed optional checkpoint must not prevent loading. */ }
      }
      return {documents,assets,positions,current,checkpoint,revision:revision ?? null};
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
      if (position && typeof epoch==='string') {
        try { localStorage.setItem(positionKey(epoch,position.path),JSON.stringify({epoch,position})); }
        catch { /* IDB and the legacy selection checkpoint remain independent. */ }
      }
      try { localStorage.setItem(checkpointKey,JSON.stringify({epoch,current,position})); } catch { /* IDB still saves periodically. */ }
    },
    async replace({documents,assets,positions,current},expectedRevision) {
      const next=newRevision(),obsolete=checkpointKeys();
      // Clearing and all replacement records commit together, or all roll back.
      await mutate(tx=>{
        for (const store of ['documents','assets','positions','meta']) tx.objectStore(store).clear();
        for (const [name,rows] of [['documents',documents],['assets',assets],['positions',positions]]) for (const row of rows) tx.objectStore(name).put(row);
        tx.objectStore('meta').put(next,'epoch');
        tx.objectStore('meta').put(current,'current');
      },{expectedRevision});
      epoch=next;
      discardCheckpoints(obsolete);
      channel?.postMessage({type:'clear',epoch});
    },
    async clear() {
      const next = newRevision(),obsolete=checkpointKeys();
      await mutate(tx=>{
        for (const store of ['documents','assets','positions','meta']) tx.objectStore(store).clear();
        tx.objectStore('meta').put(next,'epoch');
      },{reset:true});
      epoch=next;
      discardCheckpoints(obsolete);
      channel?.postMessage({type:'clear',epoch});
    },
  };
}
