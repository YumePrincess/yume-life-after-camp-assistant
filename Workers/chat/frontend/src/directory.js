import { ref } from "vue";
import { createRealtimeSession } from "./realtime-session.js";
import { connectDirectorySocket } from "./ws.js";

export const onlineUserIds = ref(new Set());
export const presenceReady = ref(false);
const listeners = new Set();
export function onDirectoryChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function invalidate() {
  for (const listener of listeners) listener();
}

export function createDirectoryConnection() {
  let socket = null,
    lastFrame = 0,
    hasSnapshot = false,
    heartbeat = null;
  const connection = createRealtimeSession({
    openConnection: (_params, handlers) => connectDirectorySocket(handlers),
    onMessage(payload) {
      lastFrame = Date.now();
      if (payload.type !== "directory_changed") return;
      onlineUserIds.value = new Set((payload.onlineUserIds || []).map(Number));
      presenceReady.value = true;
      if (payload.directoryChanged || !hasSnapshot) invalidate();
      hasSnapshot = true;
    },
    onStatus(event) {
      socket = event.status === "open" ? event.socket : null;
      if (event.status !== "open") {
        presenceReady.value = false;
        onlineUserIds.value = new Set();
        hasSnapshot = false;
      }
    },
  });
  function ping() {
    if (socket?.readyState === 1) {
      if (lastFrame && Date.now() - lastFrame > 75_000)
        socket.close(4000, "Directory heartbeat timed out");
      else socket.send(JSON.stringify({ type: "ping" }));
    }
  }
  function resume() {
    if (document.visibilityState !== "visible") return;
    ping();
    connection.connect("directory");
    invalidate();
  }
  return {
    connect() {
      connection.connect("directory");
      heartbeat = setInterval(ping, 20_000);
      document.addEventListener("visibilitychange", resume);
      window.addEventListener("online", resume);
      window.addEventListener("pageshow", resume);
    },
    disconnect() {
      clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("pageshow", resume);
      connection.disconnect();
    },
  };
}
