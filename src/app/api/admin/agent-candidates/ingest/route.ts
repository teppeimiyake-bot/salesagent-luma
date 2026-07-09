import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";
import { normalizeName, domainOf } from "@/lib/company-dedup";

export const dynamic = "force-dynamic";

// 承認済み(reviewStatus="approved")候補を Company/Contact へ正式反映する（admin・「取り込み」ボタン）。
// dedupe は company-dedup の normalizeName/domainOf を再利用。冪等（Company.sourceKey ＋ 候補状態）。
export async function POST() {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "admin")) {
    return NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 });
  }

  const approved = await prisma.agentCandidate.findMany({
    where: { reviewStatus: "approved" },
    orderBy: { createdAt: "asc" },
    include: { run: { select: { source: true } } },
  });
  if (approved.length === 0) {
    return NextResponse.json({
      ok: true,
      ingested: 0,
      created: 0,
      updated: 0,
      message: "承認済みの候補がありません",
    });
  }

  const result = await prisma.$transaction(async (tx) => {
    // live 企業の突合インデックス（正規化名・ドメイン）
    const live = await tx.company.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, websiteUrl: true },
    });
    const byName = new Map<string, string>();
    const byDomain = new Map<string, string>();
    for (const c of live) {
      const nk = normalizeName(c.name);
      if (nk && !byName.has(nk)) byName.set(nk, c.id);
      const dk = domainOf(c.websiteUrl);
      if (dk && !byDomain.has(dk)) byDomain.set(dk, c.id);
    }

    let created = 0;
    let updated = 0;
    for (const cand of approved) {
      const dk = domainOf(cand.websiteUrl);
      const nk = cand.dedupeKey || normalizeName(cand.companyName);

      // 既存 Company の特定：sourceKey > ドメイン > 正規化名
      let company = await tx.company.findUnique({
        where: { sourceKey: cand.sourceKey },
      });
      if (!company) {
        const matchId =
          (dk && byDomain.get(dk)) || (nk && byName.get(nk)) || null;
        if (matchId) {
          company = await tx.company.findUnique({ where: { id: matchId } });
        }
      }

      let companyId: string;
      if (company) {
        // 既存企業は空欄のみ補完（既存の値は上書きしない）。sourceKey/source は未設定時のみ付与。
        const data: Prisma.CompanyUpdateInput = {};
        if (!company.contactFormUrl && cand.contactFormUrl)
          data.contactFormUrl = cand.contactFormUrl;
        if (!company.websiteUrl && cand.websiteUrl)
          data.websiteUrl = cand.websiteUrl;
        if (!company.phoneNumber && cand.phone) data.phoneNumber = cand.phone;
        if (!company.address && cand.address) data.address = cand.address;
        if (!company.industry && cand.industry) data.industry = cand.industry;
        if (!company.source && cand.run.source) data.source = cand.run.source;
        if (!company.sourceKey) data.sourceKey = cand.sourceKey;
        if (Object.keys(data).length > 0) {
          company = await tx.company.update({
            where: { id: company.id },
            data,
          });
        }
        companyId = company.id;
        updated++;
      } else {
        const createdCompany = await tx.company.create({
          data: {
            name: cand.companyName,
            websiteUrl: cand.websiteUrl,
            contactFormUrl: cand.contactFormUrl,
            phoneNumber: cand.phone,
            address: cand.address,
            industry: cand.industry,
            source: cand.run.source,
            sourceKey: cand.sourceKey,
          },
        });
        companyId = createdCompany.id;
        created++;
        // 同一バッチ内の後続候補が同じ企業に当たるようにインデックス更新
        if (nk) byName.set(nk, companyId);
        if (dk) byDomain.set(dk, companyId);
      }

      // 連絡先（email/phone があれば）を作成（同一 email/phone が無ければ）
      if (cand.email || cand.phone) {
        const existingContact = await tx.contact.findFirst({
          where: {
            companyId,
            ...(cand.email ? { email: cand.email } : { phone: cand.phone }),
          },
        });
        if (!existingContact) {
          await tx.contact.create({
            data: {
              companyId,
              name: cand.companyName, // 担当者名が無いため会社名を暫定表示名に
              email: cand.email ?? null,
              phone: cand.phone ?? null,
            },
          });
        }
      }

      await tx.agentCandidate.update({
        where: { id: cand.id },
        data: {
          reviewStatus: "ingested",
          ingestedCompanyId: companyId,
          ingestedAt: new Date(),
        },
      });
    }

    return { ingested: approved.length, created, updated };
  });

  return NextResponse.json({ ok: true, ...result });
}
