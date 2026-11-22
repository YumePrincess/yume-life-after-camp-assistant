(() => {
  "use strict";
  const params = new URLSearchParams(window.location.search);
  const returnTo = params.get("returnTo") || "/admin";
  const suppressionKey = "yumePublicOidcAutoLoginSuppressed";
  const login = document.querySelector("#oidc-login");
  const keySection = document.querySelector("#key-login-section");
  const keyDivider = document.querySelector("#key-login-divider");
  const configNotice = document.querySelector("#auth-config-notice");
  if (login) {
    login.href = `/auth/oidc/start?returnTo=${encodeURIComponent(returnTo)}`;
    login.addEventListener("click", () => {
      sessionStorage.removeItem(suppressionKey);
    });
  }
  const messages = {
    invalid_state: "登录状态已失效，请重新登录。",
    oidc_denied: "身份提供方取消了登录。",
    missing_code: "身份提供方没有返回授权码。",
    token_exchange_failed: "登录令牌交换失败，请稍后重试。",
    userinfo_failed: "无法读取账号信息，请稍后重试。",
    unauthorized: "当前账号未被授权进入营地管理后台。",
    oidc_session_expired: "OIDC Account 登录状态已退出，请重新登录。",
    oidc_disabled: "OIDC 登录已禁用，请使用管理员临时 Key 登录。",
    oidc_not_configured: "OIDC 客户端 Secret 未配置。"
  };
  const error = params.get("error");
  const t = message => window.MrzhI18n?.t ? window.MrzhI18n.t(message) : message;
  const notice = message => window.MrzhFeedback.notice(t(message));
  if (error) {
    const message = messages[error] || "登录失败，请稍后重试。";
    void notice(message);
  }

  document.querySelector("#key-login-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = event.currentTarget.querySelector('[type="submit"]');
    submit.disabled = true;
    const progress = window.MrzhFeedback.begin();
    let message = "";
    try {
      const response = await fetch("/auth/key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: document.querySelector("#temporary-key").value,
          returnTo
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "临时 Key 登录失败。");
      }
      location.replace(payload.returnTo || "/admin");
    } catch (error) {
      message = error.message || "临时 Key 登录失败。";
    } finally {
      submit.disabled = false;
      window.MrzhFeedback.end(progress);
    }
    if (message) void notice(message);
  });

  void initializeAuth().catch(() => {
    void notice("登录配置加载失败，请重新载入。");
  }).finally(() => window.MrzhLoading?.settle("data"));

  async function initializeAuth() {
    const response = await fetch("/api/auth/config", { cache: "no-store" });
    const config = await response.json();
    if (login) login.hidden = !config.oidcEnabled;
    if (keySection) keySection.hidden = !config.temporaryKeyLoginEnabled;
    if (keyDivider) keyDivider.hidden = !config.oidcEnabled;
    if (!config.oidcEnabled && !config.adminKeyConfigured && configNotice) {
      configNotice.textContent = t(
        "OIDC 已禁用且管理员临时 Key 未配置，请在 Wrangler 中设置 ADMIN_TEMPORARY_KEY。"
      );
      configNotice.hidden = false;
    }
    if (
      config.oidcEnabled &&
      config.oidcAutoLogin &&
      !error &&
      params.get("silent") !== "1" &&
      !sessionStorage.getItem(suppressionKey)
    ) {
      document.querySelector("#oidc-silent-frame").src =
        `/auth/oidc/silent?returnTo=${encodeURIComponent(returnTo)}`;
    }
  }
})();
