import { redirect } from "next/navigation";
import { Header } from "@/components/layout/header";
import { KyoproTabs } from "@/components/kyopro/kyopro-tabs";
import { MastersClient } from "@/components/kyopro/masters-client";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";
import { ensureKyoproRates } from "@/lib/kyopro-server";

export const dynamic = "force-dynamic";

export default async function KyoproMastersPage() {
  const permission = await getCurrentPermission();
  if (!hasPermission(permission, "admin")) redirect("/kyopro");

  // 初回アクセス時に職種レート（4行）と設定を作る
  const { rates, setting } = await ensureKyoproRates();
  const [clients, venues] = await Promise.all([
    prisma.kyoproClient.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.kyoproVenue.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
  ]);

  return (
    <>
      <Header title="京プロ マスタ" subtitle="職種レート・締めサイクル・クライアント・会場（管理者のみ）" />
      <KyoproTabs isAdmin />
      <div className="flex-1 overflow-y-auto bg-zinc-50 p-6">
        <MastersClient
          clients={clients.map((c) => ({
            id: c.id,
            name: c.name,
            colorHex: c.colorHex,
            defaultVenueId: c.defaultVenueId,
            active: c.active,
          }))}
          venues={venues.map((v) => ({
            id: v.id,
            name: v.name,
            colorHex: v.colorHex,
            active: v.active,
          }))}
          rates={rates.map((r) => ({
            id: r.id,
            role: r.role,
            billRate: r.billRate,
            payRateDefault: r.payRateDefault,
            payRateMin: r.payRateMin,
            payRateMax: r.payRateMax,
            cleanupBillAmount: r.cleanupBillAmount,
            cleanupPayAmount: r.cleanupPayAmount,
          }))}
          setting={{
            id: setting.id,
            payoutDueMonths: setting.payoutDueMonths,
            taxRate: setting.taxRate,
          }}
        />
      </div>
    </>
  );
}
