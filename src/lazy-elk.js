import {loadVendor} from './vendor-loader.js';
// Mermaid 12.2 calls only the asynchronous layout API of a fresh ELK instance.
export default class LazyELK {
  constructor(options) { this.options = options; }
  async layout(...args) {
    const ELK = await loadVendor('elk');
    this.instance ??= new ELK(this.options);
    return this.instance.layout(...args);
  }
}
