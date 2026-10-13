/**
 * 営業リストエージェントの候補を DB へ入れる処理。
 *   - intakeCandidates:         Cloud Run から届いた候補を staging（agent_candidates）へ受け取る
 *   - ingestApprovedCandidates: 承認済みの候補を企業マスタ（companies / contacts）へ取り込む
 *
 * どちらも「件数がいくつでも DB への往復回数が一定」になるように書く。
 * ------------------------------------------------------------
 * 以前は候補1社ごとに findFirst → create → deleteMany → create … を逐次で投げていた。
 * 関数と DB の往復は1回あたり数十〜100ms かかるので、十数社で対話トランザクションの
 * 既定タイムアウト（5秒）を超えて全件ロールバック → 500 になっていた
 * （2026-09-14 以降の送信がすべて失敗し、1社だけの送信しか通っていなかった）。
 * タイムアウトを延ばしても件数（1回の送信は最大500社）に比例して必ず再発するため、
 * 読み取りは IN／1回の全件取得にしてメモリで突き合わせ、書き込みは createMany と
 * jsonb_to_recordset を使った1文の UPSERT / UPDATE にまとめる。
 *
 * 生SQL は Prisma Client Extension を通らない（tenant_id が自動で入らない）ため、
 * tenant_id はテナントコンテキスト、または Extension 経由で読んだ行の値で明示する。
 */
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { prisma } from "@/lib/db";
import { currentTenant, getRequestTenant, requireTenant } from "@/lib/tenant-context";
import { normalizeName, domainOf } from "@/lib/company-dedup";

/**
 * テナント境界つきクライアント（@/lib/db の prisma）の $transaction が渡すクライアント。
 * Prisma.TransactionClient は Extension を通らない素の型なので、こちらを使う。
 */
type Db = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * この2本のトランザクションの上限。
 * 往復回数は件数に依らず一定だが、1回の送信（最大1000社）のデータ転送と、
 * Neon のスリープ明けの接続には時間がかかりうるので、既定（待ち2秒・本体5秒）では狭い。
 * 関数の maxDuration（60秒・vercel.json）より内側に収める。
 */
export const BULK_TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

// ============================================================
// 既存企業との突合（正規化名・ドメイン）
// ============================================================

const COMPANY_FIELDS = {
  id: true,
  name: true,
  websiteUrl: true,
  contactFormUrl: true,
  phoneNumber: true,
  address: true,
  industry: true,
  source: true,
  sourceKey: true,
} as const;

type CompanyRow = Prisma.CompanyGetPayload<{ select: typeof COMPANY_FIELDS }>;

type MatchIndex = { byName: Map<string, string>; byDomain: Map<string, string> };

/** live 企業（ゴミ箱以外）を1回で引き、正規化名・ドメイン → company.id の索引を作る。 */
async function loadLiveCompanies(db: Db): Promise<{ rows: CompanyRow[]; index: MatchIndex }> {
  const rows = await db.company.findMany({
    where: { deletedAt: null },
    select: COMPANY_FIELDS,
  });
  const byName = new Map<string, string>();
  const byDomain = new Map<string, string>();
  for (const c of rows) {
    const nk = normalizeName(c.name);
    if (nk && !byName.has(nk)) byName.set(nk, c.id);
    const dk = domainOf(c.websiteUrl);
    if (dk && !byDomain.has(dk)) byDomain.set(dk, c.id);
  }
  return { rows, index: { byName, byDomain } };
}

/** ドメイン一致を優先し、無ければ正規化名一致。 */
function matchCompany(index: MatchIndex, websiteUrl: string | null | undefined, nameKey: string) {
  const dk = domainOf(websiteUrl);
  if (dk && index.byDomain.has(dk)) {
    return { matchedCompanyId: index.byDomain.get(dk)!, matchStatus: "domain" };
  }
  if (nameKey && index.byName.has(nameKey)) {
    return { matchedCompanyId: index.byName.get(nameKey)!, matchStatus: "norm" };
  }
  return { matchedCompanyId: null, matchStatus: "new" };
}

// ============================================================
// 受け取り（Cloud Run → agent_candidates）
// ============================================================

export type IntakeCandidate = {
  sourceKey: string;
  companyName: string;
  websiteUrl?: string;
  contactFormUrl?: string;
  phone?: string;
  email?: string;
  industry?: string;
  address?: string;
  evidence?: unknown;
  message?: { subject?: string; body?: string };
};

export type IntakeResult = {
  runId: string;
  created: number;
  updated: number;
  skippedIngested: number;
  total: number;
};

