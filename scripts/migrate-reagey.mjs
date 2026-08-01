/**
 * リージーのデータを Luma のDBへ移管する（Phase 5）
 * ============================================================
 * salesagent-reagey の本番DB → salesagent-luma の本番DB（tenant='reagey'）
 *
 * 前提:
 *   - 移管先に台本01が適用済み（tenants / user_tenants / tenant_id が存在する）
 *   - 企業マッピングは正規化名で自動判定する（docs/merge/companies-map.csv と同じロジック）
 *   - 「別会社」と記録済みのペア（company_merge_dismissed）は候補から外す
 *
 * ID の扱い:
 *   リージーの UUID をそのまま使う（衝突しない）。ただし企業とユーザーだけは
 *   Luma 側の既存レコードへ寄せるためマッピングを通す。
 *   同じ id が既にあればスキップするので、途中で失敗しても再実行できる。
 *
 * 移管しないもの:
 *   - 書類のファイル実体（Vercel Blob のストアが別。メタ情報のみ移し、実体は別途）
 *   - meetings.transcript_status / recording_mime / transcript_error（Luma に無い・全て空）
 *   - deals.first_meeting_date（Luma に無い。空の appointment_date にのみ補完する）
 *   - invites / sessions / accounts（移す意味がない）
 *
 * 実行:
 *   node scripts/migrate-reagey.mjs .env.staging --dry-run   # 何が起きるか見る
 *   node scripts/migrate-reagey.mjs .env.staging             # テストブランチで実行
 *   node scripts/migrate-reagey.mjs .env.production.local    # 本番
 */
import fs from "node:fs";
import pg from "pg";

const envFile = process.argv[2] ?? ".env.staging";
const DRY = process.argv.includes("--dry-run");
const REAGEY = "22222222-2222-4222-8222-222222222222";

