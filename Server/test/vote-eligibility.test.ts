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
});
