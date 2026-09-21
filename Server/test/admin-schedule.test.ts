import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("admin task schedule cards", () => {
  it("binds the weekly activity card to its registered task key", () => {
    const html = readFileSync(resolve(process.cwd(), "public/admin.html"), "utf8");
    expect(html).toContain('data-plugin-task="weekly_activity_sync"');
    expect(html).not.toContain('data-plugin-task="weekly-activity"');
  });
});