const dstUrl = fs.readFileSync(envFile, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)/m)[1];
const srcUrl = fs.readFileSync("C:/dev/salesagent-reagey/.env.production", "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)/m)[1];

const norm = (s) =>
  s.replace(/株式会社|有限会社|合同会社|一般社団法人|弁理士法人|税理士法人|\s|　|・|\(|\)|（|）|＆|&/g, "")
    .toLowerCase().normalize("NFKC");

// リージーの業種コード → Luma の Industry マスタ名（複数該当はカンマ区切り）
const INDUSTRY_MAP = {
  it_software: "IT",
  manufacturing: "製造",
  trading_wholesale: "商社",
  retail_ec: "小売・流通",
  food: "飲食",
  medical_healthcare: "医療・福祉",
  realestate_construction: "不動産,建設・設計",
  logistics_transport: "インフラ",
  hr_education: "人材",
  finance_insurance: "金融",
  professional_consulting: "コンサル",
  government_public: "官公庁・団体",
  media_advertising: "広告・出版・マスコミ",
  entertainment: "エンタメ",
  service: "サービス",
  education: "教育",
  beauty_salon: "美容・サロン",
  other: "その他",
};

/**
 * 同一人物だがメールアドレスが会社ごとに違う社員の対応表。
 * リージー側のメール → Luma 側のメール。
 *
 * これが無いと別アカウントとして作られ、全社ビューの担当者別KPIで
 * 同じ人が2行に分かれてしまう（社長判断 2026-08-01：1アカウントに統合する）。
 */
const USER_ALIASES = {
  "ren.sakai@reeasy.jp": "ren.sakai@luma-create.com",
};

const src = new pg.Client({ connectionString: srcUrl });
const dst = new pg.Client({ connectionString: dstUrl });
await src.connect();
await dst.connect();

const dstHost = new URL(dstUrl).host;
console.log(`移管先: ${dstHost}${DRY ? "（dry-run：何も書き込まない）" : ""}\n`);

const stats = {};
const bump = (k, n = 1) => (stats[k] = (stats[k] ?? 0) + n);

// ------------------------------------------------------------
// 事前チェック
// ------------------------------------------------------------
const tenant = (await dst.query(`select id, code from tenants where id=$1`, [REAGEY])).rows[0];
if (!tenant) {
  console.error("移管先に リージー テナントがありません。台本01を先に適用してください。");
  process.exit(1);
}

// ------------------------------------------------------------
// 1. ユーザー
// ------------------------------------------------------------
const srcUsers = (await src.query(`select * from users`)).rows;
const dstUsers = (await dst.query(`select id, email from users`)).rows;
const dstByEmail = new Map(dstUsers.map((u) => [u.email.toLowerCase(), u.id]));
const userMap = new Map(); // リージーのuser.id → Luma の user.id

for (const u of srcUsers) {
  const email = u.email.toLowerCase();
  const aliasTo = USER_ALIASES[email];
  const hit = dstByEmail.get(email) ?? (aliasTo ? dstByEmail.get(aliasTo) : undefined);
  if (hit) {
    userMap.set(u.id, hit);
    bump(aliasTo && !dstByEmail.get(email) ? "既存ユーザーに統合（メール違い）" : "既存ユーザーに紐付け");
  } else {
    // メールが違う社員（坂井さんの @reeasy.jp）は別アカウントとして作る。
    // 1人1アカウントへの統合はメールのエイリアス対応が要るため v2 で行う。
    userMap.set(u.id, u.id);
    if (!DRY) {
      await dst.query(
        `insert into users (id, email, password_hash, name, name_kana, image, email_verified, role, permission, avatar_color, avatar_url, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict (id) do nothing`,
        [u.id, u.email, u.password_hash, u.name, u.name_kana ?? null, u.image ?? null,
         u.email_verified ?? null, u.role, u.permission, u.avatar_color ?? null, u.avatar_url ?? null, u.created_at]);
    }
    bump("新規ユーザー作成");
  }
  // リージーテナントへの所属を付与
  if (!DRY) {
    await dst.query(
      `insert into user_tenants (id, user_id, tenant_id, permission, role, is_default, cross_tenant_read)
       values (gen_random_uuid()::text, $1, $2, $3, $4, false, $5)
       on conflict (user_id, tenant_id) do nothing`,
      [userMap.get(u.id), REAGEY, u.permission, u.role, u.permission === "admin"]);
  }
  bump("リージー所属を付与");
}
const mapUser = (id) => (id ? (userMap.get(id) ?? null) : null);

// ------------------------------------------------------------
// 2. マスタ（商材・プラン・商談プロセス・リード獲得経由）
// ------------------------------------------------------------
for (const [table, cols] of [
  ["products", ["id", "name", "category", "description", "active", "created_at"]],
  ["product_plans", ["id", "product_id", "name", "base_price", "description", "sort_order", "active", "created_at"]],
  ["pipeline_stages", ["id", "value", "label", "group", "badge_text", "badge_bg", "active", "sort_order", "created_at"]],
  ["lead_sources", ["id", "name", "active", "sort_order", "created_at"]],
]) {
  const rows = (await src.query(`select * from ${table}`)).rows;
  for (const r of rows) {
    if (!DRY) {
      const vals = cols.map((c) => r[c]);
      const ph = cols.map((_, i) => `$${i + 1}`);
      await dst.query(
        `insert into ${table} (${cols.map((c) => `"${c}"`).join(",")}, tenant_id)
         values (${ph.join(",")}, $${cols.length + 1}) on conflict (id) do nothing`,
        [...vals, REAGEY]);
    }
    bump(table);
  }
}

// ------------------------------------------------------------
// 3. 企業（共有マスタ。既存に寄せるか新規作成するか）
// ------------------------------------------------------------
const dstCompanies = (await dst.query(
  `select id, name from companies where deleted_at is null and merged_into_id is null`)).rows;
const dismissed = new Set();
for (const r of (await dst.query(`select company_id_a a, company_id_b b from company_merge_dismissed`)).rows) {
  dismissed.add(`${r.a}|${r.b}`);
  dismissed.add(`${r.b}|${r.a}`);
}
const dstByNorm = new Map();
for (const c of dstCompanies) {
  const k = norm(c.name);
  if (!dstByNorm.has(k)) dstByNorm.set(k, []);
  dstByNorm.get(k).push(c);
}

const srcCompaniesRaw = (await src.query(`select * from companies where deleted_at is null`)).rows;

// リージー側にも同一企業の重複がある（例: "g-wic" と "株式会社g-wic"）。
// そのまま移すと Luma 側に重複を持ち込むので、正規化名でまとめて1社に寄せる。
// 代表は「法人格付きの正式名」を優先し、同条件なら商談が多いほうを選ぶ。
const srcGroups = new Map();
for (const c of srcCompaniesRaw) {
  const k = norm(c.name);
  if (!srcGroups.has(k)) srcGroups.set(k, []);
  srcGroups.get(k).push(c);
}
const srcDealCount = new Map(
  (await src.query(`select company_id, count(*)::int n from deals where deleted_at is null group by 1`)).rows
    .map((r) => [r.company_id, r.n]),
);
const srcAlias = new Map(); // 統合される側の id → 代表の id
const srcCompanies = [];
for (const group of srcGroups.values()) {
  if (group.length === 1) { srcCompanies.push(group[0]); continue; }
  const rep = [...group].sort((a, b) => {
    const fa = /株式会社|有限会社|合同会社/.test(a.name) ? 1 : 0;
    const fb = /株式会社|有限会社|合同会社/.test(b.name) ? 1 : 0;
    if (fa !== fb) return fb - fa;
    return (srcDealCount.get(b.id) ?? 0) - (srcDealCount.get(a.id) ?? 0);
  })[0];
  srcCompanies.push(rep);
  for (const g of group) {
    if (g.id !== rep.id) {
      srcAlias.set(g.id, rep.id);
      console.log(`  リージー側の重複をまとめる: 「${g.name}」→「${rep.name}」`);
      bump("企業：リージー側の重複を統合");
    }
  }
}

const companyMap = new Map();
const ambiguous = [];

for (const c of srcCompanies) {
  let cands = dstByNorm.get(norm(c.name)) ?? [];
  if (cands.length > 1) {
    const exact = cands.filter((x) => x.name === c.name);
    const pairDismissed = cands.some((x, i) => cands.some((y, j) => i < j && dismissed.has(`${x.id}|${y.id}`)));
    if (pairDismissed && exact.length === 1) cands = exact;
  }
  if (cands.length === 1) {
    companyMap.set(c.id, cands[0].id);
    bump(cands[0].name === c.name ? "企業：既存に紐付け（完全一致）" : "企業：既存に紐付け（表記ゆれ）");
  } else if (cands.length > 1) {
    ambiguous.push({ name: c.name, candidates: cands.map((x) => x.name) });
  } else {
    // Luma に無い企業は新規作成（起票テナント＝リージー）
    companyMap.set(c.id, c.id);
    const industry = (c.industries ?? []).map((code) => INDUSTRY_MAP[code]).filter(Boolean).join(",") || c.industry || null;
    if (!DRY) {
      await dst.query(
        `insert into companies (id, name, industry, website_url, website_summary, website_fetched_at, note,
           address, ceo_name, established_year, employee_count, capital, phone_number, logo_color, logo_url,
           created_at, created_by_tenant_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) on conflict (id) do nothing`,
        [c.id, c.name, industry, c.website_url, c.website_summary, c.website_fetched_at, c.note,
         c.address, c.ceo_name, c.established_year, c.employee_count, c.capital, c.phone_number,
         c.logo_color, c.logo_url, c.created_at, REAGEY]);
    }
    bump("企業：新規作成");
  }
}

// 統合された側の企業も、代表と同じ Luma 企業に向ける
for (const [from, to] of srcAlias) {
  const target = companyMap.get(to);
  if (target) companyMap.set(from, target);
}

if (ambiguous.length) {
  console.error("候補が絞れない企業があります。先に Luma 側の重複を統合するか、別会社として記録してください：");
  ambiguous.forEach((a) => console.error(`  ${a.name} → ${a.candidates.join(" / ")}`));
  await src.end();
  await dst.end();
  process.exit(1);
}

// ------------------------------------------------------------
// 4. 連絡先（既存企業に寄せた場合は同名・同メールの重複を作らない）
// ------------------------------------------------------------
const srcContacts = (await src.query(`select * from contacts`)).rows;
for (const ct of srcContacts) {
  const companyId = companyMap.get(ct.company_id);
  if (!companyId) { bump("連絡先：削除済み企業のため対象外"); continue; }
  const dup = (await dst.query(
    `select id from contacts where company_id=$1 and (
       (email is not null and email <> '' and email = $2) or name = $3) limit 1`,
    [companyId, ct.email ?? "", ct.name])).rows[0];
  if (dup) { bump("連絡先：既存と重複のためスキップ"); continue; }
  if (!DRY) {
    await dst.query(
      `insert into contacts (id, company_id, name, role, email, phone, is_primary, is_decision_maker, note, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (id) do nothing`,
      [ct.id, companyId, ct.name, ct.role, ct.email, ct.phone, ct.is_primary, ct.is_decision_maker, ct.note, ct.created_at]);
  }
  bump("連絡先：追加");
}

// ------------------------------------------------------------
// 5. 商談・商材
// ------------------------------------------------------------
const srcDeals = (await src.query(`select * from deals`)).rows;
// 移管した商談の id。子テーブル（商材・議事録・タスク等）は、この商談に
// ぶら下がるものだけを移す。対象外の商談の子を入れると FK 違反になる。
const migratedDealIds = new Set();
for (const d of srcDeals) {
  const companyId = companyMap.get(d.company_id);
  // リージー側で削除済みの企業（デモ用ダミー等）は移管対象外。その商談も移さない。
  if (!companyId) { bump("商談：削除済み企業のため対象外"); continue; }
  // Luma に first_meeting_date が無いため、appointment_date が空の場合だけ補完する
  const appointment = d.appointment_date ?? d.first_meeting_date ?? null;
  if (!DRY) {
    await dst.query(
      `insert into deals (id, company_id, owner_user_id, title, status, pipeline_stage, next_action, next_action_at,
         expected_close_date, contract_date, appointment_date, lead_source_id, lead_source_memo, bant, bant_updated_at,
         deleted_at, created_at, updated_at, tenant_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) on conflict (id) do nothing`,
      [d.id, companyId, mapUser(d.owner_user_id), d.title, d.status, d.pipeline_stage, d.next_action,
       d.next_action_at, d.expected_close_date, d.contract_date, appointment, d.lead_source_id,
       d.lead_source_memo, d.bant === null || d.bant === undefined ? null : JSON.stringify(d.bant),
       d.bant_updated_at, d.deleted_at, d.created_at, d.updated_at, REAGEY]);
  }
  migratedDealIds.add(d.id);
  bump("商談");
}

const srcDP = (await src.query(`select * from deal_products`)).rows;
for (const p of srcDP) {
  if (!migratedDealIds.has(p.deal_id)) { bump("商材：対象外の商談のため除外"); continue; }
  if (!DRY) {
    await dst.query(
      `insert into deal_products (id, deal_id, product_id, product_name, plan_name, probability, amount,
         yomi_status, owner_user_id, notes, created_at, updated_at, tenant_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict (id) do nothing`,
      [p.id, p.deal_id, p.product_id, p.product_name, p.plan_name, p.probability, p.amount,
       p.yomi_status, mapUser(p.owner_user_id), p.notes, p.created_at, p.updated_at, REAGEY]);
  }
  bump("商材");
}

// ------------------------------------------------------------
// 6. 議事録・タスク・AIログ・チャット・ロープレ・目標・書類
// ------------------------------------------------------------
const simple = ["meetings", "tasks", "ai_logs", "chat_messages", "roleplay_sessions", "goals", "documents"];

for (const table of simple) {
  // カラムを列挙して書くと取りこぼす（実際 roleplay_sessions で NOT NULL 列が抜けて落ちた）。
  // 「リージーにあり、かつ Luma にもある列」を全て移す方式にして、
  // スキーマ差分（Luma に無い列）は自動的に落ちるようにする。
  const srcCols = (await src.query(
    `select column_name from information_schema.columns where table_schema='public' and table_name=$1
     order by ordinal_position`, [table]
  )).rows.map((r) => r.column_name);
  const dstColRows = (await dst.query(
    `select column_name, udt_name from information_schema.columns where table_schema='public' and table_name=$1`, [table]
  )).rows;
  const dstCols = new Set(dstColRows.map((r) => r.column_name));
  // jsonb 列に JS の配列をそのまま渡すと pg が PostgreSQL の配列リテラル（{a,b}）に
  // 変換してしまい "invalid input syntax for type json" になる。明示的に文字列化する。
  const jsonCols = new Set(dstColRows.filter((r) => r.udt_name === "json" || r.udt_name === "jsonb").map((r) => r.column_name));
  const cols = srcCols.filter((c) => dstCols.has(c) && c !== "tenant_id");
  const dropped = srcCols.filter((c) => !dstCols.has(c));
  if (dropped.length) console.log(`  ${table}: Luma に無い列を落とす → ${dropped.join(", ")}`);

  const rows = (await src.query(`select * from ${table}`)).rows;
  for (const r of rows) {
    // deal_id を持つテーブルは、移管した商談にぶら下がるものだけを対象にする
    if (cols.includes("deal_id") && r.deal_id && !migratedDealIds.has(r.deal_id)) {
      bump(`${table}：対象外の商談のため除外`);
      continue;
    }
    const vals = cols.map((c) => {
      if (c === "owner_user_id" || c === "assignee_user_id" || c === "user_id" || c === "uploaded_by_id") {
        return mapUser(r[c]);
      }
      const v = r[c];
      if (jsonCols.has(c) && v !== null && typeof v === "object") return JSON.stringify(v);
      return v;
    });
    if (!DRY) {
      await dst.query(
        `insert into ${table} (${cols.map((c) => `"${c}"`).join(",")}, tenant_id)
         values (${cols.map((_, i) => `$${i + 1}`).join(",")}, $${cols.length + 1}) on conflict (id) do nothing`,
        [...vals, REAGEY]);
    }
    bump(table);
  }
}

// ------------------------------------------------------------
// 結果
// ------------------------------------------------------------
console.log("=== 移管内容 ===");
for (const [k, v] of Object.entries(stats)) console.log(`  ${k.padEnd(32)} ${v}`);

if (!DRY) {
  console.log("\n=== 移管後の件数（リージーテナント）===");
  for (const t of ["deals", "deal_products", "meetings", "tasks", "documents", "ai_logs",
                   "chat_messages", "roleplay_sessions", "goals", "products", "lead_sources", "pipeline_stages"]) {
    const n = (await dst.query(`select count(*)::int n from ${t} where tenant_id=$1`, [REAGEY])).rows[0].n;
    console.log(`  ${t.padEnd(20)} ${n}`);
  }
  const cn = (await dst.query(`select count(*)::int n from companies where created_by_tenant_id=$1`, [REAGEY])).rows[0].n;
  console.log(`  companies（新規作成分） ${cn}`);
  const un = (await dst.query(`select count(*)::int n from user_tenants where tenant_id=$1`, [REAGEY])).rows[0].n;
  console.log(`  リージー所属ユーザー   ${un}`);
} else {
  console.log("\n--dry-run のため何も書き込んでいない");
}

await src.end();
await dst.end();
