import { describe, expect, it } from "vitest";
import {
  DEFAULT_VOTE_ELIGIBILITY_THRESHOLDS,
  activeVoteEligibilityOverride,
  evaluateVoteEligibility,
  getVoteEligibilityStats,
  isVoteEligible,
  normalizeVoteEligibilityThresholds
} from "../src/vote-eligibility";

describe("vote eligibility thresholds", () => {
  it("uses the configured defaults and accepts zero technology points", () => {
    expect(normalizeVoteEligibilityThresholds(undefined)).toEqual(
      DEFAULT_VOTE_ELIGIBILITY_THRESHOLDS
    );
    expect(normalizeVoteEligibilityThresholds({ technologyPoints: 0 })).toEqual(
      DEFAULT_VOTE_ELIGIBILITY_THRESHOLDS
    );
  });

  it("requires an identity-code member match and every configured metric", () => {
    const thresholds = DEFAULT_VOTE_ELIGIBILITY_THRESHOLDS;
    const current = {
      matchedMember: true,
      playerName: "测试用户",
      ...thresholds
    };
    expect(isVoteEligible(current, thresholds)).toBe(true);
    expect(isVoteEligible({ ...current, matchedMember: false }, thresholds)).toBe(false);
    expect(isVoteEligible({ ...current, weeklyActivityPoints: 24 }, thresholds)).toBe(false);
  });

  it("uses zero for every statistic when the member data is unavailable", async () => {
    const env = {
      DB: {
        prepare() {
          return {
            all: async () => ({ results: [] })
          };
        }
      }
    } as unknown as Env;
    await expect(getVoteEligibilityStats(env, "尚未同步的玩家")).resolves.toEqual({
      matchedMember: false,
      playerName: "尚未同步的玩家",
      weeklyContribution: 0,
      technologyPoints: 0,
      materialContribution: 0,
      weeklyActivityPoints: 0
    });
  });

  it("accepts exactly one active exception mode at evaluation time", async () => {
    const env = {
      DB: {
        prepare() {
          return { all: async () => ({ results: [] }) };
        }
      }
    } as unknown as Env;
    expect(activeVoteEligibilityOverride({ votesRemaining: 2, expiresAt: null })).toEqual({
      votesRemaining: 2,
      expiresAt: null
    });
    await expect(evaluateVoteEligibility(env, {
      playerName: "未同步玩家",
      enabled: true,
      thresholds: DEFAULT_VOTE_ELIGIBILITY_THRESHOLDS,
      override: { votesRemaining: 1, expiresAt: null }
    })).resolves.toMatchObject({ eligible: true, overrideApplied: true });
  });

  it("keeps an administrator prohibition effective despite qualifying stats, exceptions, or disabled checks", async () => {
    const env = {
      DB: {
        prepare() {
          return {
            all: async () => ({
              results: [{
                name: "已达标玩家",
                identity_code_id: "identity-1",
                weekly_contribution: 10_000,
                technology_points_used: 10_000,
                material_contribution: 100_000,
                weekly_activity_points: 100
              }]
            })
          };
        }
      }
    } as unknown as Env;

    await expect(evaluateVoteEligibility(env, {
      playerName: "已达标玩家",
      identityCodeId: "identity-1",
      enabled: false,
      prohibited: true,
      thresholds: DEFAULT_VOTE_ELIGIBILITY_THRESHOLDS,
      override: { votesRemaining: 5, expiresAt: null }
    })).resolves.toMatchObject({
      enabled: false,
      eligible: false,
      prohibited: true,
      overrideApplied: false
    });
  });

  it("treats an admin eligibility exemption as eligible without a break-glass request", async () => {
    const env = {
      DB: {
        prepare() {
          return { all: async () => ({ results: [] }) };
        }
      }
    } as unknown as Env;
    const input = {
      playerName: "未达标玩家",
      identityCodeId: "identity-1",
      enabled: true,
      bypassed: true,
      thresholds: DEFAULT_VOTE_ELIGIBILITY_THRESHOLDS
    };

    await expect(evaluateVoteEligibility(env, input)).resolves.toMatchObject({
      eligible: true,
      bypassed: true,
      override: null,
      overrideApplied: false
    });
    await expect(evaluateVoteEligibility(env, { ...input, prohibited: true })).resolves.toMatchObject({
      eligible: false,
      prohibited: true,
      bypassed: true
    });
  });
});