/**
 * 候補を staging へ受け取る。冪等（tenant_id + sourceKey）。
 * 取り込み済み（ingested）の候補は触らない。evidence / message は送られてきた候補だけ作り直す。
 * テナントコンテキスト（runAsTenant）の内側で呼ぶこと。
 */
export async function intakeCandidates(
  db: Db,
  source: string,
  agentRunId: string | null | undefined,
  candidates: IntakeCandidate[],
): Promise<IntakeResult> {
  const { tenantId } = requireTenant();
  const { index } = await loadLiveCompanies(db);

  // 同じ sourceKey が1回の送信に複数あると、1文の UPSERT が同じ行を2度更新しようとして
  // 失敗する。後勝ちで1件にまとめる（逐次処理していた頃の最終状態と同じ）。
  const bySourceKey = new Map<string, IntakeCandidate>();
  for (const c of candidates) bySourceKey.set(c.sourceKey, c);
  const unique = [...bySourceKey.values()];

  const run = await db.agentRun.create({
    data: { source, agentRunId: agentRunId ?? null },
  });

  const rows = unique.map((c) => {
    const dedupeKey = normalizeName(c.companyName);
    const { matchedCompanyId, matchStatus } = matchCompany(index, c.websiteUrl, dedupeKey);
    return {
      source_key: c.sourceKey,
      company_name: c.companyName,
      dedupe_key: dedupeKey,
      website_url: c.websiteUrl ?? null,
      contact_form_url: c.contactFormUrl ?? null,
      phone: c.phone ?? null,
      email: c.email ?? null,
      industry: c.industry ?? null,
      address: c.address ?? null,
      matched_company_id: matchedCompanyId,
      match_status: matchStatus,
    };
  });

  // 新規は INSERT、既存は上書き。取り込み済みは DO UPDATE の WHERE で外れ、RETURNING にも出ない。
  // xmax = 0 は「この文で INSERT された行」（UPDATE された行は xmax が入る）。
  const written = await db.$queryRaw<{ id: string; source_key: string; inserted: boolean }[]>`
    INSERT INTO agent_candidates AS c (
      id, tenant_id, run_id, source_key, company_name, dedupe_key, website_url,
      contact_form_url, phone, email, industry, address, matched_company_id, match_status
    )
    SELECT
      gen_random_uuid()::text, ${tenantId}, ${run.id}, x.source_key, x.company_name, x.dedupe_key,
      x.website_url, x.contact_form_url, x.phone, x.email, x.industry, x.address,
      x.matched_company_id, x.match_status
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(
      source_key text, company_name text, dedupe_key text, website_url text,
      contact_form_url text, phone text, email text, industry text, address text,
      matched_company_id text, match_status text
    )
    ON CONFLICT (tenant_id, source_key) DO UPDATE SET
      run_id = EXCLUDED.run_id,
      company_name = EXCLUDED.company_name,
      dedupe_key = EXCLUDED.dedupe_key,
      website_url = EXCLUDED.website_url,
      contact_form_url = EXCLUDED.contact_form_url,
      phone = EXCLUDED.phone,
      email = EXCLUDED.email,
      industry = EXCLUDED.industry,
      address = EXCLUDED.address,
      matched_company_id = EXCLUDED.matched_company_id,
      match_status = EXCLUDED.match_status
    WHERE c.review_status <> 'ingested'
    RETURNING c.id, c.source_key, (c.xmax = 0) AS inserted
  `;

  const idBySourceKey = new Map(written.map((w) => [w.source_key, w.id]));
  const targets = unique.flatMap((c) => {
    const id = idBySourceKey.get(c.sourceKey);
    return id ? [{ c, id }] : [];
  });

  // evidence / message は作り直し（冪等）
  const withEvidence = targets.filter(({ c }) => c.evidence != null);
  if (withEvidence.length > 0) {
    await db.agentEvidence.deleteMany({
      where: { candidateId: { in: withEvidence.map((t) => t.id) } },
    });
    await db.agentEvidence.createMany({
      data: withEvidence.map(({ c, id }) => ({
        candidateId: id,
        evidenceJson: c.evidence as Prisma.InputJsonValue,
      })),
    });
  }

  const withMessage = targets.filter(({ c }) => c.message && (c.message.subject || c.message.body));
  if (withMessage.length > 0) {
    await db.agentGeneratedMessage.deleteMany({
      where: { candidateId: { in: withMessage.map((t) => t.id) } },
    });
    await db.agentGeneratedMessage.createMany({
      data: withMessage.map(({ c, id }) => ({
        candidateId: id,
        subject: c.message?.subject ?? null,
        body: c.message?.body ?? null,
      })),
    });
  }

  const created = written.filter((w) => w.inserted).length;
  return {
    runId: run.id,
    created,
    updated: written.length - created,
    skippedIngested: unique.length - written.length,
    total: candidates.length,
  };
}

