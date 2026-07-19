import { chromium } from 'playwright';

// Force fabric HLS by calling plugs manually is hard — temporarily hit resolve
// and if mp4, request fabric path via decrypt is complex. Use resolve and
// if mp4, also fetch fabric from local API by temporarily preferring hls.

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

// Use HLS master from fabric via our resolve after flipping preference locally:
// call m3u8 through proxy with a known working pattern from earlier top-level test.
const resolve = await (
  await fetch('http://127.0.0.1:8788/movies111/resolve?type=movie&id=533535')
).json();
console.log('resolve', resolve.type, resolve.plug);

// Build fabric HLS via stream API is server-side only. Toggle: hit moviebox was mp4.
// Fetch fabric by temporary endpoint simulation — use m3u8 proxy of primebox if we can get URL from decrypt in node.

const { spawnSync } = await import('child_process');
// Inline: ask movies111 resolve but we'll add ?prefer=hls
const hlsResolve = await (
  await fetch('http://127.0.0.1:8788/movies111/resolve?type=movie&id=533535&prefer=hls')
).json();
console.log('hlsResolve', hlsResolve.ok, hlsResolve.type, hlsResolve.plug, hlsResolve.error);

await page.addScriptTag({
  url: 'https://cdn.jsdelivr.net/npm/hls.js@1.6.16/dist/hls.min.js',
});
await page.setContent(`
  <video id="v" controls autoplay muted referrerpolicy="no-referrer"></video>
  <pre id="log"></pre>
`);
await page.addScriptTag({ url: 'https://cdn.jsdelivr.net/npm/hls.js@1.6.16/dist/hls.min.js' });

const src = hlsResolve.masterUrl || resolve.masterUrl;
const result = await page.evaluate(async (src) => {
  const v = document.getElementById('v');
  const log = [];
  const push = (m) => log.push(m);
  if (window.Hls && window.Hls.isSupported() && /m3u8|hls/i.test(src)) {
    const hls = new window.Hls();
    hls.loadSource(src);
    hls.attachMedia(v);
    await new Promise((resolve) => {
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        push('manifest');
        v.play().catch(() => {});
        resolve();
      });
      hls.on(window.Hls.Events.ERROR, (_e, data) => {
        push('hlserr ' + data.details);
        if (data.fatal) resolve();
      });
      setTimeout(() => resolve(), 10000);
    });
  } else {
    v.src = src;
    await new Promise((resolve) => {
      v.addEventListener('loadedmetadata', () => {
        push('meta ' + v.videoWidth);
        resolve();
      });
      v.addEventListener('error', () => {
        push('err ' + v.error?.code);
        resolve();
      });
      setTimeout(() => resolve(), 8000);
    });
  }
  return { log, ready: v.readyState, w: v.videoWidth, src: (v.currentSrc || '').slice(0, 80) };
}, src);

console.log(result);
await browser.close();
