import { chromium } from 'playwright';

const src = (
  await (
    await fetch('http://127.0.0.1:8788/movies111/resolve?type=movie&id=533535&prefer=hls')
  ).json()
).masterUrl;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
await page.setContent(`<video id="v" muted autoplay playsinline style="width:640px;height:360px;background:red"></video>`);
await page.addScriptTag({ url: 'https://cdn.jsdelivr.net/npm/hls.js@1.6.16/dist/hls.min.js' });

const info = await page.evaluate(async (src) => {
  const v = document.getElementById('v');
  const hls = new Hls({ enableWorker: true });
  await new Promise((resolve) => {
    hls.on(Hls.Events.MANIFEST_PARSED, () => v.play().catch(() => {}));
    hls.on(Hls.Events.FRAG_LOADED, () => setTimeout(resolve, 2500));
    hls.on(Hls.Events.ERROR, (_e, d) => {
      if (d.fatal) resolve();
    });
    hls.loadSource(src);
    hls.attachMedia(v);
    setTimeout(resolve, 25000);
  });
  return {
    ready: v.readyState,
    paused: v.paused,
    w: v.videoWidth,
    h: v.videoHeight,
    t: v.currentTime,
    muted: v.muted,
    src: (v.currentSrc || '').slice(0, 40),
  };
}, src);

console.log(info);
await browser.close();
process.exit(info.w > 0 ? 0 : 2);
