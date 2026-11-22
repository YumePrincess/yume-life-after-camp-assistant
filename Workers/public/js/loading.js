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
  const chatPage = document.body.classList.contains("chat-page");
  const weights = publicPage
    ? { document: 15, fonts: 10, background: 15, data: 35, group: 15, identity: 10 }
    : adminPage
      ? { document: 20, fonts: 10, background: 15, data: 45, plugins: 10 }
      : chatPage
        ? { document: 15, fonts: 10, background: 15, identity: 20, data: 30, view: 10 }
        : { document: 20, fonts: 10, background: 20, data: 50 };
  // The chat app is mounted later, so its root must be inert in the HTML too.
  const content = [...document.querySelectorAll("body > .skip-link, body > header, body > main, body > footer, body > #app")];
  const wasInert = content.map(element => element.inert);
  for (const element of content) element.inert = true;
  document.documentElement.classList.add("is-page-loading");
  const progress = overlay.querySelector('[role="progressbar"]');
  const bar = overlay.querySelector(".page-loading-bar");
  const percent = overlay.querySelector(".page-loading-percent");
  const contrast = overlay.querySelector(".page-loading-percent-contrast");
  const labels = chatPage ? chatLabels() : null;
  if (labels) {
    overlay.setAttribute("aria-label", labels.loading);
    overlay.querySelector(".page-loading-title").textContent = labels.title;
    overlay.querySelector(".page-loading-message").textContent = labels.loading;
    overlay.querySelector("[data-loading-retry]").textContent = labels.retry;
    overlay.querySelector("[data-loading-home]").textContent = labels.home;
    progress.setAttribute("aria-label", labels.progress);
  }
  let finished = false;
  let failed = false;
  function showRecovery(message) {
    if (finished) return;
    overlay.classList.add("is-stalled");
    overlay.querySelector(".page-loading-actions").hidden = false;
    overlay.querySelector(".page-loading-message").textContent = message;
  }
  const watchdog = window.setTimeout(() => {
    if (finished || failed) return;
    const message = "载入时间较长，可以重试或继续查看。";
    showRecovery(labels?.slow || window.MrzhI18n?.t(message) || message);
  }, 20_000);

  function finish() {
    if (finished || failed) return;
    finished = true;
    window.clearTimeout(watchdog);
    document.documentElement.classList.remove("is-page-loading");
    content.forEach((element, index) => { element.inert = wasInert[index] || (!chatPage && document.body.classList.contains("chat-workspace-open")); });
    if (chatPage) document.getElementById("app")?.removeAttribute("inert");
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
  function fail() {
    failed = true;
    showRecovery(labels?.failed || window.MrzhI18n?.t("载入失败，请重试。") || "载入失败，请重试。");
  }
  window.MrzhLoading = Object.freeze({ createTracker, settle, fail });
  overlay.querySelector("[data-loading-retry]").addEventListener("click", () => window.location.reload());
  overlay.querySelector("[data-loading-continue]")?.addEventListener("click", finish);

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
  const background = getComputedStyle(chatPage ? overlay : document.body, "::before").backgroundImage.match(/^url\(["']?(.*?)["']?\)$/);
  if (background) {
    const image = new Image();
    image.src = background[1];
    void waitForImage(image).finally(() => tracker.settle("background"));
  } else tracker.settle("background");

  function chatLabels() {
    const preferences = window.YumePreferences;
    const language = preferences?.resolveLanguage(preferences.getLanguageChoice()) || "zh-cn";
    return ({
      "zh-cn": { title: "互动中心", loading: "正在载入…", progress: "载入进度", retry: "重新载入", home: "返回营地助手", slow: "载入时间较长，可以重新载入或返回首页。", failed: "载入失败，请重新载入或返回首页。" },
      "zh-tw": { title: "互動中心", loading: "正在載入…", progress: "載入進度", retry: "重新載入", home: "返回營地助手", slow: "載入時間較長，可以重新載入或返回首頁。", failed: "載入失敗，請重新載入或返回首頁。" },
      en: { title: "Interaction Center", loading: "Loading…", progress: "Loading progress", retry: "Reload", home: "Back to camp assistant", slow: "Loading is taking longer than expected. Reload or return home.", failed: "Unable to load. Reload or return home." },
      ja: { title: "交流センター", loading: "読み込み中…", progress: "読み込み状況", retry: "再読み込み", home: "野営地アシスタントへ戻る", slow: "読み込みに時間がかかっています。再読み込みするか、ホームに戻ってください。", failed: "読み込めませんでした。再読み込みするか、ホームに戻ってください。" },
      fr: { title: "Centre d’interaction", loading: "Chargement…", progress: "Progression du chargement", retry: "Recharger", home: "Retour à l’assistant du camp", slow: "Le chargement prend plus de temps que prévu. Rechargez ou revenez à l’accueil.", failed: "Chargement impossible. Rechargez ou revenez à l’accueil." }
    })[language];
  }
})();
