/**
 * テナントコンテキスト（Luma / リージー 統合）
 * ============================================================
 * 1つのDB・1つの管理画面で株式会社Luma と株式会社リージーの営業データを扱うため、
 * 「いまどちらの会社として操作しているか」をリクエスト単位で保持する。
 *
 * 設計の要点:
 *   - Prisma 呼び出しは全社で 360 箇所あり、各所に where を書き足す方式では
 *     1箇所の書き漏れがそのまま別法人への情報漏洩になる。
 *     そのため AsyncLocalStorage でコンテキストを持ち回り、src/lib/db.ts の
 *     Prisma Extension が全クエリに tenant_id を自動注入する。
 *   - コンテキスト未設定のまま テナント所有モデルを触った場合は「素通し」ではなく
 *     例外にする（fail-closed）。バッチ・cron・エージェント経由の処理は
 *     runWithTenant() で明示的に包むこと。
 *   - Cookie の値は信用しない。必ず user_tenants を照会して所属を検証する。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { cache } from "react";
import { getSession } from "@/lib/auth";

// next/headers は Next.js のリクエスト内でしか使えない。検証スクリプトや
// バッチから import しただけで落ちないよう、必要になった時点で動的に読み込む。
const readCookies = async () => (await import("next/headers")).cookies();

export const ACTIVE_TENANT_COOKIE = "salesagent_tenant";

/** 全社統合ビュー（Luma＋リージー合算）を表す擬似テナントコード */
export const ALL_TENANTS = "__all__";

export type TenantPermission = "admin" | "user" | "viewer";

export type TenantCtx = {
  /** 操作中のテナント（tenants.id）。全社ビュー時は null */
  tenantId: string | null;
  /** 操作中のテナントコード（"luma" | "reagey" | "__all__"） */
  code: string;
  /** 会計年度の開始月（1〜12）。Luma=6 / リージー=1。全社ビュー時は 1（暦年） */
  fiscalYearStartMonth: number;
  userId: string;
  /** このテナントにおける権限 */
  permission: TenantPermission;
  /**
   * true のとき Prisma Extension は tenant_id 条件を注入しない（全社統合ビュー）。
   * 誤起票を防ぐため、この状態では書き込み操作を禁止する。
   */
  crossTenant: boolean;
};

// AsyncLocalStorage は globalThis に載せて共有する。
// このモジュールが別々のパス（"@/lib/tenant-context" と "../src/lib/tenant-context" 等）
// から読み込まれると別インスタンスになり、runWithTenant() で張ったコンテキストが
// src/lib/db.ts の Extension から見えない ＝ テナント境界が丸ごと無効になる。
// dev の HMR でも同じことが起きうるため、インスタンスを1つに固定する。
const globalForTenant = globalThis as unknown as {
  __tenantStorage?: AsyncLocalStorage<TenantCtx>;
};
const storage: AsyncLocalStorage<TenantCtx> =
  globalForTenant.__tenantStorage ?? new AsyncLocalStorage<TenantCtx>();
globalForTenant.__tenantStorage = storage;

/**
 * 指定テナントのコンテキストで処理を実行する。
 *
 * 実装上の注意（ここを崩すとテナント境界が黙って無効になる）:
 *   storage.run(ctx, fn) に **同期関数** を渡すと、fn が Promise を返した時点で
 *   run() を抜けてしまい、Prisma が実際にクエリを組み立てる（マイクロタスクに
 *   遅延される）ころにはコンテキストが失われている。
 *   その状態でも例外は出ず、既定テナント(Luma)で処理されてしまうため気付けない。
 *   そこで run() に渡すのは必ず async 関数にし、内側で await してから返す。
 *   これにより呼び出し側が `() => prisma.x.create(...)` のような同期アローを
 *   渡しても安全になる。
 */
export function runWithTenant<T>(ctx: TenantCtx, fn: () => Promise<T> | T): Promise<T> {
  return storage.run(ctx, async () => await fn());
}

/** 現在のテナントコンテキスト（未設定なら undefined） */
export function currentTenant(): TenantCtx | undefined {
  return storage.getStore();
}

