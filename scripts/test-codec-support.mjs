import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const r = await page.evaluate(() => ({
  mse: typeof MediaSource !== 'undefined',
  c1: MediaSource.isTypeSupported('video/mp4; codecs="avc1.42c015"'),
  c2: MediaSource.isTypeSupported('video/mp4; codecs="avc1.64001f"'),
  c3: MediaSource.isTypeSupported('video/mp4; codecs="mp4a.40.2,avc1.42c015"'),
  c4: MediaSource.isTypeSupported('video/mp2t; codecs="avc1.42c015,mp4a.40.2"'),
}));
console.log(r);
await browser.close();
