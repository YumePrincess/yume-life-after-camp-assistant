import type { CampConfig } from "./domain";
import {
  addDaysToDateKey,
  zonedDateKey,
  zonedDateTimeToIso
} from "./time";

export interface LiveDailyVoteTransition {
  startAt: string;
  endAt: string;
  revealBeforeSeconds: number;
}

export interface LiveVoteTransitionInput {
  now: Date;
  timezone: string;
  campConfig: Pick<CampConfig, "gameResetTime" | "voteWindowStart" | "voteWindowEnd">;
  dailyItems: LiveDailyVoteTransition[];
  identityExpiryTimes?: Array<string | null | undefined>;
  horizonDays?: number;
}

/**
 * Absolute instants at which public/admin vote or identity state can change
 * without a database write. These are scheduled as Durable Object alarms and
 * delivered to clients over the existing WebSocket channel.
 */
export function upcomingLiveVoteTransitions(
  input: LiveVoteTransitionInput
): number[] {
  const now = input.now.getTime();
  const horizon = now + Math.max(1, input.horizonDays ?? 8) * 24 * 60 * 60_000;
  const values = new Set<number>();
  const add = (value: number) => {
    if (Number.isFinite(value) && value > now && value <= horizon) values.add(value);
  };

  for (const expiry of input.identityExpiryTimes ?? []) {
    if (!expiry) continue;
    add(Date.parse(expiry));
  }

  for (const item of input.dailyItems) {
    const start = Date.parse(item.startAt);
    const end = Date.parse(item.endAt);
    add(start - Math.max(0, item.revealBeforeSeconds) * 1000);
    add(start);
    add(end);
  }

  const firstDate = zonedDateKey(input.now, input.timezone);
  const days = Math.ceil((horizon - now) / (24 * 60 * 60_000)) + 1;
  for (let offset = 0; offset <= days; offset += 1) {
    const date = addDaysToDateKey(firstDate, offset);
    for (const clock of [
      input.campConfig.gameResetTime,
      input.campConfig.voteWindowStart,
      input.campConfig.voteWindowEnd
    ]) {
      const transitionDate = clock === "24:00" ? addDaysToDateKey(date, 1) : date;
      const transitionClock = clock === "24:00" ? "00:00" : clock;
      try {
        add(Date.parse(zonedDateTimeToIso(
          transitionDate,
          transitionClock,
          input.timezone
        )));
      } catch {
        // A configured wall clock can be skipped by a DST jump. The next
        // scheduler pass will calculate the next valid date boundary.
      }
    }
  }

  return [...values].sort((left, right) => left - right).slice(0, 20_000);
}
