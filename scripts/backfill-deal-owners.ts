/**
 * Backfill deal.ownerUserId from bant.notionAssigneeIds
 *
 * 使い方:
 *   ドライラン:  npx tsx --env-file=.env scripts/backfill-deal-owners.ts
 *   本投入:      npx tsx --env-file=.env scripts/backfill-deal-owners.ts --apply
 *
 * 設計:
 * - 7名 (坂井/傍田/片本/清水/川本/山口/松本) を新規 users に追加
 *   - role=sales, permission=user, password=ランダム16文字 (bcrypt保存, 平文をstdoutに出力)
 * - 三宅哲平の2 Notion ID (合計726件) → 既存 teppei に集約
 * - 404の16 Notion ID (合計410件) → teppei に据え置き
 * - 複数 assignee の場合は **先頭 ID** を主担当として採用
 * - 空配列 (122件) → teppei に据え置き
 */

import { prisma } from "../src/lib/db";
import bcrypt from "bcryptjs";
import crypto from "crypto";

// ----- Notion ID → user 情報マッピング -----
const TEPPEI_EMAIL = "teppei@luma-create.com";
// teppei に集約する Notion ID 群
const TEPPEI_NOTION_IDS = new Set<string>([
  "2bd37934-a88d-4748-9485-c549102f590e", // 三宅哲平 (teppei.miyake@luma-create.com)
  "87173320-d33d-428e-8b91-059b2980121f", // 三宅哲平 (teppei.miyake.luma@gmail.com)
]);

// 新規追加する 7 名
type NewUserSeed = {
  notionId: string;
  email: string;
  name: string;
};
const NEW_USERS: NewUserSeed[] = [
  { notionId: "09722f75-9624-4a43-a181-33e23c8a1080", email: "ren.sakai.luma@gmail.com",   name: "廉 坂井" },
  { notionId: "d604db4c-38dc-4b36-82d3-e10830f5877a", email: "mao.sobata.luma@gmail.com",   name: "傍田茉央" },
  { notionId: "2c6d872b-594c-81df-9873-00021602d388", email: "rui.katamoto.luma@gmail.com", name: "片本流良" },
  { notionId: "144d872b-594c-81cd-b212-0002b8ff74c1", email: "riku.shimizu.luma@gmail.com", name: "清水莉玖" },
  { notionId: "1852837a-4236-407a-9a9e-c33a65023196", email: "rinko.kawamoto.luma@gmail.com", name: "川本倫子" },
  { notionId: "217e548c-b5e0-4911-8f40-9cf5874599a4", email: "rui.yamaguchi@luma-create.com", name: "山口月" },
  { notionId: "d1ff3a96-5479-4e66-9b1b-440355c1eeb1", email: "toa.matsumoto.luma@gmail.com",  name: "toa matsumoto" },
];

function generatePassword(len = 16): string {
  // 強度十分なランダム文字列 (英大小+数字+記号)
  const charset = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%&*";
  const buf = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += charset[buf[i]! % charset.length];
  }
  return out;
}

