export function technologyVoteOptionsForParticipants<
  T extends { key: string }
>(
  requestedPollDate: string,
  currentPollDate: string,
  currentOptions: T[],
  history: { pollDate: string; options: T[] } | null
): T[] | null {
  if (requestedPollDate === currentPollDate) return currentOptions;
  if (history?.pollDate === requestedPollDate) return history.options;
  return null;
}
