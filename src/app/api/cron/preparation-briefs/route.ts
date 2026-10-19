import { NextResponse } from "next/server";
import { prisma, prismaUnscoped } from "@/lib/db";
import { isValidCronSecret } from "@/lib/agent-auth";
import { isPreparationCronEnabled, isPreparationV2Enabled } from "@/lib/feature-flags";
import {
  PREPARATION_INTERRUPTED_MESSAGE,
  isInterruptedPreparationBrief,
  runPreparationBrief,
} from "@/lib/ai/preparation";
import { getTokyoDayRange, selectDealsForPreparationCron } from "@/lib/preparation-cron";
import { runAsTenant } from "@/lib/tenant-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const IN_PROGRESS_STATUSES = new Set(["pending", "researching", "generating"]);
// Briefs run inline one after another. Stop starting new deals halfway through
// the 300s request limit so the deal in progress is not cut off mid-generation.
const CRON_TIME_BUDGET_MS = 150 * 1000;

async function handlePreparationCron(req: Request) {
  const startedAt = Date.now();
  if (!isValidCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isPreparationV2Enabled() || !isPreparationCronEnabled()) {
    return NextResponse.json({ skipped: true });
  }

  const now = new Date();
  const tomorrow = getTokyoDayRange(now, 1);
  const tenants = await prismaUnscoped.tenant.findMany({
    where: { active: true },
    select: { code: true },
    orderBy: { sortOrder: "asc" },
  });

  let created = 0;
  let skippedForTimeBudget = 0;
  const tenantResults: Array<{ tenant: string; selected: number; created: number; skippedForTimeBudget: number }> = [];

  for (const tenant of tenants) {
    const remaining = 10 - created;
    if (remaining <= 0) break;

    const result = await runAsTenant(tenant.code, async () => {
      const deals = await prisma.deal.findMany({
        where: {
          deletedAt: null,
          company: { deletedAt: null },
          meetingStartAt: { gte: tomorrow.start, lt: tomorrow.end },
        },
        select: {
          id: true,
          deletedAt: true,
          meetingStartAt: true,
          preparationBriefs: {
            orderBy: { createdAt: "desc" },
            take: 10,
            select: { id: true, createdAt: true, status: true },
          },
        },
      });

      // An interrupted brief must not keep the deal "in progress" forever.
      const interruptedIds = deals.flatMap((deal) =>
        deal.preparationBriefs.filter((brief) => isInterruptedPreparationBrief(brief, now)).map((brief) => brief.id),
      );
      if (interruptedIds.length > 0) {
        try {
          await prisma.preparationBrief.updateMany({
            where: { id: { in: interruptedIds }, status: { in: [...IN_PROGRESS_STATUSES] } },
            data: { status: "error", error: PREPARATION_INTERRUPTED_MESSAGE },
          });
        } catch (e) {
          // Best-effort cleanup: selection below already treats these briefs as errors,
          // so a failed write must not stop brief creation for this or later tenants.
          console.warn("[preparation-cron] interrupted brief recovery skipped", e instanceof Error ? e.message : e);
        }
      }
      const briefStatus = (brief: { status: string; createdAt: Date }) =>
        isInterruptedPreparationBrief(brief, now) ? "error" : brief.status;

      const selected = selectDealsForPreparationCron(
        deals.map((deal) => ({
          id: deal.id,
          deletedAt: deal.deletedAt,
          meetingStartAt: deal.meetingStartAt,
          latestBriefCreatedAt: deal.preparationBriefs[0]?.createdAt ?? null,
          latestBriefStatus: deal.preparationBriefs[0] ? briefStatus(deal.preparationBriefs[0]) : null,
          hasInProgressBrief: deal.preparationBriefs.some((brief) => IN_PROGRESS_STATUSES.has(briefStatus(brief))),
        })),
        now,
        { staleDays: 7 },
      ).slice(0, remaining);

      let tenantCreated = 0;
      let tenantSkipped = 0;
      for (let index = 0; index < selected.length; index += 1) {
        if (Date.now() - startedAt >= CRON_TIME_BUDGET_MS) {
          tenantSkipped = selected.length - index;
          break;
        }
        const deal = selected[index];
        const row = await prisma.preparationBrief.create({
          data: {
            dealId: deal.id,
            status: "pending",
            createdById: null,
          },
        });
        tenantCreated += 1;
        await runPreparationBrief(row.id, deal.id);
      }
      return { selected: selected.length, created: tenantCreated, skippedForTimeBudget: tenantSkipped };
    });

    created += result.created;
    skippedForTimeBudget += result.skippedForTimeBudget;
    tenantResults.push({ tenant: tenant.code, ...result });
    if (created >= 10) break;
  }

  return NextResponse.json({ skipped: false, created, skippedForTimeBudget, tenants: tenantResults });
}

export async function GET(req: Request) {
  return handlePreparationCron(req);
}

export async function POST(req: Request) {
  return handlePreparationCron(req);
}
