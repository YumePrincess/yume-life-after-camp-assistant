(() => {
  "use strict";

  function createTracker(weights, onProgress, onComplete) {
    const settled = new Set();
    const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
    let complete = false;
    return Object.freeze({
      settle(name) {
        if (complete || settled.has(name) || !Object.prototype.hasOwnProperty.call(weights, name)) return;
        settled.add(name);
        const loaded = [...settled].reduce((sum, key) => sum + weights[key], 0);
        onProgress(Math.round(loaded / total * 100));
        if (settled.size === Object.keys(weights).length) {
          complete = true;
          onComplete();
        }
      }
    });
  }

  window.MrzhLoading = Object.freeze({ createTracker });
  if (typeof document === "undefined") return;
  const overlay = document.getElementById("page-loading");
  if (!overlay) return;
  const publicPage = document.body.classList.contains("public-page");
  const adminPage = document.body.classList.contains("admin-page");
  const weights = publicPage
    ? { document: 15, fonts: 10, background: 15, data: 35, group: 15, identity: 10 }
    : adminPage
      ? { document: 20, fonts: 10, background: 15, data: 45, plugins: 10 }
      : { document: 20, fonts: 10, background: 20, data: 50 };
  const content = [...document.querySelectorAll("body > .skip-link, body > header, body > main, body > footer")];
  const wasInert = content.map(element => element.inert);
  for (const element of content) element.inert = true;
  document.documentElement.classList.add("is-page-loading");
  const progress = overlay.querySelector('[role="progressbar"]');
  const bar = overlay.querySelector(".page-loading-bar");
  const percent = overlay.querySelector(".page-loading-percent");
  const contrast = overlay.querySelector(".page-loading-percent-contrast");
  let finished = false;
  const watchdog = window.setTimeout(() => {
    if (finished) return;
    overlay.classList.add("is-stalled");
    overlay.querySelector(".page-loading-actions").hidden = false;
    const message = "载入时间较长，可以重试或继续查看。";
    overlay.querySelector(".page-loading-message").textContent = window.MrzhI18n?.t(message) || message;
  }, 20_000);

  function finish() {
    if (finished) return;
    finished = true;
    window.clearTimeout(watchdog);
    document.documentElement.classList.remove("is-page-loading");
    content.forEach((element, index) => { element.inert = wasInert[index]; });
    if (overlay.contains(document.activeElement)) document.querySelector("main")?.focus({ preventScroll: true });
    overlay.setAttribute("aria-hidden", "true");
    overlay.classList.add("is-complete");
    const hide = () => { overlay.hidden = true; };
    overlay.addEventListener("transitionend", hide, { once: true });
    window.setTimeout(hide, 250);
  }

  const tracker = createTracker(weights, value => {
    progress.setAttribute("aria-valuenow", String(value));
    bar.style.transform = `scaleX(${value / 100})`;
    percent.textContent = `${value}%`;
    contrast.textContent = `${value}%`;
    contrast.style.clipPath = `inset(0 ${100 - value}% 0 0)`;
  }, finish);
  let dataReady;
  let pluginsReady;
  const dataRendered = new Promise(resolve => { dataReady = resolve; });
  const pluginsRendered = adminPage ? new Promise(resolve => { pluginsReady = resolve; }) : Promise.resolve();
  function settle(name) {
    if (name === "data") dataReady();
    if (name === "plugins") pluginsReady?.();
    tracker.settle(name);
  }
  window.MrzhLoading = Object.freeze({ createTracker, settle });
  overlay.querySelector("[data-loading-retry]").addEventListener("click", () => window.location.reload());
  overlay.querySelector("[data-loading-continue]").addEventListener("click", finish);

  function waitForImage(image) {
    return new Promise(resolve => {
      const settle = () => {
        image.removeEventListener("load", settle);
        image.removeEventListener("error", settle);
        resolve();
      };
      image.addEventListener("load", settle, { once: true });
      image.addEventListener("error", settle, { once: true });
      if (image.complete) settle();
    }).then(() => image.naturalWidth > 0 && image.decode ? image.decode().catch(() => {}) : undefined);
  }

  const documentReady = document.readyState === "complete" ? Promise.resolve()
    : new Promise(resolve => window.addEventListener("load", resolve, { once: true }));
  // Include eager images and fonts created by the API render or plugin mount,
  // even when the browser's window load event fired before those requests.
  void Promise.all([documentReady, dataRendered, pluginsRendered]).then(async () => {
    await Promise.all([...document.images]
      .filter(image => image.getAttribute("src") && image.loading !== "lazy").map(waitForImage));
    await document.fonts?.ready;
  }).catch(() => {})
    .finally(() => tracker.settle("document"));
  void Promise.resolve(document.fonts?.ready).catch(() => {}).finally(() => tracker.settle("fonts"));
  const background = getComputedStyle(document.body, "::before").backgroundImage.match(/^url\(["']?(.*?)["']?\)$/);
  if (background) {
    const image = new Image();
    image.src = background[1];
    void waitForImage(image).finally(() => tracker.settle("background"));
  } else tracker.settle("background");
})();
