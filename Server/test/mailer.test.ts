import { describe, expect, it, vi } from "vitest";

vi.mock("worker-mailer", () => ({
  WorkerMailer: { send: vi.fn() }
}));

import {
  identityCancellationCompletedMail,
  identityMail,
  identityProfileChangeMail,
  identityRecoveryMail,
  voteEligibilityMail,
  type SupportedLocale
} from "../src/mailer";

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

  it("renders profile-change approval and rejection notices", () => {
    const approved = identityProfileChangeMail({
      locale: "zh-cn",
      approved: true,
      kind: "email",
      applicationNumber: "APP-123",
      currentValue: "old@example.com",
      requestedValue: "new@example.com"
    });
    expect(approved.subject).toContain("身份资料变更申请已通过");
    expect(approved.text).toContain("old@example.com");
    expect(approved.text).toContain("new@example.com");

    const rejected = identityProfileChangeMail({
      locale: "en",
      approved: false,
      kind: "player_name",
      currentValue: "Old name",
      requestedValue: "New name",
      reason: "Not allowed"
    });
    expect(rejected.subject).toContain("Identity profile change rejected");
    expect(rejected.text).toContain("Not allowed");
  });

  it("includes the administrator rejection reason separately from the application reason", () => {
    const message = voteEligibilityMail({
      locale: "zh-cn",
      approved: false,
      applicationNumber: "APP-ELIGIBILITY-123",
      playerName: "玩家",
      reason: "申请人希望参加本次投票。",
      rejectionReason: "当前资料未达到破格审批条件。",
      weeklyContribution: 1200,
      technologyPoints: 0,
      materialContribution: 42000,
      weeklyActivityPoints: 18,
      votes: null,
      expiresAt: null
    });

    expect(message.text).toContain("申请理由: 申请人希望参加本次投票。");
    expect(message.text).toContain("管理员拒绝理由: 当前资料未达到破格审批条件。");
    expect(message.html).toContain("当前资料未达到破格审批条件。");
  });

  it("renders a localized cancellation completion notice", () => {
    const message = identityCancellationCompletedMail({
      locale: "ja",
      playerName: "プレイヤー"
    });
    expect(message.subject).toContain("解約が完了");
    expect(message.text).toContain("プレイヤー");
    expect(message.text).toContain("取り消せません");
  });
});
