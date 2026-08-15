import { describe, expect, it } from "vitest";
import { BUILT_IN_TECHNOLOGY_CATALOG } from "../src/built-in-technology-catalog";
import {
  canUseExpiredRenewalGrace,
  identityPlayerNameKey,
  isIdentityCodeExpired,
  isIdentityRenewalWindowOpen,
  isSequentialIdentityCode
} from "../src/identity-code-utils";
import {
  localizeTechnology,
  TECHNOLOGY_LOCALIZATIONS
} from "../src/technology-localizations";
import { localizeWorkerEvent } from "../src/task-localization";
import { validatePublicOverview } from "../src/validate";

describe("identity code rules", () => {
  it("rejects ascending and descending eight-digit sequences", () => {
    expect(isSequentialIdentityCode("12345678")).toBe(true);
    expect(isSequentialIdentityCode("87654321")).toBe(true);
    expect(isSequentialIdentityCode("90123456")).toBe(true);
    expect(isSequentialIdentityCode("48302715")).toBe(false);
  });

  it("opens renewal exactly seven days before expiry and rejects permanent codes", () => {
    const current = Date.parse("2026-07-30T00:00:00.000Z");
    expect(
      isIdentityRenewalWindowOpen("2026-08-06T00:00:00.000Z", current)
    ).toBe(true);
    expect(
      isIdentityRenewalWindowOpen("2026-08-06T00:00:00.001Z", current)
    ).toBe(false);
    expect(isIdentityRenewalWindowOpen(null, current)).toBe(false);
  });

  it("uses renewal grace only after expiry, never before the original expiry", () => {
    const current = Date.parse("2026-07-30T00:00:00.000Z");
    const futureExpiry = "2026-07-31T00:00:00.000Z";
    const expiredAt = "2026-07-29T23:59:59.000Z";

    expect(isIdentityCodeExpired(futureExpiry, current)).toBe(false);
    expect(
      canUseExpiredRenewalGrace({
        expiresAt: futureExpiry,
        pendingRenewal: true,
        graceVoteUsedAt: null,
        currentTime: current
      })
    ).toBe(false);
    expect(
      canUseExpiredRenewalGrace({
        expiresAt: expiredAt,
        pendingRenewal: true,
        graceVoteUsedAt: null,
        currentTime: current
      })
    ).toBe(true);
    expect(
      canUseExpiredRenewalGrace({
        expiresAt: expiredAt,
        pendingRenewal: true,
        graceVoteUsedAt: "2026-07-30T00:00:00.000Z",
        currentTime: current
      })
    ).toBe(false);
  });

  it("matches player names after Unicode normalization and decorative-symbol removal", () => {
    expect(identityPlayerNameKey("  ＃W月之歌  ")).toBe(
      identityPlayerNameKey("#W月之歌")
    );
    expect(identityPlayerNameKey("W・月 之歌")).toBe(
      identityPlayerNameKey("W月之歌")
    );
    expect(identityPlayerNameKey("人间冷暖")).not.toBe(
      identityPlayerNameKey("人间冷眼")
    );
  });
});

describe("five-language public content", () => {
  it("provides a translated name and description for every built-in technology", () => {
    expect(Object.keys(TECHNOLOGY_LOCALIZATIONS)).toHaveLength(
      BUILT_IN_TECHNOLOGY_CATALOG.length
    );
    for (const technology of BUILT_IN_TECHNOLOGY_CATALOG) {
      for (const locale of ["zh-tw", "en", "fr", "ja"] as const) {
        const localized = localizeTechnology(technology, locale);
        expect(localized.name.length).toBeGreaterThan(0);
        expect(localized.description?.length).toBeGreaterThan(0);
        if (locale !== "zh-tw") {
          expect(localized.name).not.toBe(technology.name);
        }
      }
    }
  });

  it("localizes Worker task events from the Agent's five-language payload", () => {
    const event = localizeWorkerEvent(
      {
        message: "正在启动明日之后",
        detail_json: JSON.stringify({
          localizedMessages: {
            "zh-cn": "正在启动明日之后",
            "zh-tw": "正在啟動明日之後",
            en: "Starting LifeAfter",
            fr: "Démarrage de LifeAfter",
            ja: "LifeAfter を起動しています"
          }
        })
      },
      "fr"
    );
    expect(event.message).toBe("Démarrage de LifeAfter");
    expect(localizeWorkerEvent(event, "ja").message).toBe(
      "LifeAfter を起動しています"
    );
  });

  it("copies legacy announcements to all languages by default", () => {
    const overview = validatePublicOverview({
      announcement: "公告",
      highlights: ["第一条"]
    });
    expect(overview.localized.en).toEqual({
      announcement: "公告",
      highlights: ["第一条"]
    });
    expect(overview.localized.ja).toEqual(overview.localized["zh-cn"]);
  });
});
