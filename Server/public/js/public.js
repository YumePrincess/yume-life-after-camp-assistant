(() => {
  "use strict";

  const state = {
    data: null,
    selections: new Set(),
    memberQuery: "",
    identityMode: "new",
    renewalCode: "",
    renewalApplicationNumber: "",
    reissueCode: "",
    reissueApplicationNumber: "",
    reissueEmail: "",
    reissuePlayerName: "",
    identitySession: null,
    identityResetChallengeId: "",
    identityResetToken: "",
    identityCancellationChallengeId: "",
    identityEmailChangeId: "",
    identityProfileMode: "",
    identityProfileStep: "",
    identityEmailOldOtp: "",
    identitySessionRefreshedAt: 0,
    identitySessionRefreshTimer: null,
    identitySessionRefreshInFlight: false,
    voteErrorRenewalCode: "",
    activeFeature: "",
    dailyPanel: "",
    dailyIdentityCodes: {},
    dailySelections: {},
    identityCodeEdited: false,
    liveSocket: null,
    liveReconnectTimer: null,
    liveReconnectAttempt: 0,
    liveRefreshInFlight: false,
    liveRefreshQueued: false,
    liveDirty: false
  };
  const FEATURE_IDS = ["overview", "staff", "warnings", "vote", "members", "runs"];
  const FEATURE_DETAIL_KICKERS = {
    overview: "CAMP NOTES",
    staff: "OFFICERS",
    warnings: "INACTIVITY WATCH",
    vote: "DAILY VOTING",
    members: "MEMBER CONTRIBUTION",
    runs: "AUTOMATION"
  };
  const DAILY_PANEL_KICKERS = {
    identity: "IDENTITY CODE",
    technology: "NEXT TECHNOLOGY",
    items: "OPEN ITEMS",
    history: "HISTORY"
  };
  const IDENTITY_SESSION_STORAGE_KEY = "mrzh.identity-session";
  const IDENTITY_SESSION_REFRESH_INTERVAL_MS = 30_000;
  const IDENTITY_SESSION_INVALID_CODES = new Set([
    "identity_code_invalid",
    "identity_code_disabled",
    "identity_code_expired",
    "identity_password_invalid",
    "identity_password_required",
    "identity_login_failed"
  ]);

  function isIdentitySessionInvalidError(error) {
    return IDENTITY_SESSION_INVALID_CODES.has(error?.code) ||
      [401, 403, 409].includes(Number(error?.status));
  }
  const ACTIVE_IDENTITY_CONFLICT =
    "您提供的信息可能已经成功申请身份识别码。如果您忘记了身份识别码，请通过“忘记识别码”功能找回。如果这不是您提交的申请，请联系市长处理。";
  const EXPIRED_IDENTITY_CONFLICT =
    "您提供的信息关联的身份识别码已过期，请通过“申请延长识别码有效期”功能申请延期。延期申请被拒绝后，该识别码将标记为失效，届时可以重新申请身份识别码。";

  function byId(id) {
    return document.getElementById(id);
  }

  function syncFeatureDetailKicker() {
    const kicker =
      state.activeFeature === "vote" && state.dailyPanel
        ? DAILY_PANEL_KICKERS[state.dailyPanel] || FEATURE_DETAIL_KICKERS.vote
        : FEATURE_DETAIL_KICKERS[state.activeFeature] || "FEATURE DETAIL";
    setText("feature-detail-kicker", kicker);
  }

  function dailyVoteFeatureCount(payload) {
    return (Array.isArray(payload?.items) ? payload.items.length : 0) + 2;
  }

  function loadIdentitySession() {
    try {
      const value = JSON.parse(window.localStorage.getItem(IDENTITY_SESSION_STORAGE_KEY) || "null");
      return value && /^\d{8}$/.test(value.identityCode) && value.password
        ? value
        : null;
    } catch {
      return null;
    }
  }

  function persistIdentitySession(session) {
    state.identitySession = session;
    if (!session) state.identitySessionRefreshedAt = 0;
    try {
      if (session) {
        window.localStorage.setItem(IDENTITY_SESSION_STORAGE_KEY, JSON.stringify(session));
      } else {
        window.localStorage.removeItem(IDENTITY_SESSION_STORAGE_KEY);
      }
    } catch {
      // Private browsing or an embedded webview may deny localStorage access.
    }
    renderIdentityAccount();
  }

  function identitySession() {
    return state.identitySession;
  }

  function clearIdentitySession({ openPanel = false } = {}) {
    persistIdentitySession(null);
    setText("technology-identity-hint", window.MrzhI18n.t("请先在身份识别码卡片登录，登录后即可投票。"));
    if (openPanel) openIdentityPanel();
  }

  function requireIdentitySession() {
    if (identitySession()) return true;
    setText("technology-identity-hint", window.MrzhI18n.t("请先在身份识别码卡片登录，登录后即可投票。"));
    openDailyPanel("identity");
    return false;
  }

  function renderIdentityAccount() {
    const session = identitySession();
    const loggedOut = byId("identity-account-logged-out");
    const loggedIn = byId("identity-account-logged-in");
    if (loggedOut) loggedOut.hidden = Boolean(session);
    if (loggedIn) loggedIn.hidden = !session;
    setText("identity-account-state", session ? window.MrzhI18n.t("已登录") : window.MrzhI18n.t("未登录"));
    setText("daily-identity-panel-state", session ? "✓" : "—");
    renderIdentityEligibility(session);
    if (session) {
      setText("identity-account-name", session.playerName || window.MrzhI18n.t("未填写玩家名称"));
      setText("identity-account-code", session.identityCode || "—");
      setText("identity-account-email", session.email || window.MrzhI18n.t("未绑定邮箱"));
      setText(
        "identity-account-expiry",
        session.expiresAt ? formatIdentityExpiry(session.expiresAt, session.timezone || configuredTimezone()) : window.MrzhI18n.t("永久有效")
      );
      const codeInput = byId("identity-reset-code");
      if (codeInput && !codeInput.value) codeInput.value = session.identityCode;
      const loginCode = byId("identity-login-code");
      if (loginCode) loginCode.value = session.identityCode;
    }
  }

  function formatEligibilityNumber(value) {
    return new Intl.NumberFormat(window.MrzhI18n.language() || undefined).format(
      Number.isFinite(Number(value)) ? Number(value) : 0
    );
  }

  function renderIdentityEligibility(session = identitySession()) {
    const status = byId("identity-account-eligibility");
    const line = byId("identity-eligibility-line");
    const overrideLine = byId("identity-eligibility-override");
    const applyButton = byId("identity-eligibility-apply");
    const result = session?.voteEligibility;
    if (!status) return;
    if (!session || !result) {
      status.textContent = "—";
      status.removeAttribute("data-eligible");
      if (line) line.hidden = true;
      if (overrideLine) overrideLine.hidden = true;
      if (applyButton) applyButton.hidden = true;
      return;
    }
    // The global switch is authoritative: when it is off, do not show a
    // status row that could suggest an item-level check is still active.
    if (line) line.hidden = result.enabled === false;
    if (overrideLine) overrideLine.hidden = true;
    if (applyButton) applyButton.hidden = true;
    if (result.enabled === false) {
      status.textContent = "—";
      status.removeAttribute("data-eligible");
      return;
    }
    const eligible = result.enabled === false || result.eligible === true;
    status.textContent = window.MrzhI18n.t(
      eligible ? "已达标，准许投票" : "尚未达标，无法投票"
    );
    status.dataset.eligible = String(eligible);
    const override = result.override;
    if (override && overrideLine) {
      const value = override.votesRemaining !== null && override.votesRemaining !== undefined
        ? window.MrzhI18n.format("剩余 {count} 次", { count: formatEligibilityNumber(override.votesRemaining) })
        : override.expiresAt
          ? window.MrzhI18n.format("有效至 {date}", {
              date: formatIdentityExpiry(override.expiresAt, session.timezone || configuredTimezone())
            })
          : "";
      if (value) {
        setText("identity-account-eligibility-override", value);
        overrideLine.hidden = false;
      }
    }
    if (!eligible && !override && applyButton) applyButton.hidden = false;
    const thresholds = result.thresholds || {};
    const current = result.current || {};
    for (const [thresholdId, currentId, key] of [
      ["identity-eligibility-threshold-contribution", "identity-eligibility-current-contribution", "weeklyContribution"],
      ["identity-eligibility-threshold-technology", "identity-eligibility-current-technology", "technologyPoints"],
      ["identity-eligibility-threshold-materials", "identity-eligibility-current-materials", "materialContribution"],
      ["identity-eligibility-threshold-activity", "identity-eligibility-current-activity", "weeklyActivityPoints"]
    ]) {
      setText(thresholdId, formatEligibilityNumber(thresholds[key]));
      setText(currentId, formatEligibilityNumber(current[key]));
    }
    const dialogStatus = byId("identity-eligibility-dialog-status");
    if (dialogStatus) {
      dialogStatus.textContent = result.enabled === false
        ? window.MrzhI18n.t("管理员已关闭投票资格校验，当前身份识别码可投票。")
        : window.MrzhI18n.t(
          eligible ? "已达标，准许投票" : "尚未达标，无法投票"
        );
      dialogStatus.dataset.eligible = String(eligible);
    }
  }

  function openIdentityEligibilityDialog() {
    renderIdentityEligibility();
    const dialog = byId("identity-eligibility-dialog");
    if (dialog && !dialog.open) dialog.showModal();
  }

  function openIdentityPanel() {
    openDailyPanel("identity");
    renderIdentityAccount();
    void refreshIdentitySession();
  }

  async function refreshIdentitySession({ force = false } = {}) {
    const session = identitySession();
    if (!session?.identityCode || !session.password) return;
    if (!force && Date.now() - state.identitySessionRefreshedAt < IDENTITY_SESSION_REFRESH_INTERVAL_MS) return;
    if (state.identitySessionRefreshInFlight) return;
    state.identitySessionRefreshInFlight = true;
    try {
      const account = await request("/api/public/identity-login", {
        method: "POST",
        body: JSON.stringify({
          identityCode: session.identityCode,
          identityPassword: session.password
        })
      });
      if (
        identitySession()?.identityCode !== session.identityCode ||
        identitySession()?.password !== session.password
      ) return;
      persistIdentitySession({ ...session, ...account, password: session.password });
      state.identitySessionRefreshedAt = Date.now();
    } catch (error) {
      if (isIdentitySessionInvalidError(error)) {
        clearIdentitySession({ openPanel: state.dailyPanel === "identity" });
      }
      // Keep the cached session on transient failures and retry on the next interval.
    } finally {
      state.identitySessionRefreshInFlight = false;
    }
  }

  async function loginIdentity(event) {
    event.preventDefault();
    const feedback = byId("identity-login-feedback");
    const identityCode = byId("identity-login-code").value.trim();
    const password = byId("identity-login-password").value;
    if (!/^\d{8}$/.test(identityCode) || !password) {
      feedback.textContent = window.MrzhI18n.t("请输入有效的身份识别码和密码。");
      return;
    }
    feedback.textContent = window.MrzhI18n.t("正在验证…");
    try {
      const account = await request("/api/public/identity-login", {
        method: "POST",
        body: JSON.stringify({ identityCode, identityPassword: password })
      });
      persistIdentitySession({ ...account, password });
      state.identitySessionRefreshedAt = Date.now();
      feedback.textContent = window.MrzhI18n.t("登录成功。");
      byId("identity-login-password").value = "";
      setText("technology-identity-hint", window.MrzhI18n.t("身份识别码已登录，可以提交投票。"));
    } catch (error) {
      feedback.textContent = window.MrzhI18n.t(error.message);
      if (error.code === "identity_password_required") {
        beginIdentityPasswordReset();
      }
    }
  }

  function beginIdentityPasswordReset() {
    const dialog = byId("identity-password-reset-dialog");
    if (dialog && !dialog.open) dialog.showModal();
    state.identityResetChallengeId = "";
    state.identityResetToken = "";
    setPasswordResetStep("request");
    setText("identity-reset-feedback", "");
    const session = identitySession();
    if (session) {
      byId("identity-reset-code").value = session.identityCode;
      byId("identity-reset-email").value = session.email || "";
    }
  }

  function setPasswordResetStep(step) {
    for (const element of document.querySelectorAll("[data-reset-step]")) {
      element.hidden = element.dataset.resetStep !== step;
    }
  }

  async function requestPasswordReset(event) {
    event.preventDefault();
    const feedback = byId("identity-reset-feedback");
    feedback.textContent = window.MrzhI18n.t("正在发送验证码…");
    try {
      const result = await request("/api/public/identity-password-reset", {
        method: "POST",
        body: JSON.stringify({
          action: "request",
          applicationNumber: byId("identity-reset-application").value.trim(),
          email: byId("identity-reset-email").value.trim(),
          identityCode: byId("identity-reset-code").value.trim()
        })
      });
      state.identityResetChallengeId = result.challengeId;
      setPasswordResetStep("verify");
      feedback.textContent = window.MrzhI18n.t("验证码已发送到预留邮箱。");
    } catch (error) {
      feedback.textContent = window.MrzhI18n.t(error.message);
    }
  }

  async function verifyPasswordReset(event) {
    event.preventDefault();
    const feedback = byId("identity-reset-feedback");
    try {
      const result = await request("/api/public/identity-password-reset", {
        method: "POST",
        body: JSON.stringify({
          action: "verify",
          challengeId: state.identityResetChallengeId,
          otp: byId("identity-reset-otp").value.trim()
        })
      });
      state.identityResetToken = result.resetToken;
      setPasswordResetStep("set");
      feedback.textContent = window.MrzhI18n.t("验证通过，请设置新密码。");
    } catch (error) {
      feedback.textContent = window.MrzhI18n.t(error.message);
    }
  }

  async function setPasswordReset(event) {
    event.preventDefault();
    const feedback = byId("identity-reset-feedback");
    const password = byId("identity-new-password").value;
    if (password.length < 8 || password.length > 32) {
      feedback.textContent = window.MrzhI18n.t("密码必须为8至32位且不能包含空格");
      return;
    }
    try {
      await request("/api/public/identity-password-reset", {
        method: "POST",
        body: JSON.stringify({
          action: "set",
          challengeId: state.identityResetChallengeId,
          resetToken: state.identityResetToken,
          password
        })
      });
      feedback.textContent = window.MrzhI18n.t("密码设置成功，请返回登录。");
      state.identityResetChallengeId = "";
      state.identityResetToken = "";
      byId("identity-new-password").value = "";
      setPasswordResetStep("request");
    } catch (error) {
      feedback.textContent = window.MrzhI18n.t(error.message);
    }
  }

  function setIdentityCancellationStep(step) {
    for (const element of document.querySelectorAll("[data-cancellation-step]")) {
      element.hidden = element.dataset.cancellationStep !== step;
    }
  }

  function openIdentityCancellationDialog() {
    const session = identitySession();
    state.identityCancellationChallengeId = "";
    byId("identity-cancel-application").value = "";
    byId("identity-cancel-email").value = session?.email || "";
    byId("identity-cancel-code").value = session?.identityCode || "";
    byId("identity-cancel-otp").value = "";
    setText("identity-cancellation-feedback", "");
    setIdentityCancellationStep("request");
    const dialog = byId("identity-cancellation-dialog");
    if (dialog && !dialog.open) dialog.showModal();
  }

  async function submitIdentityCancellation(event) {
    event.preventDefault();
    const feedback = byId("identity-cancellation-feedback");
    const step = document.querySelector("[data-cancellation-step]:not([hidden])")?.dataset.cancellationStep;
    try {
      if (step === "request") {
        feedback.textContent = window.MrzhI18n.t("正在发送验证码…");
        const result = await request("/api/public/identity-cancellation", {
          method: "POST",
          body: JSON.stringify({
            action: "request",
            applicationNumber: byId("identity-cancel-application").value.trim(),
            email: byId("identity-cancel-email").value.trim(),
            identityCode: byId("identity-cancel-code").value.trim()
          })
        });
        state.identityCancellationChallengeId = result.challengeId;
        setIdentityCancellationStep("verify");
        feedback.textContent = window.MrzhI18n.t("验证码已发送到预留邮箱。");
        return;
      }
      feedback.textContent = window.MrzhI18n.t("正在提交…");
      await request("/api/public/identity-cancellation", {
        method: "POST",
        body: JSON.stringify({
          action: "confirm",
          challengeId: state.identityCancellationChallengeId,
          otp: byId("identity-cancel-otp").value.trim()
        })
      });
      byId("identity-cancellation-dialog").close();
      clearIdentitySession();
      setText("identity-profile-feedback", window.MrzhI18n.t("身份识别码已注销，已立即失效。"));
    } catch (error) {
      feedback.textContent = window.MrzhI18n.t(error.message);
    }
  }

  function setIdentityProfileStep(step) {
    state.identityProfileStep = step;
    for (const element of document.querySelectorAll("[data-identity-profile-step]")) {
      element.hidden = element.dataset.identityProfileStep !== step;
    }
    const submit = byId("identity-profile-submit");
    if (!submit) return;
    const label =
      step === "email"
        ? "发送验证码"
        : step === "old-email" || step === "new-email"
          ? "验证验证码"
          : "确认变更";
    submit.textContent = window.MrzhI18n.t(label);
  }

  function openIdentityProfileDialog(mode) {
    const session = identitySession();
    if (!session) return openIdentityPanel();
    state.identityProfileMode = mode;
    state.identityEmailChangeId = "";
    state.identityEmailOldOtp = "";
    setText(
      "identity-profile-dialog-title",
      window.MrzhI18n.t(mode === "name" ? "修改玩家名称" : "绑定/修改邮箱")
    );
    byId("identity-profile-name").value = session.playerName || "";
    byId("identity-profile-email").value = session.email || "";
    byId("identity-profile-old-otp").value = "";
    byId("identity-profile-new-otp").value = "";
    setText("identity-profile-dialog-feedback", "");
    setIdentityProfileStep(mode === "name" ? "name" : "email");
    const dialog = byId("identity-profile-dialog");
    if (dialog && !dialog.open) dialog.showModal();
  }

  async function submitIdentityProfile(event) {
    event.preventDefault();
    const session = identitySession();
    if (!session) return openIdentityPanel();
    const feedback = byId("identity-profile-dialog-feedback");
    const submit = byId("identity-profile-submit");
    const mode = state.identityProfileMode;
    const step = state.identityProfileStep;
    let body;
    let endpoint = "/api/public/identity-profile";
    if (mode === "name") {
      const playerName = byId("identity-profile-name").value.trim();
      if (!playerName) {
        feedback.textContent = window.MrzhI18n.t("请输入新的玩家名称");
        return;
      }
      body = {
        action: "update-name",
        identityCode: session.identityCode,
        identityPassword: session.password,
        playerName
      };
    } else if (step === "email") {
      const newEmail = byId("identity-profile-email").value.trim();
      if (!newEmail) {
        feedback.textContent = window.MrzhI18n.t("请输入新的邮箱地址");
        return;
      }
      body = {
        action: "request-email-change",
        identityCode: session.identityCode,
        identityPassword: session.password,
        newEmail
      };
    } else if (step === "old-email") {
      const oldOtp = byId("identity-profile-old-otp").value.trim();
      if (!oldOtp) {
        feedback.textContent = window.MrzhI18n.t("请输入旧邮箱收到的验证码");
        return;
      }
      state.identityEmailOldOtp = oldOtp;
      setIdentityProfileStep("new-email");
      feedback.textContent = "";
      return;
    } else {
      const newOtp = byId("identity-profile-new-otp").value.trim();
      if (!newOtp) {
        feedback.textContent = window.MrzhI18n.t("请输入新邮箱收到的验证码");
        return;
      }
      body = {
        action: "confirm-email-change",
        changeId: state.identityEmailChangeId,
        oldOtp: state.identityEmailOldOtp,
        newOtp
      };
    }
    submit.disabled = true;
    feedback.textContent = window.MrzhI18n.t("正在提交…");
    try {
      const result = await request(endpoint, {
        method: "POST",
        body: JSON.stringify(body)
      });
      if (mode === "name") {
        byId("identity-profile-dialog").close();
        showVoteSuccessDialog({
          kind: "identity",
          data: { publicTestVote: true },
          title: "申请已提交",
          kicker: "身份识别码",
          message: window.MrzhI18n.t("玩家名称变更已提交，审核通过后生效。")
        });
        void refreshIdentitySession({ force: true });
      } else if (step === "email") {
        state.identityEmailChangeId = result.changeId;
        setIdentityProfileStep("old-email");
        feedback.textContent = window.MrzhI18n.t("验证码已发送到邮箱，请填写后再次提交。");
      } else {
        byId("identity-profile-dialog").close();
        showVoteSuccessDialog({
          kind: "identity",
          data: { publicTestVote: true },
          title: "申请已提交",
          kicker: "身份识别码",
          message: window.MrzhI18n.t("邮箱变更已提交，审核通过后生效。")
        });
        void refreshIdentitySession({ force: true });
      }
    } catch (error) {
      feedback.textContent = window.MrzhI18n.t(error.message);
    } finally {
      submit.disabled = false;
    }
  }

  function syncDailyFeatureBackButton() {
    const button = byId("back-daily-vote");
    if (!button) return;
    const visible = state.activeFeature === "vote" && Boolean(state.dailyPanel);
    button.toggleAttribute("hidden", !visible);
    button.setAttribute("aria-hidden", String(!visible));
  }

  function resetFeatureSelection({ clearHash = true, restoreFocus = false } = {}) {
    const activeId = state.activeFeature;
    const activeCard = activeId
      ? document.querySelector(`.feature-card[data-feature-target="${activeId}"]`)
      : null;
    for (const panelId of FEATURE_IDS) {
      const item = byId(panelId);
      if (item) item.hidden = true;
    }
    for (const card of document.querySelectorAll(".feature-card[data-feature-target]")) {
      card.classList.remove("is-active");
      card.setAttribute("aria-expanded", "false");
    }
    state.activeFeature = "";
    state.dailyPanel = "";
    syncFeatureDetailKicker();
    syncDailyFeatureBackButton();
    if (clearHash) {
      history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
    if (restoreFocus && activeCard && !activeCard.hidden) activeCard.focus();
  }

  function showFeature(id, { updateHash = true } = {}) {
    if (!FEATURE_IDS.includes(id)) return false;
    const panel = byId(id);
    const selectedCard = document.querySelector(
      `.feature-card[data-feature-target="${id}"]`
    );
    const dialog = byId("feature-detail-dialog");
    if (!panel || !selectedCard || selectedCard.hidden || !dialog) return false;
    if (id !== "vote") state.dailyPanel = "";
    for (const panelId of FEATURE_IDS) {
      const item = byId(panelId);
      if (item) item.hidden = panelId !== id;
    }
    for (const card of document.querySelectorAll(".feature-card[data-feature-target]")) {
      const active = card.dataset.featureTarget === id;
      card.classList.toggle("is-active", active);
      card.setAttribute("aria-expanded", String(active));
    }
    state.activeFeature = id;
    syncFeatureDetailKicker();
    syncDailyFeatureBackButton();
    setText(
      "feature-detail-title",
      selectedCard?.querySelector(".feature-card-copy strong")?.textContent || ""
    );
    if (updateHash) {
      history.replaceState(null, "", `#${id}`);
    }
    if (!dialog.open) dialog.showModal();
    return true;
  }

  function handleFeatureNavigation(event) {
    const control = event.currentTarget;
    const id = control.dataset.featureTarget;
    if (!id) return;
    event.preventDefault();
    showFeature(id);
  }

  function initFeatureNavigation() {
    for (const control of document.querySelectorAll("[data-feature-target]")) {
      control.addEventListener("click", handleFeatureNavigation);
    }
    window.addEventListener("hashchange", () => {
      const id = window.location.hash.slice(1);
      if (FEATURE_IDS.includes(id)) showFeature(id, { updateHash: false });
    });
    byId("close-feature-detail").addEventListener("click", () => {
      byId("feature-detail-dialog").close();
    });
    byId("back-daily-vote").addEventListener("click", backDailyPanels);
    byId("feature-detail-dialog").addEventListener("click", (event) => {
      if (event.target === event.currentTarget) event.currentTarget.close();
    });
    byId("feature-detail-dialog").addEventListener("close", () => {
      resetFeatureSelection({ restoreFocus: true });
    });
    resetFeatureSelection();
  }

  function setText(id, value) {
    const element = byId(id);
    if (element) element.textContent = value ?? "";
  }

  function create(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) {
      element.textContent = window.MrzhI18n?.t
        ? window.MrzhI18n.t(text)
        : text;
    }
    return element;
  }

  function identityExpiryLabel(value) {
    const expiry = value
      ? new Intl.DateTimeFormat(window.MrzhI18n.language(), {
          timeZone: configuredTimezone(),
          dateStyle: "long",
          timeStyle: "short"
        }).format(new Date(value))
      : window.MrzhI18n.t("永久有效");
    return window.MrzhI18n.format("识别码有效期：{date}", { date: expiry });
  }

  function identityRenewalNoticeKey(value) {
    if (!value) return "";
    const expiryTime = new Date(value).getTime();
    if (!Number.isFinite(expiryTime)) return "";
    const remaining = expiryTime - Date.now();
    if (remaining > 7 * 24 * 60 * 60 * 1000) return "";
    return remaining <= 0
      ? "识别码已过期，请申请延期；延期审批期间，过期识别码可额外投票一次。"
      : "识别码将在 7 天内到期，请及时申请延期；延期审批期间，过期识别码可额外投票一次。";
  }

  function showVoteSuccessDialog({ kind, data, message, title = "投票成功", kicker = "" }) {
    const isTest = Boolean(data?.publicTestVote);
    const renewalNoticeKey = isTest
      ? ""
      : identityRenewalNoticeKey(data?.identityCodeExpiresAt);
    setText(
      "vote-success-kicker",
      window.MrzhI18n.t(
        kicker || (kind === "daily" ? "DAILY VOTING" : "TECHNOLOGY VOTE")
      )
    );
    setText("vote-success-title", window.MrzhI18n.t(title));
    setText("vote-success-message", message);
    setText(
      "vote-success-expiry",
      isTest ? "" : identityExpiryLabel(data?.identityCodeExpiresAt)
    );
    setText(
      "vote-success-renewal",
      renewalNoticeKey ? window.MrzhI18n.t(renewalNoticeKey) : ""
    );
    const renewal = byId("vote-success-renewal");
    if (renewal) renewal.hidden = isTest;
    const dialog = byId("vote-success-dialog");
    if (dialog && !dialog.open) dialog.showModal();
  }

  async function request(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.error || payload.title || `HTTP ${response.status}`);
      Object.assign(error, payload, { status: response.status });
      throw error;
    }
    return payload;
  }

  function categoryName(value) {
    const source = { military: "军事", agriculture: "农业", industry: "工业" }[value];
    return source ? window.MrzhI18n.t(source) : value;
  }

  function laneName(value) {
    return window.MrzhI18n.t(
      value === "core" ? "类型科技（第一行）" : "通用科技（第二行）"
    );
  }

  function taskName(value) {
    const source = {
      tech_switch: "更新科技",
      contribution_sync: "更新贡献",
      inactivity_sync: "更新斩杀预警",
      member_profile_sync: "更新成员资料",
      member_sync: "成员同步",
      patrol: "营地巡逻"
    }[value];
    return source ? window.MrzhI18n.t(source) : value;
  }

  function pluginEnabled(id) {
    return (state.data?.plugins || []).some(
      (plugin) => plugin.id === id && plugin.enabled
    );
  }

  function applyPluginVisibility() {
    const sections = {
      inactivity: ["warnings"],
      "member-profile": ["members", "staff"]
    };
    for (const [pluginId, ids] of Object.entries(sections)) {
      const enabled = pluginEnabled(pluginId);
      for (const id of ids) {
        const section = byId(id);
        if (section && !enabled) section.hidden = true;
        for (const link of document.querySelectorAll(
          `[href="#${id}"], [data-feature-target="${id}"]`
        )) {
          link.hidden = !enabled;
        }
      }
    }
  }

  function stateName(value) {
    const source = {
      queued: "排队",
      claimed: "已领取",
      running: "执行中",
      cancelling: "中断中",
      interrupted: "已中断",
      succeeded: "成功",
      partially_succeeded: "部分完成",
      failed: "失败",
      timed_out: "已超时",
      skipped: "已跳过"
    }[value];
    return source ? window.MrzhI18n.t(source) : value;
  }

  function optionMap(summary) {
    return new Map((summary.options || []).map((option) => [option.key, option]));
  }

  function requiredVoteKeys(summary, key, result = new Set(), visiting = new Set()) {
    if (result.has(key) || visiting.has(key)) return result;
    const option = optionMap(summary).get(key);
    if (!option) return result;
    visiting.add(key);
    if (option.prerequisiteKey) {
      requiredVoteKeys(summary, option.prerequisiteKey, result, visiting);
    }
    visiting.delete(key);
    result.add(key);
    return result;
  }

  function configuredVoteLimit(summary) {
    const value = Number(summary?.voteLimit);
    return Number.isInteger(value) && value >= 0 && value <= 12 ? value : 6;
  }

  function removeVoteAndDependents(summary, key) {
    const before = state.selections.size;
    state.selections.delete(key);
    let changed = true;
    while (changed) {
      changed = false;
      for (const option of summary.options || []) {
        if (
          state.selections.has(option.key) &&
          option.prerequisiteKey &&
          !state.selections.has(option.prerequisiteKey) &&
          optionMap(summary).has(option.prerequisiteKey)
        ) {
          state.selections.delete(option.key);
          changed = true;
        }
      }
    }
    return before - state.selections.size;
  }

  function toggleVote(summary, option) {
    const feedback = byId("vote-feedback");
    if (state.selections.has(option.key)) {
      const removed = removeVoteAndDependents(summary, option.key);
      feedback.textContent =
        removed > 1
          ? window.MrzhI18n.t(
              "取消前置科技时，依赖它的科技也会一并取消。"
            )
          : "";
      renderVote(summary);
      return;
    }
    const required = requiredVoteKeys(summary, option.key);
    const additions = [...required].filter((key) => !state.selections.has(key));
    const voteLimit = configuredVoteLimit(summary);
    if (state.selections.size + additions.length > voteLimit) {
      feedback.textContent = window.MrzhI18n.format(
        "选择该科技及其前置科技后将超过 {limit} 票。",
        { limit: voteLimit }
      );
      return;
    }
    for (const key of additions) state.selections.add(key);
    feedback.textContent = option.prerequisiteName
      ? window.MrzhI18n.format(
          "已同时选择前置科技：{name}",
          { name: option.prerequisiteName }
        )
      : "";
    renderVote(summary);
  }

  function renderVote(summary) {
    setText("poll-date", summary.pollDate || "--");
    setText(
      "vote-deadline",
      window.MrzhI18n.format("开放时间 {opensAt}–{closesAt} {timezone} · 共 {count} 人投票", {
        count: summary.ballotCount || 0,
        opensAt: summary.opensAt || "--",
        closesAt: summary.closesAt || "--",
        timezone: summary.timezone || ""
      })
    );
    const voteLimit = configuredVoteLimit(summary);
    setText(
      "vote-limit-description",
      window.MrzhI18n.format(
        "每人最多可投票 {limit} 票，多次投票以最新一次投票结果为准，不选择科技提交投票可以撤回投票或投空票。",
        { limit: voteLimit }
      )
    );
    const voteWindowState = byId("vote-window-state");
    if (voteWindowState) {
      voteWindowState.classList.toggle("is-open", summary.isOpen !== false);
      voteWindowState.textContent = window.MrzhI18n.t(
        summary.isOpen === false ? "当前未开放" : "当前可投票"
      );
    }
    const root = byId("vote-options");
    root.replaceChildren();
    renderVoteSelection(summary);
    byId("submit-vote").disabled =
      summary.isOpen === false || !summary.options?.length;
    if (!summary.options?.length) {
      root.append(create("p", "empty-state", "管理员尚未开放科技投票。"));
      return;
    }
    for (const lane of ["core", "general"]) {
      const options = summary.options.filter((option) => option.lane === lane);
      if (!options.length) continue;
      const section = create("section", "vote-lane");
      section.append(
        create(
          "h3",
          "vote-lane-title",
          lane === "core"
            ? window.MrzhI18n.t("类型科技（第一行）")
            : window.MrzhI18n.t("其他科技（第二行）")
        )
      );
      const grid = create("div", "vote-lane-grid");
      for (const option of options) {
        const button = create("button", "vote-option");
        button.type = "button";
        button.disabled = summary.isOpen === false;
        button.dataset.key = option.key;
        button.dataset.selected = String(state.selections.has(option.key));
        if (option.iconUrl) {
          const image = document.createElement("img");
          image.className = "tech-icon";
          image.src = option.iconUrl;
          image.alt = "";
          image.loading = "lazy";
          button.append(image);
        } else {
          button.append(
            create(
              "span",
              "tech-icon tech-icon-placeholder",
              option.name.slice(0, 1)
            )
          );
        }
        const copy = create("span", "tech-copy");
        copy.append(create("strong", "", option.name));
        copy.append(
          create(
            "small",
            "",
            `${categoryName(option.category)} · ${laneName(option.lane)}`
          )
        );
        if (option.prerequisiteName) {
          copy.append(
            create(
              "small",
              "tech-prerequisite",
              window.MrzhI18n.format("前置科技：{name}", {
                name: option.prerequisiteName
              })
            )
          );
        }
        if (option.description) {
          copy.append(create("span", "tech-description", option.description));
        }
        button.append(
          copy,
          create(
            "span",
            "vote-count",
            `${option.votes} ${window.MrzhI18n.t("票")}`
          )
        );
        button.addEventListener("click", () => toggleVote(summary, option));
        grid.append(button);
      }
      section.append(grid);
      root.append(section);
    }
  }

  function renderVoteSelection(summary, target = byId("vote-selection-preview")) {
    const root = target;
    if (!root) return;
    root.replaceChildren();
    const fixedKeys = new Set(
      (summary.fixedTechnologies || []).map((item) => item.key)
    );
    for (const lane of ["core", "general"]) {
      const row = create("section", "vote-selection-row");
      row.append(
        create(
          "span",
          "vote-selection-label",
          lane === "core"
            ? window.MrzhI18n.t("类型科技")
            : window.MrzhI18n.t("其他科技")
        )
      );
      const slots = create("div", "vote-selection-slots");
      const technologies = summary.projectedPlan?.[lane] || [];
      for (let index = 0; index < 6; index += 1) {
        const option = technologies[index];
        const sourceClass = option
          ? fixedKeys.has(option.key)
            ? " is-fixed"
            : " is-voted"
          : "";
        const slot = create(
          "span",
          `vote-selection-slot${option ? " is-filled" : ""}${sourceClass}`
        );
        if (option?.iconUrl) {
          const image = document.createElement("img");
          image.src = option.iconUrl;
          image.alt = option.name;
          slot.append(image);
        } else if (option) {
          slot.textContent = option.name.slice(0, 1);
        } else {
          slot.textContent = "+";
        }
        if (option) slot.title = option.name;
        slots.append(slot);
      }
      row.append(slots);
      root.append(row);
    }
  }

  function renderHighlights(items) {
    const root = byId("highlights");
    root.replaceChildren();
    const entries = (items || []).map((item) =>
      typeof item === "string"
        ? { blocks: [{ type: "text", text: item }] }
        : item
    );
    if (!entries.length) {
      root.append(create("p", "empty-state", "当前没有需要公示的营地公告。"));
      return;
    }
    for (const [index, item] of entries.entries()) {
      const blocks = Array.isArray(item?.blocks) ? item.blocks : [];
      const card = create("article", "highlight-item");
      const header = create("div", "highlight-item-header");
      header.append(
        create("span", "highlight-item-index", String(index + 1).padStart(2, "0")),
        create("span", "highlight-item-label", "营地公告")
      );
      card.append(header);
      for (const block of blocks) {
        if (block?.type === "image" && /^https:\/\//i.test(String(block.url || ""))) {
          const figure = document.createElement("figure");
          figure.className = "highlight-image";
          const image = document.createElement("img");
          image.src = block.url;
          image.alt = block.alt || window.MrzhI18n.t("营地公告图片");
          image.loading = "lazy";
          image.decoding = "async";
          image.tabIndex = 0;
          image.setAttribute("role", "button");
          image.setAttribute("aria-label", window.MrzhI18n.t("点击查看大图"));
          image.title = window.MrzhI18n.t("点击查看大图");
          image.addEventListener("click", () => openImagePreview(block.url, image.alt));
          image.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              openImagePreview(block.url, image.alt);
            }
          });
          image.addEventListener("error", () => {
            figure.classList.add("is-broken");
          }, { once: true });
          figure.append(image);
          card.append(figure);
        } else if (block?.type === "text" && String(block.text || "").trim()) {
          const copy = document.createElement("p");
          copy.className = "highlight-copy";
          copy.textContent = block.text;
          card.append(copy);
        }
      }
      if (card.childElementCount > 1) root.append(card);
    }
  }

  function renderRichBlocks(root, blocks, emptyText = "") {
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (block?.type === "image" && /^https:\/\//i.test(String(block.url || ""))) {
        const figure = document.createElement("figure");
        figure.className = "highlight-image daily-rich-image";
        const image = document.createElement("img");
        image.src = block.url;
        image.alt = block.alt || window.MrzhI18n.t("公告图片");
        image.loading = "lazy";
        image.decoding = "async";
        image.tabIndex = 0;
        image.setAttribute("role", "button");
        image.setAttribute("aria-label", window.MrzhI18n.t("点击查看大图"));
        image.addEventListener("click", () => openImagePreview(block.url, image.alt));
        image.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openImagePreview(block.url, image.alt);
          }
        });
        figure.append(image);
        root.append(figure);
      } else if (block?.type === "text" && String(block.text || "").trim()) {
        root.append(create("p", "daily-rich-text", block.text));
      }
    }
    if (!root.childElementCount && emptyText) root.append(create("p", "empty-state", emptyText));
  }

  function dailyDate(value) {
    return value ? formatDate(value) : "—";
  }

  function dailyKindName(kind) {
    return window.MrzhI18n.t(kind === "draw" ? "抽签事项" : "投票事项");
  }

  function dailySelections(itemId) {
    const values = state.dailySelections[itemId];
    return Array.isArray(values) ? values : [];
  }

  function renderDailyItem(item) {
    const card = create("article", `daily-vote-item daily-vote-item-${item.kind}`);
    const heading = create("div", "daily-vote-item-heading");
    const title = create("div", "daily-vote-item-title");
    renderRichBlocks(title, item.titleBlocks, window.MrzhI18n.t("未命名事项"));
    heading.append(title, create("span", "daily-vote-kind", dailyKindName(item.kind)));
    card.append(heading);
    const description = create("div", "daily-vote-description");
    renderRichBlocks(description, item.descriptionBlocks);
    if (description.childElementCount) card.append(description);
    const meta = create("div", "daily-vote-meta");
    meta.append(
      create("span", "daily-vote-meta-item", window.MrzhI18n.format(
        "投票时间 {start} - {end} ({timezone})",
        {
          start: formatVoteDateTime(item.startAt),
          end: formatVoteDateTime(item.endAt),
          timezone: configuredTimezone()
        }
      ))
    );
    if (item.kind === "poll") {
      meta.append(create("span", "daily-vote-meta-item", window.MrzhI18n.format("每人可选 {count} 项", {
        count: item.maxSelections
      })));
    } else {
      meta.append(create("span", "daily-vote-meta-item", window.MrzhI18n.format("抽取 {count} 人 · 已报名 {participants} 人", {
        count: item.drawCount,
        participants: item.participantCount || 0
      })));
    }
    card.append(meta);
    if (item.kind === "poll") {
      const selected = new Set(dailySelections(item.id));
      const options = create("div", "daily-vote-options");
      for (const option of item.options || []) {
        const button = create("button", `daily-vote-option${selected.has(option.id) ? " is-selected" : ""}`);
        button.type = "button";
        button.disabled = item.isOpen === false;
        const content = create("span", "daily-vote-option-content");
        renderRichBlocks(content, option.blocks, window.MrzhI18n.t("未命名选项"));
        button.append(content, create("strong", "daily-vote-option-count", window.MrzhI18n.format("{count} 票", {
          count: option.votes || 0
        })));
        button.addEventListener("click", () => {
          const next = new Set(dailySelections(item.id));
          if (next.has(option.id)) next.delete(option.id);
          else if (next.size < Number(item.maxSelections || 0)) next.add(option.id);
          else {
            setText("daily-vote-status", window.MrzhI18n.format("最多选择 {count} 项", { count: item.maxSelections }));
            return;
          }
          state.dailySelections[item.id] = [...next];
          renderDailyVote(state.data?.dailyVote || {});
        });
        options.append(button);
      }
      card.append(options);
    }
    const action = create("div", "daily-vote-item-action");
    const submit = create(
      "button",
      "button button-primary",
      window.MrzhI18n.t(item.kind === "draw" ? "提交抽签" : "提交投票")
    );
    submit.type = "button";
    submit.disabled = item.isOpen === false;
    submit.addEventListener("click", () => submitDailyVote(item));
    action.append(submit);
    card.append(action);
    return card;
  }

  function renderDailyHistory(payload) {
    const root = byId("daily-vote-history");
    if (!root) return;
    root.replaceChildren();
    const technology = payload?.technologyHistory || [];
    const technologySection = create("section", "daily-history-group");
    technologySection.append(
      create(
        "h4",
        "daily-history-group-title",
        window.MrzhI18n.t("科技投票 · 最近 7 天")
      )
    );
    if (!technology.length) {
      technologySection.append(create("p", "empty-state", "当天无投票记录"));
    }
    for (const item of technology) {
      const card = create("article", "daily-history-card");
      card.append(create("strong", "daily-history-card-title", item.pollDate));
      const fixedTechnologies = Array.isArray(item.fixedTechnologies) ? item.fixedTechnologies : [];
      const hasRecords = Number(item.ballotCount || 0) > 0 || fixedTechnologies.length > 0;
      if (hasRecords) {
        const preview = create("div", "vote-selection-preview daily-history-selection-preview");
        renderVoteSelection(item, preview);
        card.append(preview);
        const fixedKeys = new Set(fixedTechnologies.map((fixed) => fixed.key));
        const result = create("div", "daily-history-result-list");
        for (const tech of [...(item.projectedPlan?.core || []), ...(item.projectedPlan?.general || [])]) {
          if (fixedKeys.has(tech.key)) continue;
          result.append(create("span", "daily-history-result is-voted", window.MrzhI18n.format("{name} · {count} 票", {
            name: tech.name,
            count: (item.options || []).find((option) => option.key === tech.key)?.votes || 0
          })));
        }
        for (const fixed of fixedTechnologies) {
          result.append(create("span", "daily-history-result is-fixed", window.MrzhI18n.format("{name} · 固定", { name: fixed.name })));
        }
        if (result.childElementCount) card.append(result);
      } else {
        card.append(create("p", "empty-state", "当天无投票记录"));
      }
      technologySection.append(card);
    }
    root.append(technologySection);
    for (const [kind, items] of [["poll", payload?.history?.polls || []], ["draw", payload?.history?.draws || []]]) {
      const section = create("section", "daily-history-group");
      section.append(
        create(
          "h4",
          "daily-history-group-title",
          window.MrzhI18n.t(
            kind === "poll" ? "投票事项 · 最近 14 天" : "抽签事项 · 最近 14 天"
          )
        )
      );
      if (!items.length) {
        section.append(create("p", "empty-state", kind === "poll" ? "暂无历史投票事项。" : "暂无历史抽签事项。"));
      }
      for (const item of items) {
        const card = create("article", "daily-history-card");
        const title = create("div", "daily-history-card-title");
        renderRichBlocks(title, item.titleBlocks, window.MrzhI18n.t("未命名事项"));
        card.append(title, create("small", "muted", window.MrzhI18n.format(
          "投票时间 {start} - {end} ({timezone}) · 参与 {count} 人",
          {
            start: formatVoteDateTime(item.startAt),
            end: formatVoteDateTime(item.endAt),
            timezone: configuredTimezone(),
            count: item.participantCount || 0
          }
        )));
        if (kind === "poll") {
          const result = create("div", "daily-history-result-list");
          for (const option of item.options || []) {
            const optionText = create("span", "daily-history-result");
            renderRichBlocks(optionText, option.blocks);
            optionText.append(create("strong", "daily-history-result-count", window.MrzhI18n.format("{count} 票", { count: option.votes || 0 })));
            result.append(optionText);
          }
          card.append(result);
        } else {
          const winners = create("div", "daily-history-result-list");
          const winnerList = Array.isArray(item.winners)
            ? item.winners.filter(winner => winner && String(winner.playerName || "").trim())
            : [];
          if (winnerList.length) {
            card.append(create("p", "daily-history-winner-label", "中签人名单："));
          }
          for (const winner of winnerList) {
            winners.append(create("span", "daily-history-result is-winner", winner.playerName));
          }
          card.append(winners.childElementCount ? winners : create("p", "empty-state", "本次抽签无人报名"));
        }
        section.append(card);
      }
      root.append(section);
    }
    if (!root.childElementCount) root.append(create("p", "empty-state", "暂无历史投票结果。"));
  }

  function renderDailyVote(payload) {
    const root = byId("daily-vote-items");
    if (!root) return;
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const historyCount = (payload?.technologyHistory || []).length +
      (payload?.history?.polls || []).length +
      (payload?.history?.draws || []).length;
    root.replaceChildren();
    renderIdentityAccount();
    setText("feature-vote-count", String(dailyVoteFeatureCount(payload)));
    setText("daily-tech-panel-count", "1");
    setText("daily-items-panel-count", String(items.length));
    setText("daily-history-panel-count", String(historyCount));
    setText("daily-vote-status", items.length ? "" : window.MrzhI18n.t("当前没有开放事项。"));
    for (const item of items) root.append(renderDailyItem(item));
    renderDailyHistory(payload || {});
    const panelList = byId("daily-vote-panels");
    const panelDetail = byId("daily-vote-panel-detail");
    if (panelList) panelList.hidden = Boolean(state.dailyPanel);
    if (panelDetail) panelDetail.hidden = !state.dailyPanel;
    for (const panel of document.querySelectorAll("[data-daily-panel-content]")) {
      panel.hidden = panel.dataset.dailyPanelContent !== state.dailyPanel;
    }
    if (state.activeFeature === "vote") syncFeatureDetailKicker();
    setText("hero-vote-count", String(dailyVoteFeatureCount(payload)));
    setText("feature-vote-count", String(dailyVoteFeatureCount(payload)));
    syncDailyFeatureBackButton();
  }

  function openDailyPanel(panel) {
    if (!["identity", "technology", "items", "history"].includes(panel)) return;
    if (state.activeFeature !== "vote") return;
    state.dailyPanel = panel;
    syncDailyFeatureBackButton();
    renderDailyVote(state.data?.dailyVote || {});
    if (panel === "identity") void refreshIdentitySession();
  }

  function backDailyPanels() {
    state.dailyPanel = "";
    syncDailyFeatureBackButton();
    renderDailyVote(state.data?.dailyVote || {});
  }

  async function submitDailyVote(item) {
    if (!requireIdentitySession()) return;
    const { identityCode, password } = identitySession();
    const selections = item.kind === "poll" ? dailySelections(item.id) : [];
    if (item.kind === "poll" && !selections.length) {
      setText("daily-vote-status", window.MrzhI18n.t("请至少选择一项。"));
      return;
    }
    try {
      setText("daily-vote-status", window.MrzhI18n.t("正在提交…"));
      const payload = await request("/api/public/daily-vote", {
        method: "POST",
        body: JSON.stringify({
          itemId: item.id,
          identityCode,
          identityPassword: password,
          locale: window.MrzhI18n.language(),
          selections
        })
      });
      state.dailySelections[item.id] = [];
      if (state.data) state.data.dailyVote = payload;
      renderDailyVote(payload);
      setText("daily-vote-status", window.MrzhI18n.t("提交成功，票数已更新。"));
      showVoteSuccessDialog({
        kind: "daily",
        data: payload,
        message: payload.renewalGraceUsed
            ? window.MrzhI18n.t("投票已提交；本次已使用延期审批期间唯一一次过期投票机会。")
            : window.MrzhI18n.t("提交成功，票数已更新。")
      });
    } catch (error) {
      if (IDENTITY_SESSION_INVALID_CODES.has(error.code)) {
        clearIdentitySession({ openPanel: true });
      }
      const message = error.code === "vote_eligibility_failed"
        ? window.MrzhI18n.t("您尚未满足投票资格贡献与活跃度标准。")
        : window.MrzhI18n.t(error.message);
      showVoteError(message, window.MrzhI18n.t("日常投票未提交"), error.code === "identity_code_expired" && error.canRenew, identityCode);
    }
  }

  function openImagePreview(
    url,
    alt = window.MrzhI18n.t("营地公告图片")
  ) {
    const dialog = byId("image-preview-dialog");
    const image = byId("image-preview");
    if (!dialog || !image) {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    image.src = url;
    image.alt = alt;
    if (typeof dialog.showModal === "function") {
      if (!dialog.open) dialog.showModal();
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  function renderStaff(items) {
    const root = byId("staff-list");
    root.replaceChildren();
    if (!items?.length) {
      root.append(create("p", "empty-state", "公职数据等待同步。"));
      return;
    }
    for (const item of items) {
      const card = create("article", "staff-card");
      card.append(
        create(
          "strong",
          "",
          item.role_name || item.roleName || window.MrzhI18n.t("公职")
        ),
        create(
          "span",
          "",
          item.member_name || item.memberName || window.MrzhI18n.t("待同步")
        )
      );
      root.append(card);
    }
    const updated = items.map((item) => item.updated_at).filter(Boolean).sort().at(-1);
    setText(
      "staff-updated",
      updated
        ? window.MrzhI18n.format("更新于 {date}", { date: formatDate(updated) })
        : ""
    );
  }

  function renderMembers(items) {
    const query = state.memberQuery.toLowerCase();
    const filtered = (items || []).filter((item) =>
      [item.name, item.profession, item.roommate_name, item.camp_title]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query))
    );
    const root = byId("member-table");
    const cardsRoot = byId("member-cards");
    root.replaceChildren();
    cardsRoot?.replaceChildren();
    byId("member-empty").hidden = filtered.length > 0;
    for (const item of filtered) {
      const row = document.createElement("tr");
      for (const [value, className] of [
        [item.name, ""],
        [item.profession || "—", ""],
        [item.manor_level ?? "—", "numeric"],
        [item.roommate_name || "—", ""],
        [item.weekly_contribution ?? 0, "numeric"],
        [item.technology_points_used ?? 0, "numeric"],
        [item.material_contribution ?? 0, "numeric"],
        [item.weekly_activity_points ?? 0, "numeric"]
      ]) {
        row.append(create("td", className, String(value)));
      }
      root.append(row);

      if (cardsRoot) {
        const card = create("article", "member-responsive-card");
        const heading = create("div", "member-responsive-heading");
        heading.append(
          create("strong", "member-responsive-name", String(item.name || "—")),
          create(
            "span",
            "member-responsive-detail",
            `${item.profession || "—"} · ${window.MrzhI18n.t("庄园")} ${item.manor_level ?? "—"}`
          ),
          create(
            "span",
            "member-responsive-detail",
            `${window.MrzhI18n.t("同居")}：${item.roommate_name || "—"}`
          )
        );
        const metrics = create("div", "member-responsive-metrics");
        for (const [value, label] of [
          [item.weekly_contribution ?? 0, "本周贡献"],
          [item.technology_points_used ?? 0, "使用科技点"],
          [item.material_contribution ?? 0, "贡献物资"],
          [item.weekly_activity_points ?? 0, "周活跃点"]
        ]) {
          const metric = create("div", "member-responsive-metric");
          metric.append(
            create("strong", "", String(value)),
            create("span", "", window.MrzhI18n.t(label))
          );
          metrics.append(metric);
        }
        card.append(heading, metrics);
        cardsRoot.append(card);
      }
    }
  }

  function renderWarnings(items, thresholdDays) {
    setText(
      "warning-description",
      window.MrzhI18n.format(
        "根据营地惯例，离线超过 {days} 天的玩家可能会被请离营地。",
        { days: thresholdDays }
      )
    );
    setText("warning-count", String(items.length));
    byId("warning-empty").hidden = items.length > 0;
    const root = byId("warning-list");
    root.replaceChildren();
    for (const item of items) {
      const card = create("article", "warning-card");
      card.append(
        create("strong", "", item.name),
        create(
          "span",
          "",
          item.last_active_text ||
            window.MrzhI18n.format("{days} 天前", { days: item.inactive_days })
        )
      );
      root.append(card);
    }
  }

  function renderRuns(items) {
    const root = byId("run-list");
    root.replaceChildren();
    if (!items?.length) {
      root.append(create("p", "empty-state", "暂无自动任务记录。"));
      return;
    }
    for (const item of items) {
      const row = create("div", "run-item");
      row.append(
        create("time", "muted", formatDate(item.finishedAt || item.createdAt)),
        create("strong", "", taskName(item.taskKey)),
        create(
          "span",
          `status-badge status-${item.state}`,
          stateName(item.state)
        )
      );
      root.append(row);
    }
  }

  function formatDate(value) {
    if (!value) return "—";
    const locale = {
      "zh-cn": "zh-CN",
      "zh-tw": "zh-TW",
      en: "en",
      fr: "fr",
      ja: "ja"
    }[window.MrzhI18n.language()] || "zh-CN";
    return new Intl.DateTimeFormat(locale, {
      timeZone: configuredTimezone(),
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(new Date(value));
  }

  function formatVoteDateTime(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    try {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: configuredTimezone(),
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23"
        })
          .formatToParts(date)
          .filter((part) => part.type !== "literal")
          .map((part) => [part.type, part.value])
      );
      const hour = parts.hour === "24" ? "00" : parts.hour;
      return `${parts.year}/${parts.month}/${parts.day} ${hour}:${parts.minute}`;
    } catch (_) {
      return formatDate(value);
    }
  }

  function formatIdentityExpiry(value, timezone) {
    if (!value) return window.MrzhI18n.t("永久有效");
    const source = timezone || configuredTimezone();
    const locale = {
      "zh-cn": "zh-CN",
      "zh-tw": "zh-TW",
      en: "en",
      fr: "fr",
      ja: "ja"
    }[window.MrzhI18n.language()] || "zh-CN";
    const formatted = new Intl.DateTimeFormat(locale, {
      timeZone: source,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(new Date(value));
    return `${formatted} (${source})`;
  }

  function configuredTimezone() {
    return state.data?.campConfig?.timezone || "Asia/Shanghai";
  }

  function render(data) {
    state.data = data;
    applyPluginVisibility();
    document.documentElement.dataset.timezone =
      data.campConfig?.timezone || "Asia/Shanghai";
    const siteName = data.siteName || window.MrzhI18n.t("明日之后“愿”营地助手");
    document.title = window.MrzhI18n.t(siteName);
    setText("site-name", window.MrzhI18n.t(siteName));
    setText(
      "camp-name",
      data.campConfig?.campName || window.MrzhI18n.t("未命名营地")
    );
    setText(
      "server-name",
      data.campConfig?.serverName || window.MrzhI18n.t("中国大陆服务器")
    );
    setText("announcement", data.publicOverview?.announcement || "");
    setText("timezone-label", data.campConfig?.timezone || "Asia/Shanghai");
    const listedMemberCount = data.members?.length || 0;
    const reportedMemberCount = Number(data.memberSummary?.expectedCount);
    const totalMemberCount = Number.isInteger(reportedMemberCount) && reportedMemberCount >= 0
      ? reportedMemberCount
      : listedMemberCount;
    setText("hero-member-count", String(totalMemberCount));
    setText(
      "member-list-count",
      window.MrzhI18n.format("当前列表 {listed} / 总人数 {total}", {
        listed: listedMemberCount,
        total: totalMemberCount
      })
    );
    setText(
      "hero-warning-count",
      String(data.inactivityWarnings?.length || 0)
    );
    setText(
      "hero-vote-count",
      String(data.voteSummary?.ballotCount || 0)
    );
    const highlightCount = Array.isArray(data.publicOverview?.highlights)
      ? data.publicOverview.highlights.length
      : 0;
    setText("feature-overview-count", String(highlightCount));
    setText("overview-count", String(highlightCount));
    setText("feature-staff-count", String(data.staffAssignments?.length || 0));
    setText(
      "feature-warning-count",
      String(data.inactivityWarnings?.length || 0)
    );
    setText("feature-vote-count", String(dailyVoteFeatureCount(data.dailyVote)));
    setText("feature-members-count", String(totalMemberCount));
    setText("feature-runs-count", String(data.recentRuns?.length || 0));
    const memberSync = (data.recentRuns || []).find(
      (run) =>
        run.taskKey === "member_profile_sync" &&
        ["succeeded", "partially_succeeded"].includes(run.state)
    );
    setText(
      "sync-state",
      memberSync
        ? window.MrzhI18n.format("已同步 {date}", {
            date: formatDate(memberSync.finishedAt)
          })
        : window.MrzhI18n.t("等待首次同步")
    );
    renderHighlights(data.publicOverview?.highlights || []);
    renderVote(data.voteSummary || { options: [] });
    renderDailyVote(data.dailyVote || {});
    renderStaff(data.staffAssignments || []);
    renderWarnings(
      data.inactivityWarnings || [],
      data.campConfig?.inactivityWarningDays || 1
    );
    renderMembers(data.members || []);
    renderRuns(data.recentRuns || []);
    if (state.activeFeature) {
      const activeCard = document.querySelector(
        `.feature-card[data-feature-target="${state.activeFeature}"]`
      );
      if (activeCard && !activeCard.hidden) {
        showFeature(state.activeFeature, { updateHash: false });
      } else {
        byId("feature-detail-dialog")?.close();
      }
    }
  }

  async function load() {
    try {
      render(
        await request(
          `/api/public/bootstrap?t=${Date.now()}&locale=${encodeURIComponent(window.MrzhI18n.language())}`
        )
      );
    } catch (error) {
      setText(
        "announcement",
        window.MrzhI18n.format("公共数据加载失败：{message}", {
          message: error.message
        })
      );
    }
  }

  async function refreshFromLiveUpdate() {
    if (document.hidden || !state.data) {
      state.liveDirty = true;
      return;
    }
    if (state.liveRefreshInFlight) {
      state.liveRefreshQueued = true;
      return;
    }
    state.liveRefreshInFlight = true;
    state.liveDirty = false;
    try {
      await load();
    } finally {
      state.liveRefreshInFlight = false;
      if (state.liveRefreshQueued) {
        state.liveRefreshQueued = false;
        void refreshFromLiveUpdate();
      }
    }
  }

  function scheduleLiveReconnect() {
    if (state.liveReconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** state.liveReconnectAttempt);
    state.liveReconnectAttempt = Math.min(state.liveReconnectAttempt + 1, 5);
    state.liveReconnectTimer = window.setTimeout(() => {
      state.liveReconnectTimer = null;
      connectLiveUpdates();
    }, delay);
  }

  function connectLiveUpdates() {
    if (state.liveSocket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.liveSocket.readyState)) {
      return;
    }
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${scheme}//${window.location.host}/api/live?scope=public`
    );
    state.liveSocket = socket;
    socket.addEventListener("open", () => {
      if (state.liveSocket !== socket) return;
      state.liveReconnectAttempt = 0;
      socket.send(JSON.stringify({ type: "subscribe", scope: "public" }));
      void refreshFromLiveUpdate();
    });
    socket.addEventListener("message", (event) => {
      if (state.liveSocket !== socket) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (
        message?.type === "data-changed" &&
        Array.isArray(message.scopes) &&
        message.scopes.includes("public")
      ) {
        void refreshFromLiveUpdate();
      }
    });
    socket.addEventListener("close", () => {
      if (state.liveSocket !== socket) return;
      state.liveSocket = null;
      scheduleLiveReconnect();
    });
    socket.addEventListener("error", () => {
      if (state.liveSocket === socket) socket.close();
    });
  }

  async function submitVote() {
    const button = byId("submit-vote");
    const feedback = byId("vote-feedback");
    if (state.data?.voteSummary?.isOpen === false) {
      feedback.textContent = window.MrzhI18n.t("当前不在科技投票开放时间内。");
      return;
    }
    if (state.selections.size > configuredVoteLimit(state.data?.voteSummary)) {
      feedback.textContent = window.MrzhI18n.format("每人最多选择 {limit} 项科技。", {
        limit: configuredVoteLimit(state.data?.voteSummary)
      });
      return;
    }
    if (!requireIdentitySession()) return;
    const { identityCode, password } = identitySession();
    button.disabled = true;
    feedback.textContent = window.MrzhI18n.t("正在提交…");
    try {
      const summary = await request("/api/public/tech-vote", {
        method: "POST",
        body: JSON.stringify({
          identityCode,
          identityPassword: password,
          locale: window.MrzhI18n.language(),
          selections: [...state.selections]
        })
      });
      state.selections.clear();
      if (state.data) state.data.voteSummary = summary;
      renderVote(summary);
      feedback.textContent = summary.voteWithdrawn
        ? window.MrzhI18n.t("投票已撤回，当前不计入投票人数。")
        : window.MrzhI18n.t("投票已保存，可在截止前再次修改。");
      showVoteSuccessDialog({
        kind: "technology",
        data: summary,
        message: summary.voteWithdrawn
          ? window.MrzhI18n.t("投票已撤回，当前不计入投票人数。")
          : summary.renewalGraceUsed
              ? window.MrzhI18n.t("投票已提交；本次已使用延期审批期间唯一一次过期投票机会。")
              : window.MrzhI18n.t("投票已保存，可在截止前再次修改。")
      });
    } catch (error) {
      const message =
        error.code === "rate_limited" ||
        error.code === "identity_code_rate_limited"
          ? window.MrzhI18n.format("尝试次数过多，请在 {seconds} 秒后重试。", {
              seconds: error.retryAfterSeconds || "—"
            })
          : error.code === "vote_eligibility_failed"
            ? window.MrzhI18n.t("您尚未满足投票资格贡献与活跃度标准。")
          : window.MrzhI18n.t(error.message);
      showVoteError(
        message,
        window.MrzhI18n.t("投票未提交"),
        error.code === "identity_code_expired" && error.canRenew,
        identityCode
      );
      if (IDENTITY_SESSION_INVALID_CODES.has(error.code)) {
        clearIdentitySession({ openPanel: true });
      }
    } finally {
      button.disabled = false;
    }
  }

  function showVoteError(
    message,
    title = window.MrzhI18n.t("投票未提交"),
    canRenew = false,
    identityCode = ""
  ) {
    setText("vote-feedback", message);
    setText("vote-error-title", title);
    setText("vote-error-message", message);
    state.voteErrorRenewalCode = canRenew ? identityCode : "";
    byId("vote-error-renew").hidden = !canRenew;
    const dialog = byId("vote-error-dialog");
    if (!dialog.open) dialog.showModal();
  }

  function showIdentityApplicationError(message) {
    setText("identity-application-error-message", window.MrzhI18n.t(message));
    const dialog = byId("identity-application-error-dialog");
    if (!dialog.open) dialog.showModal();
  }

  function showIdentityApplicationSuccess(message, notice) {
    setText("identity-application-success-title", window.MrzhI18n.t("申请已提交"));
    setText("identity-application-success-message", message);
    setText(
      "identity-application-success-notice",
      notice || window.MrzhI18n.t(
        "申请已成功提交，预计于48小时内完成审核，请留意邮箱的审核结果邮件。"
      )
    );
    const applicationDialog = byId("identity-application-dialog");
    if (applicationDialog?.open) applicationDialog.close();
    const dialog = byId("identity-application-success-dialog");
    if (dialog && !dialog.open) dialog.showModal();
  }

  function openIdentityEligibilityApplication() {
    const session = identitySession();
    if (!session) return;
    byId("identity-eligibility-application-reason").value = "";
    setText("identity-eligibility-application-feedback", "");
    byId("identity-eligibility-application-dialog").showModal();
  }

  async function submitIdentityEligibilityApplication(event) {
    event.preventDefault();
    const session = identitySession();
    if (!session) return;
    const reason = byId("identity-eligibility-application-reason").value.trim();
    const feedback = byId("identity-eligibility-application-feedback");
    if (!reason) {
      feedback.textContent = window.MrzhI18n.t("请填写申请理由");
      return;
    }
    const button = byId("identity-eligibility-application-submit");
    button.disabled = true;
    feedback.textContent = window.MrzhI18n.t("正在提交申请…");
    try {
      await request("/api/public/vote-eligibility-applications", {
        method: "POST",
        body: JSON.stringify({
          identityCode: session.identityCode,
          identityPassword: session.password,
          locale: window.MrzhI18n.language(),
          reason
        })
      });
      byId("identity-eligibility-application-dialog").close();
      showIdentityApplicationSuccess(
        window.MrzhI18n.t("申请已提交，管理员将在48小时内完成审核。"),
        window.MrzhI18n.t("请留意邮箱的审核结果邮件。")
      );
    } catch (error) {
      feedback.textContent = window.MrzhI18n.t(error.message);
    } finally {
      button.disabled = false;
    }
  }

  function openNewApplication() {
    state.identityMode = "new";
    state.renewalCode = "";
    state.renewalApplicationNumber = "";
    state.identityApplicationVerificationId = "";
    state.identityApplicationVerificationToken = "";
    setText("identity-dialog-title", window.MrzhI18n.t("申请身份识别码"));
    byId("identity-renewal-number").hidden = true;
    byId("identity-email").value = "";
    byId("identity-player-name").value = "";
    byId("identity-recovery-number-field").hidden = true;
    byId("identity-reissue-code-field").hidden = true;
    byId("identity-reissue-application-number-field").hidden = true;
    byId("identity-renewal-application-number-field").hidden = true;
    byId("identity-renewal-code-field").hidden = true;
    byId("identity-email-field").hidden = false;
    byId("identity-player-name-field").hidden = false;
    byId("identity-rules").hidden = false;
    byId("identity-recovery-rules").hidden = true;
    byId("identity-reissue-rules").hidden = true;
    byId("identity-renewal-lookup-rules").hidden = true;
    setText("identity-email-label", window.MrzhI18n.t("接收识别码邮箱"));
    setText("submit-identity-application", window.MrzhI18n.t("提交申请"));
    setText("identity-application-feedback", "");
    byId("identity-application-verification-field").hidden = true;
    byId("identity-application-verification-code").value = "";
    byId("identity-application-dialog").showModal();
  }

  function showRenewalConfirmation(
    preview,
    { identityCode = "", applicationNumber = "" } = {}
  ) {
    state.identityMode = "renewal";
    state.renewalCode = identityCode;
    state.renewalApplicationNumber =
      preview.applicationNumber || applicationNumber;
    setText("identity-dialog-title", window.MrzhI18n.t("申请延长识别码有效期"));
    setText(
      "identity-renewal-number",
      window.MrzhI18n.format("申请编号：{number}", {
        number: preview.applicationNumber
      })
    );
    byId("identity-renewal-number").hidden = false;
    byId("identity-recovery-number-field").hidden = true;
    byId("identity-reissue-code-field").hidden = true;
    byId("identity-reissue-application-number-field").hidden = true;
    byId("identity-renewal-application-number-field").hidden = true;
    byId("identity-renewal-code-field").hidden = true;
    byId("identity-email-field").hidden = false;
    byId("identity-player-name-field").hidden = false;
    byId("identity-rules").hidden = false;
    byId("identity-recovery-rules").hidden = true;
    byId("identity-reissue-rules").hidden = true;
    byId("identity-renewal-lookup-rules").hidden = true;
    setText("identity-email-label", window.MrzhI18n.t("接收识别码邮箱"));
    setText("identity-player-name-label", window.MrzhI18n.t("玩家名称"));
    setText("submit-identity-application", window.MrzhI18n.t("提交延期申请"));
    byId("identity-email").value = preview.email;
    byId("identity-player-name").value = preview.playerName;
    setText("identity-application-feedback", "");
    const dialog = byId("identity-application-dialog");
    if (!dialog.open) dialog.showModal();
  }

  async function openRenewal(identityCode, applicationNumber = "") {
    const feedback = byId("vote-feedback");
    try {
      const preview = await request("/api/public/identity-code-renewal-preview", {
        method: "POST",
        body: JSON.stringify({ identityCode, applicationNumber })
      });
      showRenewalConfirmation(preview, { identityCode, applicationNumber });
    } catch (error) {
      feedback.textContent =
        error.code === "rate_limited" ||
        error.code === "identity_code_rate_limited"
          ? window.MrzhI18n.format("尝试次数过多，请在 {seconds} 秒后重试。", {
              seconds: error.retryAfterSeconds || "—"
            })
          : window.MrzhI18n.t(error.message);
    }
  }

  function openRenewalLookup(identityCode = "") {
    state.identityMode = "renewal-lookup";
    state.renewalCode = "";
    state.renewalApplicationNumber = "";
    setText("identity-dialog-title", window.MrzhI18n.t("申请延长识别码有效期"));
    byId("identity-renewal-number").hidden = true;
    byId("identity-recovery-number-field").hidden = true;
    byId("identity-reissue-code-field").hidden = true;
    byId("identity-reissue-application-number-field").hidden = true;
    byId("identity-renewal-application-number-field").hidden = false;
    byId("identity-renewal-code-field").hidden = false;
    byId("identity-email-field").hidden = true;
    byId("identity-player-name-field").hidden = true;
    byId("identity-rules").hidden = true;
    byId("identity-recovery-rules").hidden = true;
    byId("identity-reissue-rules").hidden = true;
    byId("identity-renewal-lookup-rules").hidden = false;
    byId("identity-renewal-application-number").value = "";
    byId("identity-renewal-code").value = identityCode;
    setText("submit-identity-application", window.MrzhI18n.t("下一步：核对信息"));
    setText("identity-application-feedback", "");
    byId("identity-application-dialog").showModal();
  }

  function openReissue(identityCode = "") {
    state.identityMode = "reissue-lookup";
    state.renewalCode = "";
    state.renewalApplicationNumber = "";
    state.reissueCode = "";
    state.reissueApplicationNumber = "";
    state.reissueEmail = "";
    state.reissuePlayerName = "";
    state.identityApplicationVerificationId = "";
    state.identityApplicationVerificationToken = "";
    setText("identity-dialog-title", window.MrzhI18n.t("申请更换身份识别码"));
    byId("identity-renewal-number").hidden = true;
    byId("identity-recovery-number-field").hidden = true;
    byId("identity-reissue-application-number-field").hidden = false;
    byId("identity-reissue-code-field").hidden = false;
    byId("identity-renewal-application-number-field").hidden = true;
    byId("identity-renewal-code-field").hidden = true;
    byId("identity-email-field").hidden = false;
    byId("identity-player-name-field").hidden = true;
    byId("identity-rules").hidden = true;
    byId("identity-recovery-rules").hidden = true;
    byId("identity-reissue-rules").hidden = false;
    byId("identity-renewal-lookup-rules").hidden = true;
    setText("identity-email-label", window.MrzhI18n.t("申请时预留的邮箱"));
    setText("submit-identity-application", window.MrzhI18n.t("下一步：核对信息"));
    byId("identity-reissue-application-number").value = "";
    byId("identity-reissue-code").value = identityCode;
    byId("identity-email").value = "";
    byId("identity-player-name").value = "";
    setText("identity-application-feedback", "");
    byId("identity-application-verification-field").hidden = true;
    byId("identity-application-verification-code").value = "";
    byId("identity-application-dialog").showModal();
  }

  function showReissueConfirmation(preview, lookup) {
    state.identityMode = "reissue";
    state.reissueCode = lookup.identityCode;
    state.reissueApplicationNumber =
      lookup.applicationNumber || preview.applicationNumber || "";
    state.reissueEmail = lookup.email || preview.email;
    state.reissuePlayerName = lookup.playerName;
    setText("identity-dialog-title", window.MrzhI18n.t("申请更换身份识别码"));
    setText(
      "identity-renewal-number",
      window.MrzhI18n.format("申请编号：{number}", {
        number: preview.applicationNumber
      })
    );
    byId("identity-renewal-number").hidden = false;
    byId("identity-recovery-number-field").hidden = true;
    byId("identity-reissue-code-field").hidden = true;
    byId("identity-reissue-application-number-field").hidden = true;
    byId("identity-renewal-application-number-field").hidden = true;
    byId("identity-renewal-code-field").hidden = true;
    byId("identity-email-field").hidden = false;
    byId("identity-player-name-field").hidden = true;
    byId("identity-rules").hidden = true;
    byId("identity-recovery-rules").hidden = true;
    byId("identity-reissue-rules").hidden = false;
    byId("identity-renewal-lookup-rules").hidden = true;
    setText("identity-email-label", window.MrzhI18n.t("申请时预留的邮箱"));
    setText("submit-identity-application", window.MrzhI18n.t("提交更换申请"));
    byId("identity-email").value = lookup.email || preview.email;
    byId("identity-player-name").value = "";
    setText("identity-application-feedback", "");
  }

  function openIdentityRecovery() {
    state.identityMode = "recovery";
    state.renewalCode = "";
    state.renewalApplicationNumber = "";
    setText("identity-dialog-title", window.MrzhI18n.t("找回身份识别码"));
    byId("identity-renewal-number").hidden = true;
    byId("identity-recovery-number-field").hidden = false;
    byId("identity-reissue-code-field").hidden = true;
    byId("identity-reissue-application-number-field").hidden = true;
    byId("identity-renewal-application-number-field").hidden = true;
    byId("identity-renewal-code-field").hidden = true;
    byId("identity-email-field").hidden = false;
    byId("identity-player-name-field").hidden = false;
    byId("identity-rules").hidden = true;
    byId("identity-recovery-rules").hidden = false;
    byId("identity-reissue-rules").hidden = true;
    byId("identity-renewal-lookup-rules").hidden = true;
    setText(
      "identity-email-label",
      window.MrzhI18n.t("申请时预留的邮箱")
    );
    setText("identity-player-name-label", window.MrzhI18n.t("玩家名称"));
    byId("identity-recovery-number").value = "";
    byId("identity-email").value = "";
    byId("identity-player-name").value = "";
    setText("submit-identity-application", window.MrzhI18n.t("发送识别码到预留邮箱"));
    setText("identity-application-feedback", "");
    byId("identity-application-dialog").showModal();
  }

  async function submitIdentityApplication(event) {
    event.preventDefault();
    const button = byId("submit-identity-application");
    const feedback = byId("identity-application-feedback");
    const renewalLookup = state.identityMode === "renewal-lookup";
    const reissueLookup = state.identityMode === "reissue-lookup";
    const renewalLookupApplicationNumber =
      byId("identity-renewal-application-number").value.trim();
    const renewalLookupCode = byId("identity-renewal-code").value.trim();
    if (
      renewalLookup &&
      !renewalLookupApplicationNumber &&
      !renewalLookupCode
    ) {
      feedback.textContent = window.MrzhI18n.t(
        "请填写申请编号或身份识别码"
      );
      return;
    }
    if (
      reissueLookup &&
      !byId("identity-reissue-application-number").value.trim() &&
      !byId("identity-reissue-code").value.trim() &&
      !byId("identity-email").value.trim()
    ) {
      feedback.textContent = window.MrzhI18n.t(
        "请至少填写申请编号、申请时预留邮箱或旧识别码中的一项。"
      );
      return;
    }
    if (
      state.identityMode === "reissue" &&
        !byId("identity-email").value.trim()
    ) {
      feedback.textContent = window.MrzhI18n.t(
        "请核对申请时预留邮箱"
      );
      return;
    }
    const email = byId("identity-email").value.trim();
    const playerName = byId("identity-player-name").value.trim();
    if (state.identityMode === "new" && !state.identityApplicationVerificationId) {
      if (!email || !playerName) {
        feedback.textContent = window.MrzhI18n.t("请填写邮箱和玩家名称。");
        return;
      }
      button.disabled = true;
      try {
        const challenge = await request("/api/public/identity-application-verification", {
          method: "POST",
          body: JSON.stringify({ action: "request", purpose: "new", email, playerName, locale: window.MrzhI18n.language() })
        });
        state.identityApplicationVerificationId = challenge.challengeId;
        byId("identity-application-verification-field").hidden = false;
        setText("submit-identity-application", window.MrzhI18n.t("验证邮箱并提交申请"));
        feedback.textContent = window.MrzhI18n.t("验证码已发送到邮箱，请填写后再次提交。");
      } catch (error) {
        feedback.textContent = window.MrzhI18n.t(error.message);
      } finally {
        button.disabled = false;
      }
      return;
    }
    button.disabled = true;
    feedback.textContent = window.MrzhI18n.t("正在提交…");
    try {
      if ((state.identityMode === "new" || state.identityMode === "reissue") &&
          state.identityApplicationVerificationId && !state.identityApplicationVerificationToken) {
        const verified = await request("/api/public/identity-application-verification", {
          method: "POST",
          body: JSON.stringify({
            action: "verify",
            purpose: state.identityMode,
            challengeId: state.identityApplicationVerificationId,
            otp: byId("identity-application-verification-code").value.trim()
          })
        });
        state.identityApplicationVerificationToken = verified.verificationToken;
      }
      if (renewalLookup) {
        const preview = await request(
          "/api/public/identity-code-renewal-preview",
          {
            method: "POST",
            body: JSON.stringify({
              identityCode: renewalLookupCode,
              applicationNumber: renewalLookupApplicationNumber
            })
          }
        );
        showRenewalConfirmation(preview, {
          identityCode: renewalLookupCode,
          applicationNumber: renewalLookupApplicationNumber
        });
        return;
      }
      if (reissueLookup) {
        const lookup = {
          applicationNumber:
            byId("identity-reissue-application-number").value.trim(),
          identityCode: byId("identity-reissue-code").value.trim(),
          email: byId("identity-email").value.trim()
        };
        const preview = await request(
          "/api/public/identity-code-reissue-preview",
          {
            method: "POST",
            body: JSON.stringify(lookup)
          }
        );
        showReissueConfirmation(preview, lookup);
        return;
      }
      if (state.identityMode === "reissue" && !state.identityApplicationVerificationId) {
        const challenge = await request("/api/public/identity-application-verification", {
          method: "POST",
          body: JSON.stringify({
            action: "request",
            purpose: "reissue",
            identityCode: state.reissueCode,
            applicationNumber: state.reissueApplicationNumber,
            email: state.reissueEmail,
            locale: window.MrzhI18n.language()
          })
        });
        state.identityApplicationVerificationId = challenge.challengeId;
        byId("identity-application-verification-field").hidden = false;
        setText("submit-identity-application", window.MrzhI18n.t("验证邮箱并提交更换申请"));
        feedback.textContent = window.MrzhI18n.t("验证码已发送到邮箱，请填写后再次提交。");
        return;
      }
      const common = {
        email: byId("identity-email").value.trim(),
        playerName: byId("identity-player-name").value.trim(),
        locale: window.MrzhI18n.language()
      };
      const result =
        state.identityMode === "renewal"
          ? await request("/api/public/identity-code-renewal", {
              method: "POST",
              body: JSON.stringify({
                ...common,
                identityCode: state.renewalCode,
                applicationNumber: state.renewalApplicationNumber
              })
            })
          : state.identityMode === "reissue"
            ? await request("/api/public/identity-code-reissue", {
                method: "POST",
                body: JSON.stringify({
                  email: common.email,
                  locale: common.locale,
                  identityCode: state.reissueCode,
                  applicationNumber: state.reissueApplicationNumber,
                  lookupEmail: state.reissueEmail,
                  verificationId: state.identityApplicationVerificationId,
                  verificationToken: state.identityApplicationVerificationToken
                })
              })
          : state.identityMode === "recovery"
            ? await request("/api/public/identity-code-recovery", {
                method: "POST",
                body: JSON.stringify({
                  ...common,
                  applicationNumber: byId("identity-recovery-number").value.trim()
                })
              })
            : await request("/api/public/identity-code-applications", {
                method: "POST",
                body: JSON.stringify({
                  ...common,
                  verificationId: state.identityApplicationVerificationId,
                  verificationToken: state.identityApplicationVerificationToken
                })
              });
      if (state.identityMode === "recovery") {
        feedback.textContent = window.MrzhI18n.t(
          result.expired
            ? "识别码已发送至预留邮箱；该识别码已过期，可以申请延期。"
            : "识别码已发送至预留邮箱。"
        );
      } else {
        const applicationMessage = window.MrzhI18n.format(
          state.identityMode === "renewal"
            ? "延期申请已提交，申请编号：{number}。原有效期内可正常投票；过期后审批期间可额外投票一次。"
            : state.identityMode === "reissue"
              ? "更换申请已提交，申请编号：{number}。旧识别码已作废。"
            : "申请已提交，申请编号：{number}。",
          { number: result.applicationNumber }
        );
        feedback.textContent = applicationMessage;
        showIdentityApplicationSuccess(applicationMessage);
      }
    } catch (error) {
      const message =
        error.code === "rate_limited" ||
        error.code === "identity_code_rate_limited"
          ? window.MrzhI18n.format("尝试次数过多，请在 {seconds} 秒后重试。", {
              seconds: error.retryAfterSeconds || "—"
            })
          : window.MrzhI18n.t(error.message);
      feedback.textContent = message;
      if (
        error.message === ACTIVE_IDENTITY_CONFLICT ||
        error.message === EXPIRED_IDENTITY_CONFLICT
      ) {
        showIdentityApplicationError(error.message);
      }
    } finally {
      button.disabled = false;
    }
  }

  byId("submit-vote").addEventListener("click", submitVote);
  state.identitySession = loadIdentitySession();
  renderIdentityAccount();
  for (const panel of document.querySelectorAll("[data-daily-panel]")) {
    panel.addEventListener("click", () => openDailyPanel(panel.dataset.dailyPanel));
  }
  byId("identity-login-form").addEventListener("submit", loginIdentity);
  byId("identity-forgot-password").addEventListener("click", beginIdentityPasswordReset);
  byId("identity-password-reset-form").addEventListener("submit", requestPasswordReset);
  byId("identity-password-verify-form").addEventListener("submit", verifyPasswordReset);
  byId("identity-password-set-form").addEventListener("submit", setPasswordReset);
  byId("close-identity-password-reset").addEventListener("click", () => {
    byId("identity-password-reset-dialog").close();
  });
  byId("identity-apply").addEventListener("click", openNewApplication);
  byId("identity-recover").addEventListener("click", openIdentityRecovery);
  byId("identity-cancel").addEventListener("click", openIdentityCancellationDialog);
  byId("identity-cancel-logged-in").addEventListener("click", openIdentityCancellationDialog);
  byId("identity-cancellation-form").addEventListener("submit", submitIdentityCancellation);
  byId("close-identity-cancellation-dialog").addEventListener("click", () => {
    byId("identity-cancellation-dialog").close();
  });
  byId("identity-renew").addEventListener("click", () => openRenewalLookup(identitySession()?.identityCode || ""));
  byId("identity-reissue").addEventListener("click", () => openReissue(identitySession()?.identityCode || ""));
  byId("identity-update-name").addEventListener("click", () => openIdentityProfileDialog("name"));
  byId("identity-change-email").addEventListener("click", () => openIdentityProfileDialog("email"));
  byId("identity-renew-logged-in").addEventListener("click", () => openRenewalLookup(identitySession()?.identityCode || ""));
  byId("identity-reissue-logged-in").addEventListener("click", () => openReissue(identitySession()?.identityCode || ""));
  byId("identity-profile-form").addEventListener("submit", submitIdentityProfile);
  byId("close-identity-profile-dialog").addEventListener("click", () => byId("identity-profile-dialog").close());
  byId("identity-eligibility-info")?.addEventListener("click", openIdentityEligibilityDialog);
  byId("identity-eligibility-apply")?.addEventListener("click", openIdentityEligibilityApplication);
  byId("identity-eligibility-application-form")?.addEventListener("submit", submitIdentityEligibilityApplication);
  byId("identity-eligibility-application-close")?.addEventListener("click", () => {
    byId("identity-eligibility-application-dialog").close();
  });
  byId("identity-logout").addEventListener("click", () => {
    clearIdentitySession();
    setText("identity-profile-feedback", window.MrzhI18n.t("已退出身份识别码账号。"));
  });
  byId("vote-error-renew").addEventListener("click", () => {
    const identityCode = state.voteErrorRenewalCode;
    byId("vote-error-dialog").close();
    if (identityCode) openRenewal(identityCode);
  });
  byId("image-preview-dialog").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
  byId("image-preview-dialog").addEventListener("close", () => {
    byId("image-preview").removeAttribute("src");
  });
  byId("identity-application-form").addEventListener(
    "submit",
    submitIdentityApplication
  );
  byId("close-identity-dialog").addEventListener("click", () => {
    byId("identity-application-dialog").close();
  });
  byId("member-search").addEventListener("input", (event) => {
    state.memberQuery = event.target.value || "";
    renderMembers(state.data?.members || []);
  });
  initFeatureNavigation();
  document.addEventListener("mrzh:languagechange", () => {
    if (state.data) render(state.data);
    syncFeatureDetailKicker();
    load();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.liveDirty) void refreshFromLiveUpdate();
    if (!document.hidden) {
      connectLiveUpdates();
      void refreshIdentitySession({ force: true });
    }
  });
  state.identitySessionRefreshTimer = window.setInterval(() => {
    if (!document.hidden) void refreshIdentitySession({ force: true });
  }, IDENTITY_SESSION_REFRESH_INTERVAL_MS);
  load();
  connectLiveUpdates();
  void refreshIdentitySession({ force: true });
})();
