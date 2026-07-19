import { chromium } from 'playwright';

const hlsResolve = await (
  await fetch('http://127.0.0.1:8788/movies111/resolve?type=movie&id=533535&prefer=hls')
).json();
console.log('resolve', hlsResolve.type, hlsResolve.plug);

let browser;
try {
  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
  });
} catch {
  console.log('system chrome unavailable');
  process.exit(5);
}

const page = await browser.newPage();
const codec = await page.evaluate(() =>
  MediaSource.isTypeSupported('video/mp4; codecs="avc1.42c015"')
);
console.log('chrome h264', codec);

await page.addScriptTag({
  url: 'https://cdn.jsdelivr.net/npm/hls.js@1.6.16/dist/hls.min.js',
});
await page.setContent(`
  <video id="v" controls autoplay muted playsinline></video>
`);
await page.addScriptTag({
  url: 'https://cdn.jsdelivr.net/npm/hls.js@1.6.16/dist/hls.min.js',
});

const result = await page.evaluate(async (src) => {
  const v = document.getElementById('v');
  const log = [];
  const hls = new window.Hls();
  await new Promise((resolve) => {
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      log.push('manifest');
      v.play().catch(() => {});
    });
    hls.on(window.Hls.Events.FRAG_LOADED, () => {
      log.push('frag');
      resolve();
    });
    hls.on(window.Hls.Events.ERROR, (_e, data) => {
      log.push('err:' + data.details + (data.fatal ? ':fatal' : ''));
      if (data.fatal) resolve();
    });
    hls.loadSource(src);
    hls.attachMedia(v);
    setTimeout(() => resolve(), 60000);
  });
  return { log, ready: v.readyState, w: v.videoWidth };
}, hlsResolve.masterUrl);

console.log(result);
await browser.close();
process.exit(result.ready >= 2 || result.log.includes('frag') || result.w > 0 ? 0 : 2);