async function main() {
  if (!process.env.DATABASE_URL?.includes("salesagent_luma")) {
    console.error("ABORT: DATABASE_URL must point to salesagent_luma");
    process.exit(1);
  }

  const apply = process.argv.includes("--apply");
  console.log(apply ? "[APPLY MODE]" : "[DRY-RUN MODE]");

  // teppei admin
  const teppei = await prisma.user.findUnique({ where: { email: TEPPEI_EMAIL } });
  if (!teppei) throw new Error(`admin ${TEPPEI_EMAIL} not found`);
  console.log(`teppei: ${teppei.id} (${teppei.email})`);

  // ===== 1) NEW_USERS の作成（既存があればスキップ） =====
  type PlainCred = { email: string; name: string; password: string };
  const generatedCreds: PlainCred[] = [];
  // notionId → userId のマップ（teppei含む）
  const notionToUserId = new Map<string, string>();
  for (const id of TEPPEI_NOTION_IDS) notionToUserId.set(id, teppei.id);

  for (const seed of NEW_USERS) {
    const existing = await prisma.user.findUnique({ where: { email: seed.email } });
    if (existing) {
      console.log(`  user exists: ${seed.email} (${existing.id}) → skip create`);
      notionToUserId.set(seed.notionId, existing.id);
      continue;
    }
    const plain = generatePassword(16);
    const hash = await bcrypt.hash(plain, 10);
    if (apply) {
      const u = await prisma.user.create({
        data: {
          email: seed.email,
          name: seed.name,
          passwordHash: hash,
          role: "sales",
          permission: "user",
        },
      });
      notionToUserId.set(seed.notionId, u.id);
      console.log(`  user created: ${seed.email} (${u.id})`);
      generatedCreds.push({ email: seed.email, name: seed.name, password: plain });
    } else {
      notionToUserId.set(seed.notionId, `(dry-${seed.email})`);
      console.log(`  [dry] would create user: ${seed.email}`);
      generatedCreds.push({ email: seed.email, name: seed.name, password: "(dry-run)" });
    }
  }

  // ===== 2) deals を走査して owner を更新 =====
  const deals = await prisma.deal.findMany({
    where: { deletedAt: null },
    select: { id: true, ownerUserId: true, bant: true },
  });
  console.log(`\nscanning ${deals.length} deals...`);

  let totalSeen = 0;
  let updatesPlanned = 0;
  let unchanged = 0;
  let teppeiAggregated = 0; // 三宅哲平の2 IDからteppeiへ
  let backfilled = 0; // 7名のいずれかへ
  let leftToTeppei404 = 0; // 404 IDだったため teppei 据え置き
  let leftToTeppeiEmpty = 0; // 空配列で teppei 据え置き
  const ownerCountAfter = new Map<string, number>();
  const unknownIdCount = new Map<string, number>();

  for (const d of deals) {
    totalSeen++;
    const bant: any = d.bant;
    const ids: string[] = (bant && Array.isArray(bant.notionAssigneeIds)) ? bant.notionAssigneeIds : [];
    let targetUserId = teppei.id;
    let reason: "empty" | "teppei_aggregate" | "backfill" | "404_left_teppei" = "empty";

    if (ids.length === 0) {
      reason = "empty";
      leftToTeppeiEmpty++;
    } else {
      const head = ids[0]!;
      if (TEPPEI_NOTION_IDS.has(head)) {
        targetUserId = teppei.id;
        reason = "teppei_aggregate";
        teppeiAggregated++;
      } else {
        const mapped = notionToUserId.get(head);
        if (mapped && !mapped.startsWith("(dry-")) {
          targetUserId = mapped;
          reason = "backfill";
          backfilled++;
        } else if (mapped && mapped.startsWith("(dry-")) {
          // dry-run: 集計だけ
          reason = "backfill";
          backfilled++;
          // ownerCountAfter は dry-run でも seedの email を仮キーとして集計
          targetUserId = mapped;
        } else {
          // 404 ID
          targetUserId = teppei.id;
          reason = "404_left_teppei";
          leftToTeppei404++;
          unknownIdCount.set(head, (unknownIdCount.get(head) || 0) + 1);
        }
      }
    }

    ownerCountAfter.set(targetUserId, (ownerCountAfter.get(targetUserId) || 0) + 1);

    // 実際にUPDATEが必要か?
    if (d.ownerUserId !== targetUserId && !targetUserId.startsWith("(dry-")) {
      updatesPlanned++;
      if (apply) {
        await prisma.deal.update({
          where: { id: d.id },
          data: { ownerUserId: targetUserId },
        });
      }
    } else if (targetUserId.startsWith("(dry-")) {
      updatesPlanned++; // 仮想
    } else {
      unchanged++;
    }
  }

  console.log(`\n========== BACKFILL SUMMARY ==========`);
  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Deals scanned       : ${totalSeen}`);
  console.log(`Updates planned     : ${updatesPlanned}`);
  console.log(`Unchanged           : ${unchanged}`);
  console.log(`  teppei aggregated : ${teppeiAggregated}`);
  console.log(`  backfilled to 7名 : ${backfilled}`);
  console.log(`  404 left to teppei: ${leftToTeppei404}`);
  console.log(`  empty left teppei : ${leftToTeppeiEmpty}`);
  console.log("\n--- owner deal counts (after) ---");
  // user名でのロギング用
  const allUsers = await prisma.user.findMany({ select: { id: true, name: true, email: true } });
  const userMap = new Map(allUsers.map((u) => [u.id, u]));
  const sorted = [...ownerCountAfter.entries()].sort((a, b) => b[1] - a[1]);
  for (const [uid, cnt] of sorted) {
    if (uid.startsWith("(dry-")) {
      console.log(`  [dry] ${uid}: ${cnt}`);
    } else {
      const u = userMap.get(uid);
      console.log(`  ${u?.name || "?"} <${u?.email || uid}>: ${cnt}`);
    }
  }

  if (unknownIdCount.size > 0) {
    console.log("\n--- 404 Notion IDs left to teppei ---");
    const sortedUnknown = [...unknownIdCount.entries()].sort((a, b) => b[1] - a[1]);
    for (const [id, c] of sortedUnknown) {
      console.log(`  ${id}: ${c} deals`);
    }
  }

  if (generatedCreds.length > 0) {
    console.log(`\n========== GENERATED CREDENTIALS (DO NOT LOG!) ==========`);
    console.log(`(${apply ? "REAL" : "PLACEHOLDER"} passwords; copy now)`);
    console.log("name|email|password");
    for (const c of generatedCreds) {
      console.log(`${c.name}|${c.email}|${c.password}`);
    }
    console.log(`==========================================================`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
