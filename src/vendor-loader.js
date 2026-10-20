// Classic scripts work both over HTTPS and when index.html is opened with file://.
const key = Symbol.for('inkread.vendors');
if (!globalThis[key]) Object.defineProperty(globalThis,key,{value:{values:new Map(),pending:new Map()}});
const registry = globalThis[key];
const base = document.currentScript?.src || new URL('./app.js',document.baseURI).href;
const files = {math:'math.js',diagrams:'diagrams.js',elk:'elk.js'};

export function registerVendor(name,value) { registry.values.set(name,value); }
export function getLoadedVendor(name) {
  if (!registry.values.has(name)) throw new Error(`Feature not loaded: ${name}`);
  return registry.values.get(name);
}
export function loadVendor(name) {
  if (!Object.hasOwn(files,name)) return Promise.reject(new Error('Unknown feature'));
  if (registry.pending.has(name)) return registry.pending.get(name);
  if (registry.values.has(name)) return Promise.resolve(registry.values.get(name));
  const promise = new Promise((resolve,reject) => {
    const script = document.createElement('script');
    let stylesheet;
    let scriptReady = false, styleReady = name !== 'math';
    const fail = () => {
      registry.pending.delete(name);
      registry.values.delete(name);
      script.remove(); stylesheet?.remove();
      reject(new Error('Feature files could not be loaded'));
    };
    const finish = () => {
      if (!scriptReady || !styleReady) return;
      try { resolve(getLoadedVendor(name)); } catch { fail(); }
    };
    if (name === 'math') {
      stylesheet = document.createElement('link');
      stylesheet.rel = 'stylesheet';
      stylesheet.href = new URL('./math.css',base).href;
      stylesheet.onload = () => { styleReady = true; finish(); };
      stylesheet.onerror = fail;
      document.head.append(stylesheet);
    }
    script.src = new URL(files[name],base).href;
    script.async = true;
    script.onload = () => { scriptReady = true; finish(); };
    script.onerror = fail;
    document.head.append(script);
  });
  registry.pending.set(name,promise);
  return promise;
}
