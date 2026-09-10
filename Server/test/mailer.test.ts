import { describe, expect, it, vi } from "vitest";

vi.mock("worker-mailer", () => ({
  WorkerMailer: { send: vi.fn() }
}));

import { identityMail, identityRecoveryMail, type SupportedLocale } from "../src/mailer";

const locales: SupportedLocale[] = ["zh-cn", "zh-tw", "en", "fr", "ja"];

describe("identity email templates", () => {
  it("uses the daily voting copy in every supported locale", () => {
    for (const locale of locales) {
      const message = identityMail({
        locale,
        approved: true,
        requestType: "new",
        applicationNumber: "APP-123",
        playerName: "A&B <player>",
        code: "ID-456",
        expiresAt: "2026-09-30"
      });

      expect(message.text).not.toContain("仅由本人用于科技投票");
      expect(message.html).toContain("https://www.yume.zone/img/logo.png");
      expect(message.html).toContain("<!DOCTYPE html>");
      expect(message.html).toContain("A&amp;B &lt;player&gt;");
    }
  });

  it("renders recovery mail with the same branded card layout", () => {
    const message = identityRecoveryMail({
      locale: "zh-cn",
      applicationNumber: "APP-123",
      playerName: "玩家",
      code: "ID-456",
      expiresAt: null,
      expired: true
    });

    expect(message.text).toContain("日常投票");
    expect(message.text).toContain("可在网页或小程序中申请延期");
    expect(message.html).toContain("background-color:#1e293b");
    expect(message.html).toContain("border-radius:20px");
  });

  it("includes the administrator rejection reason in rejection emails", () => {
    for (const locale of locales) {
      const message = identityMail({
        locale,
        approved: false,
        requestType: "new",
        applicationNumber: "APP-123",
        playerName: "玩家",
        reason: "不符合营地成员条件"
      });

      expect(message.text).toContain("不符合营地成员条件");
      expect(message.html).toContain("不符合营地成员条件");
    }
  });
});
