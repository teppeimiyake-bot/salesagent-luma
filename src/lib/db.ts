import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { currentTenant, getRequestTenant } from "@/lib/tenant-context";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
const globalForPool = globalThis as unknown as { pool?: Pool };

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const pool =
  globalForPool.pool ??
  new Pool({
    connectionString,
  });

const basePrisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaPg(pool),
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = basePrisma;
if (process.env.NODE_ENV !== "production") globalForPool.pool = pool;

// ============================================================
// マルチテナント境界（Luma / リージー）
// ------------------------------------------------------------
// tenantId を持つモデルへの全クエリに tenant_id 条件を自動注入する。
// 各 API に where を書き足す方式はいずれ書き漏れが出て別法人への漏洩になるため、
// クエリ層で一括して閉じる。
//
// 対象モデルは DMMF から動的に判定するので、今後モデルを追加しても
// tenantId フィールドさえ持たせれば自動的に保護対象になる。
// ============================================================

/** テナント境界の対象モデル（tenantId を持つモデル） */
const TENANT_MODELS: ReadonlySet<string> = new Set(
  Prisma.dmmf.datamodel.models
    .filter((m) => m.fields.some((f) => f.name === "tenantId"))
    .map((m) => m.name)
    // UserTenant は「そのユーザーがどのテナントに所属しているか」を引くための
    // 横断テーブル。ここを絞ると自分の所属一覧が取れずテナント切替が壊れるため除外する。
    .filter((name) => name !== "UserTenant"),
);

const MODEL_BY_NAME = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));

/**
 * ネストした create にも tenant_id を入れる。
 * ------------------------------------------------------------
 * 例: prisma.deal.create({ data: { ..., products: { create: {...} } } })
 * この DealProduct はトップレベルの data ではないため、単純な { ...data, tenantId } では
 * tenant_id が入らない。入らなければ '' のまま INSERT され FK 違反で落ちるので
 * データは汚れないが、商談の新規作成そのものが失敗してしまう。
 * リレーションを辿って create / createMany / connectOrCreate / upsert の中身まで注入する。
 */
function injectTenantDeep(modelName: string, data: unknown, tenantId: string): void {
  if (!data || typeof data !== "object") return;
  if (Array.isArray(data)) {
    for (const d of data) injectTenantDeep(modelName, d, tenantId);
    return;
  }
  const model = MODEL_BY_NAME.get(modelName);
  if (!model) return;
  const obj = data as Record<string, unknown>;

  for (const field of model.fields) {
    if (field.kind !== "object") continue; // リレーションのみ辿る
    const nested = obj[field.name];
    if (!nested || typeof nested !== "object") continue;

    const target = field.type;
    const owned = TENANT_MODELS.has(target);
    const n = nested as Record<string, unknown>;

    // create / connectOrCreate / upsert
    for (const op of ["create", "connectOrCreate", "upsert"] as const) {
      const v = n[op];
      if (!v || typeof v !== "object") continue;
      for (const entry of Array.isArray(v) ? v : [v]) {
        if (!entry || typeof entry !== "object") continue;
        const rec = entry as Record<string, unknown>;
        // connectOrCreate / upsert は create プロパティの中身が実データ
        const payload = (op === "create" ? rec : rec.create) as Record<string, unknown> | undefined;
        if (!payload || typeof payload !== "object") continue;
        if (owned && payload.tenantId === undefined) payload.tenantId = tenantId;
        injectTenantDeep(target, payload, tenantId);
      }
    }

    // createMany: { data: [...] }
    const cm = n.createMany as Record<string, unknown> | undefined;
    if (cm && typeof cm === "object" && cm.data) {
      for (const row of Array.isArray(cm.data) ? cm.data : [cm.data]) {
        if (!row || typeof row !== "object") continue;
        const rec = row as Record<string, unknown>;
        if (owned && rec.tenantId === undefined) rec.tenantId = tenantId;
        injectTenantDeep(target, rec, tenantId);
      }
    }
  }
}

/** where に tenant_id を AND する読み取り操作 */
const READ_OPS = new Set([
  "findMany", "findFirst", "findFirstOrThrow", "count", "aggregate", "groupBy",
]);

/** where に tenant_id を AND する更新・削除操作（他社の行を触れなくする） */
const WRITE_OPS = new Set([
  "update", "updateMany", "delete", "deleteMany",
]);

/** 取得後に tenant_id を検証する操作（where にユニーク列しか書けないため後段で弾く） */
const UNIQUE_READ_OPS = new Set(["findUnique", "findUniqueOrThrow"]);

function andTenant(where: unknown, tenantId: string) {
  return where ? { AND: [where, { tenantId }] } : { tenantId };
}

// ------------------------------------------------------------
// 移行期のフォールバック
// ------------------------------------------------------------
// Phase 2 では 87 の API Route を順次 withTenant() で包んでいく。その途中で
// 「コンテキスト未設定＝即例外」にすると未対応のルートが全て落ちて本番投入できない。
// そこで移行完了までは Luma を既定テナントとして扱い、警告だけ出す。
// 全ルートの対応が終わったら TENANT_STRICT=1 を設定して fail-closed に切り替える。
// （リージーのデータを投入する Phase 5 より前に必ず strict にすること）
const TENANT_STRICT = process.env.TENANT_STRICT === "1";
const FALLBACK_TENANT_ID =
  process.env.FALLBACK_TENANT_ID ?? "11111111-1111-4111-8111-111111111111"; // = tenants.code 'luma'
