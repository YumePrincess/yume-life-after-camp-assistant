/** Invalidate authenticated chat directories after successful identity/group changes. */
export function chatDirectoryMutation(
  request: Request,
  response: Response,
): boolean {
  if (
    response.status < 200 ||
    response.status >= 300 ||
    ["GET", "HEAD", "OPTIONS"].includes(request.method)
  )
    return false;
  const path = new URL(request.url).pathname;
  return (
    /^\/api\/(admin|public)\/identity(?:-|\/)/.test(path) ||
    /^\/chat\/api\/channels(?:\/|$)/.test(path)
  );
}

export async function notifyChatDirectory(env: Env): Promise<void> {
  if (!env.USER_INBOX) return;
  try {
    const result = await env.USER_INBOX.getByName("identity-roster").fetch(
      "https://cfchat.internal/directory/change",
      {
        method: "POST",
        headers: { "x-cfchat-internal-auth": "worker-verified" },
      },
    );
    if (!result.ok)
      throw new Error(`Directory invalidation failed: ${result.status}`);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "chat_directory_invalidation_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
