import katex from 'katex';
import 'katex/dist/katex.min.css';
import {registerVendor} from './vendor-loader.js';
registerVendor('math',katex);
