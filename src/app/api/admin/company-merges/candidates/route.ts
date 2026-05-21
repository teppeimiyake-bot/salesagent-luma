import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";
import { normalizeName, domainOf, richnessScore, pairKey } from "@/lib/company-dedup";

export const dynamic = "force-dynamic";

type CompanyRow = {
  id: string;
  name: string;
  industry: string | null;
  websiteUrl: string | null;
  websiteSummary: string | null;
  note: string | null;
  address: string | null;
  ceoName: string | null;
  establishedYear: number | null;
  employeeCount: number | null;
  capital: string | null;
  phoneNumber: string | null;
  logoUrl: string | null;
  logoColor: string | null;
  createdAt: Date;
  dealCount: number;
  contactCount: number;
};

type CandidateCompany = CompanyRow & {
  richness: number;
  isSurvivingDefault: boolean;
};

type CandidateGroup = {
  key: string;
  /** high = 完全一致 or ドメイン一致（高確度）/ review = 正規化のみ一致（要確認） */
  confidence: "high" | "review";
  reason: string;
  companies: CandidateCompany[];
};

/**
 * GET /api/admin/company-merges/candidates
 * live 企業を取得し、社名正規化キー＆ドメインでグルーピングして重複候補を返す（admin only）。
 * - 完全一致 / ドメイン一致 = high（高確度）
 * - 正規化のみ一致         = review（要確認）
 * - dismissed 済みペアのみで構成されるグループは除外
 */
export async function GET() {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "admin")) {
    return NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 });
  }

  try {
    // live 企業＋子データ件数
    const raw = await prisma.company.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        name: true,
        industry: true,
        websiteUrl: true,
        websiteSummary: true,
        note: true,
        address: true,
        ceoName: true,
        establishedYear: true,
        employeeCount: true,
        capital: true,
        phoneNumber: true,
        logoUrl: true,
        logoColor: true,
        createdAt: true,
        // ソフト削除された deal は除外してカウント
        deals: { where: { deletedAt: null }, select: { id: true } },
        _count: { select: { contacts: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    const companies: CompanyRow[] = raw.map((c) => ({
      id: c.id,
      name: c.name,
      industry: c.industry,
      websiteUrl: c.websiteUrl,
      websiteSummary: c.websiteSummary,
      note: c.note,
      address: c.address,
      ceoName: c.ceoName,
      establishedYear: c.establishedYear,
      employeeCount: c.employeeCount,
      capital: c.capital,
      phoneNumber: c.phoneNumber,
      logoUrl: c.logoUrl,
      logoColor: c.logoColor,
      createdAt: c.createdAt,
      dealCount: c.deals.length,
      contactCount: c._count.contacts,
    }));

    // dismissed ペア集合
    const dismissedRows = await prisma.companyMergeDismissed.findMany({
      select: { companyIdA: true, companyIdB: true },
    });
    const dismissedSet = new Set(dismissedRows.map((d) => pairKey(d.companyIdA, d.companyIdB)));

    // ---- グルーピング ----
    // 完全一致（trim）
    const byExact = new Map<string, CompanyRow[]>();
    // 正規化一致
    const byNorm = new Map<string, CompanyRow[]>();
    // ドメイン一致
    const byDomain = new Map<string, CompanyRow[]>();

    for (const c of companies) {
      const exactK = (c.name || "").trim();
      if (exactK) {
        if (!byExact.has(exactK)) byExact.set(exactK, []);
        byExact.get(exactK)!.push(c);
      }
      const normK = normalizeName(c.name);
      if (normK) {
        if (!byNorm.has(normK)) byNorm.set(normK, []);
        byNorm.get(normK)!.push(c);
      }
      const dom = domainOf(c.websiteUrl);
      if (dom) {
        if (!byDomain.has(dom)) byDomain.set(dom, []);
        byDomain.get(dom)!.push(c);
      }
    }

    // 各企業がどの最終グループに属するかを管理（重複防止：1企業は最初に確定したグループに属する）
    // 優先度：完全一致(high) > ドメイン一致(high) > 正規化一致(review)
    const assigned = new Set<string>();
    const groups: CandidateGroup[] = [];

    function buildGroup(
      keyPrefix: string,
      key: string,
      confidence: "high" | "review",
      reason: string,
      members: CompanyRow[],
    ): CandidateGroup | null {
      // 既に確定済みの企業を除く
      const fresh = members.filter((m) => !assigned.has(m.id));
      if (fresh.length < 2) return null;
      // グループ内の全ペアが dismissed 済みなら除外
      const allDismissed = fresh.every((a, i) =>
        fresh.every((b, j) => i >= j || dismissedSet.has(pairKey(a.id, b.id))),
      );
      if (allDismissed) return null;
      for (const m of fresh) assigned.add(m.id);

      // 充実度スコア＆デフォルト統合先
      const withScore = fresh.map((m) => ({ ...m, richness: richnessScore(m) }));
      let bestIdx = 0;
      for (let i = 1; i < withScore.length; i++) {
        if (withScore[i].richness > withScore[bestIdx].richness) bestIdx = i;
      }
      const candidateCompanies: CandidateCompany[] = withScore.map((m, i) => ({
        ...m,
        isSurvivingDefault: i === bestIdx,
      }));

      return { key: `${keyPrefix}:${key}`, confidence, reason, companies: candidateCompanies };
    }

    // 1) 完全一致（high）
    for (const [k, members] of byExact) {
      if (members.length < 2) continue;
      const g = buildGroup("exact", k, "high", "社名が完全一致", members);
      if (g) groups.push(g);
    }
    // 2) ドメイン一致（high）— 正規化名が違っても high 扱いだが「別会社の例あり」のため UI で確認させる
    for (const [k, members] of byDomain) {
      if (members.length < 2) continue;
      const g = buildGroup("domain", k, "high", "HPドメインが一致", members);
      if (g) groups.push(g);
    }
    // 3) 正規化一致（review）
    for (const [k, members] of byNorm) {
      if (members.length < 2) continue;
      const g = buildGroup("norm", k, "review", "社名の表記ゆれが一致（要確認）", members);
      if (g) groups.push(g);
    }

    // 高確度を先に、件数の多い順
    groups.sort((a, b) => {
      if (a.confidence !== b.confidence) return a.confidence === "high" ? -1 : 1;
      return b.companies.length - a.companies.length;
    });

    const summary = {
      totalLive: companies.length,
      groupCount: groups.length,
      highCount: groups.filter((g) => g.confidence === "high").length,
      reviewCount: groups.filter((g) => g.confidence === "review").length,
      affectedCompanies: groups.reduce((a, g) => a + g.companies.length, 0),
    };

    return NextResponse.json({ summary, groups });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[/api/admin/company-merges/candidates] error:", msg);
    return NextResponse.json({ error: "Server error", detail: msg }, { status: 500 });
  }
}