// ============================================================
// 取り込み（承認済み agent_candidates → companies / contacts）
// ============================================================

export type IngestResult = { ingested: number; created: number; updated: number };

/** 既存企業の空欄だけを埋める項目（companies の列名 → CompanyRow のキー） */
const FILLABLE = {
  contact_form_url: "contactFormUrl",
  website_url: "websiteUrl",
  phone_number: "phoneNumber",
  address: "address",
  industry: "industry",
  source: "source",
  source_key: "sourceKey",
} as const;

type Fillable = (typeof FILLABLE)[keyof typeof FILLABLE];

/**
 * 承認済み（reviewStatus="approved"）の候補を企業マスタへ反映する。冪等（Company.sourceKey ＋ 候補状態）。
 * 既存企業の特定は sourceKey > ドメイン > 正規化名。既存企業は空欄だけ補完し、既存の値は上書きしない。
 * 同じバッチ内で作った企業にも後続の候補が当たるよう、判定は1件ずつ順にメモリ上で行い、書き込みだけまとめる。
 */
export async function ingestApprovedCandidates(db: Db): Promise<IngestResult> {
  // 生SQL は Extension の「全社統合ビューでは書き込み不可」の関門を通らないので、同じ判定をここで行う
  const ctx = currentTenant() ?? (await getRequestTenant());
  if (ctx?.crossTenant) {
    throw new Error(
      "全社統合ビューでは取り込みできません。会社を Luma / リージー のいずれかに切り替えてから操作してください。",
    );
  }

  const approved = await db.agentCandidate.findMany({
    where: { reviewStatus: "approved" },
    orderBy: { createdAt: "asc" },
    include: { run: { select: { source: true } } },
  });
  if (approved.length === 0) return { ingested: 0, created: 0, updated: 0 };

  const { rows: live, index } = await loadLiveCompanies(db);
  // sourceKey 一致はゴミ箱の企業も含めて引く（以前の findUnique({ sourceKey }) と同じ）
  const keyed = await db.company.findMany({
    where: { sourceKey: { in: approved.map((a) => a.sourceKey) } },
    select: COMPANY_FIELDS,
  });

  // id → 現在値。バッチ内の作成・補完をここへ反映し、後続候補の判定に効かせる。
  const companies = new Map<string, CompanyRow>();
  for (const c of [...live, ...keyed]) companies.set(c.id, c);
  const bySourceKey = new Map<string, CompanyRow>();
  for (const c of keyed) if (c.sourceKey) bySourceKey.set(c.sourceKey, c);

  // 既存企業に付いている連絡先（同じ email / phone を二重に作らないため）
  const touched = new Set<string>();
  for (const cand of approved) {
    const hit =
      bySourceKey.get(cand.sourceKey)?.id ??
      matchCompany(index, cand.websiteUrl, cand.dedupeKey || normalizeName(cand.companyName))
        .matchedCompanyId;
    if (hit) touched.add(hit);
  }
  const contactKeys = new Set<string>();
  const addContactKeys = (companyId: string, email: string | null, phone: string | null) => {
    if (email) contactKeys.add(`${companyId}\u0000e:${email}`);
    if (phone) contactKeys.add(`${companyId}\u0000p:${phone}`);
  };
  if (touched.size > 0) {
    const existing = await db.contact.findMany({
      where: { companyId: { in: [...touched] } },
      select: { companyId: true, email: true, phone: true },
    });
    for (const c of existing) addContactKeys(c.companyId, c.email, c.phone);
  }

  const createdIds = new Set<string>();
  const patches = new Map<string, Partial<Record<Fillable, string>>>();
  const newContacts: Prisma.ContactCreateManyInput[] = [];
  const ingested: { id: string; tenant_id: string; company_id: string }[] = [];
  let created = 0;
  let updated = 0;

  for (const cand of approved) {
    const dk = domainOf(cand.websiteUrl);
    const nk = cand.dedupeKey || normalizeName(cand.companyName);

    let company = bySourceKey.get(cand.sourceKey) ?? null;
    if (!company) {
      const matchId = (dk && index.byDomain.get(dk)) || (nk && index.byName.get(nk)) || null;
      if (matchId) company = companies.get(matchId) ?? null;
    }

    let companyId: string;
    if (company) {
      const offered: Record<Fillable, string | null | undefined> = {
        contactFormUrl: cand.contactFormUrl,
        websiteUrl: cand.websiteUrl,
        phoneNumber: cand.phone,
        address: cand.address,
        industry: cand.industry,
        source: cand.run.source,
        sourceKey: cand.sourceKey,
      };
      const patch: Partial<Record<Fillable, string>> = {};
      for (const key of Object.values(FILLABLE)) {
        const value = offered[key];
        if (!company[key] && value) patch[key] = value;
      }
      if (Object.keys(patch).length > 0) {
        Object.assign(company, patch);
        // バッチ内で作った企業は作成データ（company 自身）に既に反映されている
        if (!createdIds.has(company.id)) {
          patches.set(company.id, { ...patches.get(company.id), ...patch });
        }
        if (patch.sourceKey) bySourceKey.set(patch.sourceKey, company);
      }
      companyId = company.id;
      updated++;
    } else {
      const row: CompanyRow = {
        id: randomUUID(),
        name: cand.companyName,
        websiteUrl: cand.websiteUrl,
        contactFormUrl: cand.contactFormUrl,
        phoneNumber: cand.phone,
        address: cand.address,
        industry: cand.industry,
        source: cand.run.source,
        sourceKey: cand.sourceKey,
      };
      companies.set(row.id, row);
      createdIds.add(row.id);
      bySourceKey.set(cand.sourceKey, row);
      companyId = row.id;
      created++;
      // 同一バッチ内の後続候補が同じ企業に当たるようにインデックス更新
      if (nk) index.byName.set(nk, companyId);
      if (dk) index.byDomain.set(dk, companyId);
    }

    // 連絡先（email/phone があれば）を作成（同一 email/phone が無ければ）
    if (cand.email || cand.phone) {
      const key = cand.email
        ? `${companyId}\u0000e:${cand.email}`
        : `${companyId}\u0000p:${cand.phone}`;
      if (!contactKeys.has(key)) {
        newContacts.push({
          companyId,
          name: cand.companyName, // 担当者名が無いため会社名を暫定表示名に
          email: cand.email ?? null,
          phone: cand.phone ?? null,
        });
        addContactKeys(companyId, cand.email, cand.phone);
      }
    }

    ingested.push({ id: cand.id, tenant_id: cand.tenantId, company_id: companyId });
  }

  if (createdIds.size > 0) {
    await db.company.createMany({
      data: [...createdIds].map((id) => companies.get(id)!),
    });
  }

  if (patches.size > 0) {
    const patchRows = [...patches].map(([id, p]) => {
      const row: Record<string, string | null> = { id };
      for (const [column, key] of Object.entries(FILLABLE)) row[column] = p[key] ?? null;
      return row;
    });
    // 空欄（NULL / ''）のときだけ埋める。読んでから書くまでの間に誰かが埋めた値も上書きしない。
    await db.$executeRaw`
      UPDATE companies AS c SET
        contact_form_url = CASE WHEN COALESCE(c.contact_form_url, '') = '' AND x.contact_form_url IS NOT NULL THEN x.contact_form_url ELSE c.contact_form_url END,
        website_url      = CASE WHEN COALESCE(c.website_url, '')      = '' AND x.website_url      IS NOT NULL THEN x.website_url      ELSE c.website_url      END,
        phone_number     = CASE WHEN COALESCE(c.phone_number, '')     = '' AND x.phone_number     IS NOT NULL THEN x.phone_number     ELSE c.phone_number     END,
        address          = CASE WHEN COALESCE(c.address, '')          = '' AND x.address          IS NOT NULL THEN x.address          ELSE c.address          END,
        industry         = CASE WHEN COALESCE(c.industry, '')         = '' AND x.industry         IS NOT NULL THEN x.industry         ELSE c.industry         END,
        source           = CASE WHEN COALESCE(c.source, '')           = '' AND x.source           IS NOT NULL THEN x.source           ELSE c.source           END,
        source_key       = CASE WHEN COALESCE(c.source_key, '')       = '' AND x.source_key       IS NOT NULL THEN x.source_key       ELSE c.source_key       END
      FROM jsonb_to_recordset(${JSON.stringify(patchRows)}::jsonb) AS x(
        id text, contact_form_url text, website_url text, phone_number text,
        address text, industry text, source text, source_key text
      )
      WHERE c.id = x.id
    `;
  }

  if (newContacts.length > 0) {
    await db.contact.createMany({ data: newContacts });
  }

  // tenant_id は Extension 経由で読んだ候補行の値。他社の候補には触れない。
  await db.$executeRaw`
    UPDATE agent_candidates AS a SET
      review_status = 'ingested',
      ingested_company_id = x.company_id,
      ingested_at = (now() AT TIME ZONE 'UTC')
    FROM jsonb_to_recordset(${JSON.stringify(ingested)}::jsonb) AS x(
      id text, tenant_id text, company_id text
    )
    WHERE a.id = x.id AND a.tenant_id = x.tenant_id
  `;

  return { ingested: approved.length, created, updated };
}
