export type PreparationCronDeal = {
  id: string;
  deletedAt?: Date | string | null;
  meetingStartAt?: Date | string | null;
  latestBriefCreatedAt?: Date | string | null;
  latestBriefStatus?: string | null;
  hasInProgressBrief?: boolean;
};

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const IN_PROGRESS_STATUSES = new Set(["pending", "researching", "generating"]);

function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function getTokyoDayRange(now: Date, dayOffset = 0): { start: Date; end: Date } {
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  const startUtcMs =
    Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate() + dayOffset) - JST_OFFSET_MS;
  return {
    start: new Date(startUtcMs),
    end: new Date(startUtcMs + DAY_MS),
  };
}

export function selectDealsForPreparationCron(
  deals: PreparationCronDeal[],
  now: Date,
  { staleDays = 7 }: { staleDays?: number } = {},
): PreparationCronDeal[] {
  const tomorrow = getTokyoDayRange(now, 1);
  const staleBefore = new Date(now.getTime() - staleDays * DAY_MS);

  return deals
    .filter((deal) => {
      if (asDate(deal.deletedAt)) return false;
      const meetingStartAt = asDate(deal.meetingStartAt);
      if (!meetingStartAt || meetingStartAt < tomorrow.start || meetingStartAt >= tomorrow.end) {
        return false;
      }
      if (
        deal.hasInProgressBrief ||
        (deal.latestBriefStatus && IN_PROGRESS_STATUSES.has(deal.latestBriefStatus))
      ) {
        return false;
      }
      const latestBriefCreatedAt = asDate(deal.latestBriefCreatedAt);
      return !latestBriefCreatedAt || latestBriefCreatedAt <= staleBefore;
    })
    .slice(0, 10);
}
