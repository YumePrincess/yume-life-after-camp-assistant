import { identityPlayerNameKey } from "./identity-code-utils";

export interface VoteEligibilityThresholds {
  weeklyContribution: number;
  technologyPoints: number;
  materialContribution: number;
  weeklyActivityPoints: number;
}

export interface VoteEligibilityStats extends VoteEligibilityThresholds {
  matchedMember: boolean;
  playerName: string;
}

export interface VoteEligibilityOverride {
  votesRemaining: number | null;
  expiresAt: string | null;
}

export interface VoteEligibilityResult {
  enabled: boolean;
  eligible: boolean;
  thresholds: VoteEligibilityThresholds;
  current: VoteEligibilityStats;
  override: VoteEligibilityOverride | null;
  overrideApplied: boolean;
}

export const DEFAULT_VOTE_ELIGIBILITY_THRESHOLDS: VoteEligibilityThresholds = {
  weeklyContribution: 1_500,
  technologyPoints: 0,
  materialContribution: 50_000,
  weeklyActivityPoints: 25
};

function integer(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 1_000_000_000) {
    throw new Error(`${field} must be an integer between 0 and 1000000000`);
  }
  return Number(value);
}

export function normalizeVoteEligibilityThresholds(
  value: unknown,
  field = "voteEligibility"
): VoteEligibilityThresholds {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    weeklyContribution: integer(
      source.weeklyContribution,
      `${field}.weeklyContribution`,
      DEFAULT_VOTE_ELIGIBILITY_THRESHOLDS.weeklyContribution
    ),
    technologyPoints: integer(
      source.technologyPoints,
      `${field}.technologyPoints`,
      DEFAULT_VOTE_ELIGIBILITY_THRESHOLDS.technologyPoints
    ),
    materialContribution: integer(
      source.materialContribution,
      `${field}.materialContribution`,
      DEFAULT_VOTE_ELIGIBILITY_THRESHOLDS.materialContribution
    ),
    weeklyActivityPoints: integer(
      source.weeklyActivityPoints,
      `${field}.weeklyActivityPoints`,
      DEFAULT_VOTE_ELIGIBILITY_THRESHOLDS.weeklyActivityPoints
    )
  };
}

function numberValue(value: unknown): number {
  return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
}

export function isVoteEligible(
  current: VoteEligibilityStats,
  thresholds: VoteEligibilityThresholds
): boolean {
  return current.matchedMember &&
    current.weeklyContribution >= thresholds.weeklyContribution &&
    current.technologyPoints >= thresholds.technologyPoints &&
    current.materialContribution >= thresholds.materialContribution &&
    current.weeklyActivityPoints >= thresholds.weeklyActivityPoints;
}

export function activeVoteEligibilityOverride(
  input: {
    votesRemaining?: unknown;
    expiresAt?: unknown;
  } | null | undefined,
  at = new Date()
): VoteEligibilityOverride | null {
  if (!input) return null;
  const votes = Number(input.votesRemaining);
  if (Number.isInteger(votes) && votes > 0) {
    return { votesRemaining: votes, expiresAt: null };
  }
  const expiresAt = typeof input.expiresAt === "string" ? input.expiresAt : null;
  if (expiresAt && Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) > at.getTime()) {
    return { votesRemaining: null, expiresAt };
  }
  return null;
}

export async function consumeVoteEligibilityOverride(
  env: Env,
  identityCodeId: string
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE identity_codes
     SET eligibility_override_votes = CASE
       WHEN eligibility_override_votes <= 1 THEN NULL
       ELSE eligibility_override_votes - 1
     END,
     updated_at = ?
     WHERE id = ? AND eligibility_override_votes > 0`
  ).bind(new Date().toISOString(), identityCodeId).run();
  return result.meta.changes > 0;
}

export async function getVoteEligibilityStats(
  env: Env,
  playerName: string | null | undefined,
  identityCodeId?: string | null
): Promise<VoteEligibilityStats> {
  const sourceName = typeof playerName === "string" ? playerName.trim() : "";
  const sourceKey = identityPlayerNameKey(sourceName);
  const empty: VoteEligibilityStats = {
    matchedMember: false,
    playerName: sourceName,
    weeklyContribution: 0,
    technologyPoints: 0,
    materialContribution: 0,
    weeklyActivityPoints: 0
  };
  if (!sourceKey) return empty;

  const result = await env.DB.prepare(
    `SELECT name, identity_code_id, weekly_contribution, technology_points_used,
            material_contribution, weekly_activity_points
     FROM members
     ORDER BY name ASC
     LIMIT 500`
  ).all<{
    name: string;
    identity_code_id: string | null;
    weekly_contribution: number;
    technology_points_used: number;
    material_contribution: number;
    weekly_activity_points: number;
  }>();
  const bound = identityCodeId
    ? result.results.find((row) => row.identity_code_id === identityCodeId)
    : undefined;
  const matched = bound ?? result.results.find(
    (row) => identityPlayerNameKey(row.name) === sourceKey
  );
  if (!matched) return empty;
  return {
    matchedMember: true,
    playerName: matched.name,
    weeklyContribution: numberValue(matched.weekly_contribution),
    technologyPoints: numberValue(matched.technology_points_used),
    materialContribution: numberValue(matched.material_contribution),
    weeklyActivityPoints: numberValue(matched.weekly_activity_points)
  };
}

export async function evaluateVoteEligibility(
  env: Env,
  input: {
    playerName: string | null | undefined;
    identityCodeId?: string | null;
    enabled: boolean;
    thresholds: VoteEligibilityThresholds;
    override?: {
      votesRemaining?: unknown;
      expiresAt?: unknown;
    } | null;
  }
): Promise<VoteEligibilityResult> {
  const current = await getVoteEligibilityStats(env, input.playerName, input.identityCodeId);
  const override = activeVoteEligibilityOverride(input.override);
  const eligibleByStats = isVoteEligible(current, input.thresholds);
  const overrideApplied = input.enabled && !eligibleByStats && Boolean(override);
  return {
    enabled: input.enabled,
    eligible: !input.enabled || eligibleByStats || overrideApplied,
    thresholds: input.thresholds,
    current,
    override,
    overrideApplied
  };
}