const warned = new Set<string>();

function fallbackTenantId(model: string, operation: string): string {
  const key = `${model}.${operation}`;
  if (!warned.has(key)) {
    warned.add(key);
    console.warn(
      `[tenant] コンテキスト未設定のまま ${key} が呼ばれたため既定テナント(Luma)で処理しました。` +
        `該当箇所を withTenant() / runAsTenant() で包んでください。`,
    );
  }
  return FALLBACK_TENANT_ID;
}

export const prisma = basePrisma.$extends({
  name: "tenant-scope",
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!model || !TENANT_MODELS.has(model)) return query(args);

        // 1) 明示的に張られたコンテキスト（withTenant / runAsTenant / runAsUserTenant）
        // 2) 無ければリクエスト（Cookie + セッション）から解決 ＝ サイドバーのタブの選択
        //    これにより各ページ・各APIを個別に包まなくてもタブ切替が全画面に効く
        const ctx = currentTenant() ?? (await getRequestTenant()) ?? undefined;

        // どちらでも決まらない場合（バッチ・cron・スクリプト）はコンテキスト未設定。
        // 移行完了後（TENANT_STRICT=1）は素通しせず落とす。
        if (!ctx && TENANT_STRICT) {
          throw new Error(
            `テナントコンテキストなしで ${model}.${operation} が呼ばれました。` +
              `API Route は withTenant()、バッチは runAsTenant() で包んでください。`,
          );
        }

        // 全社統合ビュー：読み取りのみ許可し、テナント条件は入れない
        if (ctx?.crossTenant) {
          if (!READ_OPS.has(operation) && !UNIQUE_READ_OPS.has(operation)) {
            throw new Error(
              `全社統合ビューでは書き込みできません（${model}.${operation}）。` +
                `会社を Luma / リージー のいずれかに切り替えてから操作してください。`,
            );
          }
          return query(args);
        }

        const tenantId = ctx?.tenantId ?? fallbackTenantId(model, operation);
        const a = args as Record<string, unknown>;

        if (READ_OPS.has(operation) || WRITE_OPS.has(operation)) {
          a.where = andTenant(a.where, tenantId);
          if ((operation === "update" || operation === "updateMany") && a.data && typeof a.data === "object") {
            // 所属テナントの付け替えは許さない（他社へ商談を移す操作を封じる）
            delete (a.data as Record<string, unknown>).tenantId;
            // 更新に紛れ込むネストした create（例: deal.update で products を足す）にも注入
            injectTenantDeep(model, a.data, tenantId);
          }
          return query(a);
        }

        if (operation === "create") {
          a.data = { ...(a.data as object), tenantId };
          injectTenantDeep(model, a.data, tenantId);
          return query(a);
        }

        if (operation === "createMany" || operation === "createManyAndReturn") {
          const rows = Array.isArray(a.data) ? a.data : [a.data];
          a.data = rows.map((d) => ({ ...(d as object), tenantId }));
          return query(a);
        }

        if (operation === "upsert") {
          // upsert の where はユニーク入力しか受け付けないため AND を足せない。
          // 代わりに UNIQUE 制約自体を (tenant_id, ...) の複合にしてあるので、
          // 呼び出し側は tenantId_name のような複合キーを書くことを型で強制される。
          a.create = { ...(a.create as object), tenantId };
          injectTenantDeep(model, a.create, tenantId);
          if (a.update && typeof a.update === "object") {
            delete (a.update as Record<string, unknown>).tenantId;
            injectTenantDeep(model, a.update, tenantId);
          }
          return query(a);
        }

        // findUnique / findUniqueOrThrow:
        //   where にユニーク列しか書けないので条件は足せない。
        //   代わりに取得後に tenant_id を突き合わせ、他テナントの行なら返さない。
        if (UNIQUE_READ_OPS.has(operation)) {
          // select 指定時は tenantId が結果に含まれないので、検証用に一時的に足す
          const select = a.select as Record<string, unknown> | undefined;
          const injectedSelect = select && !select.tenantId;
          if (injectedSelect) select.tenantId = true;

          const result = (await query(a)) as Record<string, unknown> | null;
          if (!result) return result;

          if (result.tenantId !== tenantId) {
            if (operation === "findUniqueOrThrow") {
              throw new Prisma.PrismaClientKnownRequestError(
                "An operation failed because it depends on one or more records that were required but not found.",
                { code: "P2025", clientVersion: Prisma.prismaVersion.client },
              );
            }
            return null;
          }
          if (injectedSelect) delete result.tenantId;
          return result;
        }

        return query(a);
      },
    },
  },
});

/**
 * テナント境界を通さない生クライアント。
 * ログイン処理・テナント解決・移行スクリプトなど、テナントが決まる前に動く処理専用。
 * 業務ロジックからは絶対に使わないこと。
 */
export const prismaUnscoped = basePrisma;

/** テナント境界の対象モデル名（テスト・検証用にエクスポート） */
export const TENANT_SCOPED_MODELS = TENANT_MODELS;
