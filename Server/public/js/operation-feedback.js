(() => {
  "use strict";
  const queue = [];
  const pending = new Map();
  const operations = new Map();
  let sequence = 0;
  let resultDialog, progressDialog, active;
  const labels = {
    "zh-cn": ["操作提示", "正在处理…", "关闭", "取消"],
    "zh-tw": ["操作提示", "處理中…", "關閉", "取消"],
    en: ["Notice", "Processing…", "Close", "Cancel"],
    fr: ["Information", "Traitement en cours…", "Fermer", "Annuler"],
    ja: ["お知らせ", "処理中…", "閉じる", "キャンセル"]
  };
  function words() {
    const p = window.YumePreferences;
    return labels[p?.resolveLanguage(p.getLanguageChoice())] || labels.en;
  }
  function node(tag, className, text) {
    const el = document.createElement(tag);
    el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function dialog(kind) {
    const el = node("dialog", `site-feedback site-feedback--${kind}`);
    el.setAttribute("aria-modal", "true");
    el.setAttribute("data-i18n-ignore", "");
    el.setAttribute("aria-labelledby", `site-feedback-${kind}-title`);
    document.body.append(el);
    return el;
  }
  function renderProgress() {
    if (!operations.size || active) {
      if (progressDialog?.open) progressDialog.close();
      return;
    }
    progressDialog ||= dialog("progress");
    const latest = [...operations.values()].at(-1);
    const title = node("h2", "site-feedback__title", latest.message || words()[1]);
    title.id = "site-feedback-progress-title";
    const track = node("div", "site-feedback__track");
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-label", title.textContent);
    track.append(node("span", "site-feedback__bar"));
    progressDialog.replaceChildren(title, track);
    if (latest.cancel) {
      const cancel = node("button", "site-feedback__button", words()[3]);
      cancel.type = "button";
      cancel.onclick = latest.cancel;
      progressDialog.append(cancel);
    }
    progressDialog.oncancel = event => {
      event.preventDefault();
      latest.cancel?.();
    };
    if (!progressDialog.open) progressDialog.showModal();
  }
  function showNext() {
    if (active || !queue.length) { renderProgress(); return; }
    active = queue.shift();
    renderProgress();
    if (!resultDialog) {
      resultDialog = dialog("result");
      resultDialog.setAttribute("role", "alertdialog");
      resultDialog.setAttribute("aria-describedby", "site-feedback-result-message");
      resultDialog.addEventListener("close", () => {
        const finished = active;
        active = null;
        pending.delete(finished.key);
        finished.resolve();
        if (finished.action) {
          Promise.resolve().then(finished.action).catch(error => notice(error.message));
        }
        showNext();
      });
    }
    const title = node("h2", "site-feedback__title", active.options.title || words()[0]);
    title.id = "site-feedback-result-title";
    const message = node("p", "site-feedback__message", active.message);
    message.id = "site-feedback-result-message";
    const actions = node("div", "site-feedback__actions");
    for (const action of [...(active.options.actions || []), { label: words()[2] }]) {
      const button = node("button", "site-feedback__button", action.label);
      button.type = "button";
      button.onclick = () => { active.action = action.run; resultDialog.close(); };
      actions.append(button);
    }
    resultDialog.replaceChildren(title, message, actions);
    resultDialog.showModal();
    actions.querySelector("button")?.focus({ preventScroll: true });
  }
  function notice(message, options = {}) {
    if (!message) return Promise.resolve();
    const key = `${options.title || ""}\n${message}`;
    if (pending.has(key)) return pending.get(key);
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    pending.set(key, promise);
    queue.push({ message: String(message), options, key, resolve });
    showNext();
    return promise;
  }
  function begin(options = {}) {
    const token = ++sequence;
    operations.set(token, options);
    renderProgress();
    return token;
  }
  function end(token) {
    operations.delete(token);
    renderProgress();
  }
  window.MrzhFeedback = Object.freeze({ notice, begin, end });
})();