/**
 * 現在のテナントコンテキストを取得する。未設定なら例外。
 * 「テナントが決まっていないのにテナント所有データを読み書きする」状態を
 * 静かに通さないための関門。
 */
export function requireTenant(): TenantCtx {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      "テナントコンテキストが設定されていません。API Route / Server Component は withTenant() で、" +
        "バッチ・cron は runWithTenant() で包んでください。",
    );
  }
  return ctx;
}

/**
 * 現在のテナントID。
 * findUnique / upsert のように where に複合ユニーク（tenantId_name 等）を
 * 明示せざるを得ない箇所で使う。
 *
 * 移行期（Phase 2 の途中）はコンテキスト未設定の呼び出しが残るため、その場合は
 * 既定テナント（Luma）を返す。全ルートの対応後に TENANT_STRICT=1 を設定すると
 * src/lib/db.ts 側が例外を投げるようになり、ここも実質 strict になる。
 */
export function currentTenantId(): string {
  const ctx = storage.getStore();
  if (ctx?.tenantId) return ctx.tenantId;
  return process.env.FALLBACK_TENANT_ID ?? "11111111-1111-4111-8111-111111111111";
}

/**
 * ログインセッションと Cookie から、実際に使えるテナントコンテキストを解決する。
 * - Cookie のテナントに所属していなければ、既定テナント（is_default）へフォールバック
 * - 全社ビュー（__all__）は cross_tenant_read を持つユーザーのみ
 * 未ログイン時は null。
 */
export async function resolveTenantContext(): Promise<TenantCtx | null> {
  const { prisma } = await import("@/lib/db");
  const session = await getSession();
  if (!session) return null;

  const memberships = await prisma.userTenant.findMany({
    where: { userId: session.userId, tenant: { active: true } },
    include: { tenant: true },
    orderBy: [{ isDefault: "desc" }, { tenant: { sortOrder: "asc" } }],
  });
  if (memberships.length === 0) return null;

  const store = await readCookies();
  const requested = store.get(ACTIVE_TENANT_COOKIE)?.value;

  // 全社統合ビュー（読み取り専用）
  if (requested === ALL_TENANTS && memberships.some((m) => m.crossTenantRead)) {
    return {
      tenantId: null,
      code: ALL_TENANTS,
      fiscalYearStartMonth: 1, // 会計年度が会社で異なるため、全社ビューは暦年で束ねる
      userId: session.userId,
      permission: "viewer", // 全社ビューでは書き込ませない
      crossTenant: true,
    };
  }

  // Cookie で指定されたテナントに所属していればそれを、無ければ既定テナントを使う
  const picked = memberships.find((m) => m.tenant.code === requested) ?? memberships[0];
  return {
    tenantId: picked.tenantId,
    code: picked.tenant.code,
    fiscalYearStartMonth: picked.tenant.fiscalYearStartMonth,
    userId: session.userId,
    permission: (picked.permission ?? "viewer") as TenantPermission,
    crossTenant: false,
  };
}

/**
 * リクエスト単位でメモ化したテナント解決。
 * ------------------------------------------------------------
 * サイドバーのタブ（Luma / リージー）を全画面に効かせるため、各ページ・各APIを
 * 明示的に withTenant() で包まなくても、Prisma Extension がここを呼んで
 * 「いまどちらの会社を見ているか」を自力で判定する。
 *
 * React の cache() によりリクエストごとに1回だけ評価されるので、
 * 1リクエストで何十回クエリを投げても user_tenants の照会は1回で済む。
 *
 * リクエストスコープ外（バッチ・cron・スクリプト）では cookies() が使えず
 * 例外になるため null を返す。その経路は runAsTenant() で明示的に包むこと。
 */
export const getRequestTenant = cache(async (): Promise<TenantCtx | null> => {
  try {
    return await resolveTenantContext();
  } catch {
    return null;
  }
});

/**
 * API Route / Server Component 用のラッパー。
 * テナントを解決してコンテキストを張った状態で処理を実行する。
 * 未ログイン・所属なしの場合は onUnauthorized を返す。
 *
 *   export const GET = () => withTenant(async (ctx) => { ... });
 */
