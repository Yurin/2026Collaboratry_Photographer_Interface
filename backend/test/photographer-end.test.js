const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../../photographer/script.js'), 'utf8');
const html = fs.readFileSync(path.resolve(__dirname, '../../photographer/index.html'), 'utf8');
assert.ok(html.includes('id="endCaptureBtn"'));
assert.ok(!/id="(?:clearBtn|deleteSessionBtn)"/.test(html));
assert.ok(!/clearBtn|deleteSessionBtn/.test(source));
const ending = source.slice(source.indexOf('function showThankYouPage('), source.indexOf('document.addEventListener("visibilitychange"'));
async function scenario({ count = 2, fail = false, inFlight = false } = {}) {
  const elements = {};
  for (const name of ['capturePanel', 'galleryPanel', 'photoPreviewOverlay', 'postSendDialog', 'thankYouPanel', 'sessionEndMessage', 'retryEndSendBtn', 'captureBtn', 'shareLiveBtn', 'endCaptureBtn', 'sendBtn']) {
    elements[name] = { hidden: false, addEventListener(type, callback) { this.click = callback; } };
  }
  let sends = 0, stopped = 0;
  const context = vm.createContext({ ...elements, document: { getElementById: () => ({}) },
    sessionEndRequested: false, pendingPostSendResolve: null,
    photos: Array(count).fill({}), activePhotoSendPromise: null,
    stopLiveShare() { stopped++; }, currentStream: { getTracks: () => [{ stop() { stopped++; } }] },
    showSupportMessage() {},
    async sendCapturedPhotos(options) {
      assert.equal(options.promptAfterSend, false);
      sends++;
      if (fail) return false;
      context.photos = [];
      return true;
    }
  });
  if (inFlight) context.activePhotoSendPromise = Promise.resolve().then(() => { context.photos = []; return true; });
  vm.runInContext(ending, context);
  await context.handleSessionEnded();
  assert.equal(context.thankYouPanel.hidden, false);
  assert.equal(context.capturePanel.hidden, true);
  assert.equal(context.endCaptureBtn.disabled, true);
  assert.equal(stopped, 2);
  assert.equal(sends, count && !inFlight ? 1 : 0);
  assert.equal(context.retryEndSendBtn.hidden, !fail);
  await context.handleSessionEnded();
  assert.equal(stopped, 2, 'double-click must not repeat ending');
  if (fail) {
    assert.equal(context.photos.length, count, 'failed upload keeps photos');
    fail = false;
    await context.retryEndSendBtn.click();
    assert.equal(context.photos.length, 0);
    assert.equal(context.retryEndSendBtn.hidden, true);
  }
}
(async () => {
  await scenario();
  await scenario({ count: 0 });
  await scenario({ fail: true });
  await scenario({ inFlight: true });
  console.log('photographer ending passed: send, empty, retry, double-click, in-flight send');
})().catch(error => { console.error(error); process.exitCode = 1; });
