import { reactive } from "vue";
import api from "./api.js";
import { requireHostIdentity } from "./host-navigation.js";
import { addAuthInvalidListener } from "./auth-storage.js";
const state = reactive({
  ready: false,
  session: null,
  site: { siteName: "互动中心", siteIconUrl: "" },
});
function returnToIdentity() {
  state.session = null;
  requireHostIdentity();
}
async function initialize() {
  try {
    state.session = (await api.session()).session;
  } catch {
    state.session = null;
    returnToIdentity();
  } finally {
    state.ready = true;
  }
}
addAuthInvalidListener(returnToIdentity);
// A restored tab must not keep an old identity profile or an expired session.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void initialize();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.ready) void initialize();
});
export default {
  get ready() {
    return state.ready;
  },
  get session() {
    return state.session;
  },
  get token() {
    return "";
  },
  get site() {
    return state.site;
  },
  initialize,
  setSession(session) {
    state.session = session;
  },
  setSite(site) {
    state.site = site;
  },
  async loadSite() {
    return state.site;
  },
};
