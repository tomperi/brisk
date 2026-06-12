// The worker serves the built SDK at /brisk.js from its static assets.
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('../worker/assets', { recursive: true });
copyFileSync('dist/brisk.js', '../worker/assets/brisk.js');
console.log('sdk → worker/assets/brisk.js');