export async function withTenant<T>(
  fn: (ctx: TenantCtx) => Promise<T>,
  onUnauthorized: () => T,
): Promise<T> {
  const ctx = await resolveTenantContext();
  if (!ctx) return onUnauthorized();
  return runWithTenant(ctx, () => fn(ctx));
}

/**
 * 「この商談はどちらの会社か」をフォームで選ばせる場合に使う。
 * ------------------------------------------------------------
 * 画面で見ているタブ（アクティブテナント）とは別のテナントを指定して作成できるが、
 * ログイン中のユーザーがそのテナントに所属していなければ実行しない。
 * Cookie も画面もクライアント側から詐称できるため、所属は必ずサーバーで確認する。
 *
 * 見つからない・所属していない場合は null を返す（呼び出し側で 403 にする）。
 */
export async function runAsUserTenant<T>(
  tenantId: string,
  fn: (ctx: TenantCtx) => Promise<T>,
  opts: { requireWrite?: boolean } = {},
): Promise<T | null> {
  const { prisma } = await import("@/lib/db");
  const session = await getSession();
  if (!session) return null;

  const membership = await prisma.userTenant.findFirst({
    where: { userId: session.userId, tenantId, tenant: { active: true } },
    include: { tenant: true },
  });
  if (!membership) return null;
  // 作成・更新用途では viewer を弾く。KPI 表示のような読み取りは viewer でも通す。
  if (opts.requireWrite && (membership.permission ?? "viewer") === "viewer") return null;

  const ctx: TenantCtx = {
    tenantId: membership.tenantId,
    code: membership.tenant.code,
    fiscalYearStartMonth: membership.tenant.fiscalYearStartMonth,
    userId: session.userId,
    permission: membership.permission as TenantPermission,
    crossTenant: false,
  };
  return runWithTenant(ctx, () => fn(ctx));
}

/**
 * 選択中の会社の会計年度開始月（Luma=6 / リージー=1）。
 * KPI・ダッシュボードなど期間集計を行うサーバー側処理はここから取る。
 *
 * 会社が決まらない場合（バッチ等）は既定テナント Luma の 6 を返す。
 * KPI画面のように「表示対象の会社」を URL で切り替える場合は、
 * runAsUserTenant() でコンテキストを張った内側で呼ぶこと。
 */
export async function getFiscalStartMonth(): Promise<number> {
  const ctx = currentTenant() ?? (await getRequestTenant());
  return ctx?.fiscalYearStartMonth ?? 6;
}

/** ログイン中のユーザーが所属するテナント一覧（タブ表示用） */
export async function listMyTenants() {
  const { prisma } = await import("@/lib/db");
  const session = await getSession();
  if (!session) return [];
  const rows = await prisma.userTenant.findMany({
    where: { userId: session.userId, tenant: { active: true } },
    include: { tenant: true },
    orderBy: [{ tenant: { sortOrder: "asc" } }],
  });
  return rows.map((r) => ({
    id: r.tenantId,
    code: r.tenant.code,
    name: r.tenant.name,
    shortName: r.tenant.shortName,
    themeColor: r.tenant.themeColor,
    // KPI の年度セレクタは会社ごとに区切りが違う（Luma=6月始まり / リージー=1月始まり）
    fiscalYearStartMonth: r.tenant.fiscalYearStartMonth,
    permission: r.permission,
    crossTenantRead: r.crossTenantRead,
  }));
}

export type MyTenant = Awaited<ReturnType<typeof listMyTenants>>[number];

/**
 * バッチ・cron・エージェント等、HTTPセッションが無い処理からテナントを指定して実行する。
 *   await runAsTenant("luma", async () => { ... })
 */
export async function runAsTenant<T>(code: string, fn: () => Promise<T>): Promise<T> {
  const { prisma } = await import("@/lib/db");
  const tenant = await prisma.tenant.findUnique({ where: { code } });
  if (!tenant) throw new Error(`テナントが見つかりません: ${code}`);
  return runWithTenant(
    {
      tenantId: tenant.id,
      code: tenant.code,
      fiscalYearStartMonth: tenant.fiscalYearStartMonth,
      userId: "system",
      permission: "admin",
      crossTenant: false,
    },
    fn,
  );
}
