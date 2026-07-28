import { loadConfig } from "./config.mjs";

try {
  const config = await loadConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(
      `http://${config.debug.host}:${config.debug.port}/health`,
      {
        headers: {
          authorization: `Bearer ${config.debug.token}`
        },
        signal: controller.signal
      }
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const health = await response.json();
    console.log(
      JSON.stringify({
        online: health.ok === true,
        activeRunId: health.activeRunId || null,
        activeTaskKey: health.activeTaskKey || null,
        adbSerial: health.adbSerial || null
      })
    );
    if (health.ok !== true) process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
} catch (error) {
  console.error(
    JSON.stringify({
      online: false,
      error:
        error.name === "AbortError"
          ? "health check timed out"
          : error.message
    })
  );
  process.exitCode = 1;
}
