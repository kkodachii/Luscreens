import { chromium } from 'playwright';

const base = 'http://127.0.0.1:4200';
const url = `${base}/frame/movie/533535`;

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
});
const page = await browser.newPage();

page.on('console', (msg) => {
  if (msg.type() === 'error') {
    console.log('console.error', msg.text().slice(0, 180));
  }
});

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(5000);

// Open provider menu — look for Provider button / grid icon
const providerBtn = page
  .locator('button[aria-label="Provider"], button[title*="Provider"]')
  .first();
if (await providerBtn.count()) {
  await providerBtn.click();
  await page.waitForTimeout(500);
} else {
  // Fallback: any button containing provider label text in toolbar
  const any = page.locator('button:has-text("ApiPlayer"), button:has-text("Provider")').first();
  if (await any.count()) await any.click();
}

const movies111 = page.locator('button:has-text("111Movies")').first();
if (!(await movies111.count())) {
  console.log('UI state', await page.locator('body').innerText().then((t) => t.slice(0, 400)));
  await browser.close();
  process.exit(2);
}

await movies111.click();
console.log('clicked 111Movies');

// Watch provider label / data-provider for 15s — should stay movies111
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(2000);
  const provider = await page
    .locator('[data-provider]')
    .first()
    .getAttribute('data-provider')
    .catch(() => null);
  const hasVideo = await page.locator('video').count();
  const videoInfo = hasVideo
    ? await page.locator('video').first().evaluate((v) => ({
        hasSrc: !!(v.currentSrc || v.src),
        ready: v.readyState,
        err: v.error ? v.error.code : null,
        host: (() => {
          try {
            return v.currentSrc ? new URL(v.currentSrc).host : '';
          } catch {
            return '';
          }
        })(),
      }))
    : null;
  const overlay = await page
    .locator('text=/Switching to|Trying |No working|Loading/i')
    .first()
    .textContent()
    .catch(() => null);
  console.log('tick', i, { provider, videoInfo, overlay });
  if (provider && provider !== 'movies111') {
    console.log('FAIL: provider hopped away to', provider);
    await browser.close();
    process.exit(3);
  }
  if (videoInfo?.ready >= 2) {
    console.log('PLAYING_OK');
    await browser.close();
    process.exit(0);
  }
}

const finalProvider = await page
  .locator('[data-provider]')
  .first()
  .getAttribute('data-provider')
  .catch(() => null);
console.log('final', finalProvider);
await browser.close();
process.exit(finalProvider === 'movies111' ? 0 : 4);
