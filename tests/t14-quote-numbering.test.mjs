import assert from "node:assert/strict";
import test from "node:test";
import { loadFinalize } from "./helpers/t14-harness.mjs";

// T14: 見積番号の採番（POST /api/quotes/[id]/finalize）。
// 発行者設定の next_quote_number を「読んでから、別の UPDATE で +1」すると、読んだ後に別の発行や
// 管理画面の開始番号変更（PATCH /api/admin/quote-settings）がコミットしたとき、同じ番号を2回使う
// （(tenant_id, quote_number) の一意制約で発行が失敗する）か、番号が飛ぶ。
// ここでは Postgres（READ COMMITTED）の振る舞いを小さな偽 DB で再現し、割り込みを確実に起こして確かめる。

const ISSUE_DATE = new Date("2026-09-29T15:30:00Z"); // JST では 2026-09-30 00:30 → L-20260930-NNNN

const failure = (message, code) => Object.assign(new Error(message), { code });

function fakeDb(profiles) {
  const db = {
    profiles: profiles.map((profile, index) => ({
      id: `profile-${index + 1}`, tenantId: "tenant-a", legalName: "架空発行者", postalCode: "100-0000",
      addressLine1: "架空県架空市", addressLine2: "1-2-3", logoUrl: null, defaultNotes: "", travelExpenseNote: null,
      numberPrefix: "L", nextQuoteNumber: 1, updatedAt: new Date(0), ...profile,
    })),
    quotes: new Map(),
    documents: [],
    uploads: 0,
    deleted: 0,
    // 発行者設定を読んだ（SELECT した）直後、呼び出し元へ値を返す前に1回だけ割り込む処理。
    // 「読んだ後・足す前」に別のトランザクションがコミットする状況を再現する。
    afterProfileRead: null,
  };
  const locks = new Map();
  const matches = (row, where = {}) => Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if ("not" in value) return row[key] !== value.not;
      throw new Error(`偽 DB が扱えない条件です: ${key}`);
    }
    return row[key] === value;
  });
  // ロールバック用に、書き換える前の行を覚えておく
  const remember = (tx, row) => {
    if (!tx) return;
    const before = structuredClone(row);
    tx.undo.push(() => Object.assign(row, before));
  };

  const client = (tx) => ({
    // pg_advisory_xact_lock(hashtext(見積ID)): 同じキーはトランザクションの終わりまで待たせる
    $executeRaw: async (_strings, ...values) => {
      if (!tx) throw new Error("advisory lock outside transaction");
      const key = values.join("|");
      const previous = locks.get(key) ?? Promise.resolve();
      let release;
      const current = new Promise((resolve) => { release = resolve; });
      locks.set(key, previous.then(() => current));
      tx.releases.push(release);
      await previous;
      return 1;
    },
    quote: {
      findUnique: async ({ where }) => {
        const row = db.quotes.get(where.id);
        return row ? structuredClone(row) : null;
      },
      update: async ({ where, data }) => {
        const row = db.quotes.get(where.id);
        if (!row) throw failure("Record to update not found", "P2025");
        for (const key of ["quoteNumber", "idempotencyKey"]) {
          if (data[key] == null) continue;
          for (const other of db.quotes.values()) {
            if (other !== row && other.tenantId === row.tenantId && other[key] === data[key]) {
              throw failure(`Unique constraint failed on the fields: (tenant_id, ${key})`, "P2002");
            }
          }
        }
        remember(tx, row);
        Object.assign(row, data, { updatedAt: new Date(row.updatedAt.getTime() + 1) });
        return structuredClone(row);
      },
    },
    quoteIssuerProfile: {
      findFirst: async ({ where } = {}) => {
        const row = db.profiles.find((profile) => matches(profile, where));
        const snapshot = row ? structuredClone(row) : null;
        const interrupt = db.afterProfileRead;
        db.afterProfileRead = null;
        if (interrupt) await interrupt();
        return snapshot;
      },
      // UPDATE … SET next_quote_number = next_quote_number + 1 … RETURNING *（increment は1文で足す）
      update: async ({ where, data }) => {
        const row = db.profiles.find((profile) => matches(profile, where));
        if (!row) throw failure("Record to update not found", "P2025");
        remember(tx, row);
        for (const [key, value] of Object.entries(data)) {
          row[key] = value && typeof value === "object" && "increment" in value ? row[key] + value.increment : value;
        }
        row.updatedAt = new Date(row.updatedAt.getTime() + 1);
        return structuredClone(row);
      },
      // 管理画面の保存と同じ条件付き更新（UPDATE … WHERE id = ? AND next_quote_number = 確認した値）
      updateMany: async ({ where, data }) => {
        const rows = db.profiles.filter((profile) => matches(profile, where));
        for (const row of rows) {
          remember(tx, row);
          Object.assign(row, data, { updatedAt: new Date(row.updatedAt.getTime() + 1) });
        }
        return { count: rows.length };
      },
    },
    document: {
      create: async ({ data }) => {
        const doc = { id: `document-${db.documents.length + 1}`, ...data };
        db.documents.push(doc);
        tx?.undo.push(() => db.documents.splice(db.documents.indexOf(doc), 1));
        return { ...doc };
      },
    },
  });

  db.prisma = {
    ...client(null),
    $transaction: async (fn) => {
      const tx = { undo: [], releases: [] };
      try {
        return await fn(client(tx));
      } catch (error) {
        for (const undo of tx.undo.reverse()) undo();
        throw error;
      } finally {
        for (const release of tx.releases) release();
      }
    },
  };
  return db;
}

function addQuote(db, id, overrides = {}) {
  db.quotes.set(id, {
    id, tenantId: "tenant-a", dealId: "deal", dealProductId: null, status: "draft", version: null, documentId: null,
    clientName: "架空商事", clientHonorific: "御中", subject: "架空案件", note: null, issueDate: ISSUE_DATE,
    updatedAt: new Date(1_000), quoteNumber: null, idempotencyKey: null, issuerSnapshot: null,
    lines: [{ name: "映像制作", detail: null, qty: 1, unitPrice: 100_000, unit: "式", taxCategory: "taxable", taxRate: 10 }],
    ...overrides,
  });
}

async function post(route, id) {
  const res = await route.POST(
    new Request("http://offline.invalid", { method: "POST", body: "{}" }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: await res.json() };
}

/** 管理画面が「確認した値 checked のままなら next に変える」保存をする（PATCH の条件付き updateMany と同じ形）。 */
const adminChangesNext = (db, tenantId, checked, next) => db.prisma.quoteIssuerProfile.updateMany({
  where: { tenantId, nextQuoteNumber: checked }, data: { nextQuoteNumber: next },
});

const number = (sequence, prefix = "L") => `${prefix}-20260930-${String(sequence).padStart(4, "0")}`;

test("T14 採番: 読んだ直後に別の見積の発行が割り込んでも、2件は重複・欠番なしの連番になる", async () => {
  const db = fakeDb([{ nextQuoteNumber: 7 }]);
  addQuote(db, "q1");
  addQuote(db, "q2");
  const route = await loadFinalize(db);
  let second;
  // q1 が発行者設定を読んだ直後（番号を足す前）に、q2 の発行が最後まで進んでコミットする
  db.afterProfileRead = async () => { second = await post(route, "q2"); };
  const first = await post(route, "q1");

  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual([first.body.quoteNumber, second.body.quoteNumber].sort(), [number(7), number(8)]);
  assert.deepEqual([db.quotes.get("q1").quoteNumber, db.quotes.get("q2").quoteNumber].sort(), [number(7), number(8)]);
  assert.equal(db.profiles[0].nextQuoteNumber, 9);
  assert.equal(db.documents.length, 2);
});

test("T14 採番: 5件を同時に発行しても、番号は重複せず続き番号になる", async () => {
  const db = fakeDb([{ nextQuoteNumber: 7 }]);
  const ids = ["q1", "q2", "q3", "q4", "q5"];
  for (const id of ids) addQuote(db, id);
  const route = await loadFinalize(db);
  const results = await Promise.all(ids.map((id) => post(route, id)));

  for (const result of results) assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(results.map((result) => result.body.quoteNumber).sort(), [7, 8, 9, 10, 11].map((n) => number(n)));
  assert.equal(db.profiles[0].nextQuoteNumber, 12);
  assert.equal(db.documents.length, 5);
});

test("T14 採番: 発行中に管理画面が開始番号を下げても、番号は重複せず発行が失敗しない", async () => {
  // まだ番号を使った見積が無いテナント（管理画面で開始番号を下げられる）
  const db = fakeDb([{ nextQuoteNumber: 5 }]);
  const ids = ["q1", "q2", "q3", "q4", "q5"];
  for (const id of ids) addQuote(db, id);
  const route = await loadFinalize(db);
  let adminSave;
  // q1 が発行者設定を読んだ直後に、管理画面の保存（5 → 1）がコミットする
  db.afterProfileRead = async () => { adminSave = await adminChangesNext(db, "tenant-a", 5, 1); };
  const results = [];
  for (const id of ids) results.push(await post(route, id));

  assert.equal(adminSave.count, 1, "管理画面の保存は、発行が番号を足す前なので成功する");
  for (const result of results) assert.equal(result.status, 200, JSON.stringify(result.body));
  // 保存した開始番号 1 から順に使い、同じ日付の番号が重ならない
  assert.deepEqual(results.map((result) => result.body.quoteNumber), [1, 2, 3, 4, 5].map((n) => number(n)));
  assert.equal(db.profiles[0].nextQuoteNumber, 6);
  assert.equal(db.documents.length, 5);
});

test("T14 採番: 発行中に管理画面が開始番号を上げたら、その番号から使い、番号を飛ばさない", async () => {
  const db = fakeDb([{ nextQuoteNumber: 1 }]);
  addQuote(db, "q1");
  addQuote(db, "q2");
  const route = await loadFinalize(db);
  let adminSave;
  db.afterProfileRead = async () => { adminSave = await adminChangesNext(db, "tenant-a", 1, 20); };
  const first = await post(route, "q1");
  const second = await post(route, "q2");

  assert.equal(adminSave.count, 1);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(first.body.quoteNumber, number(20));
  assert.equal(second.body.quoteNumber, number(21));
  assert.equal(db.profiles[0].nextQuoteNumber, 22);
});

test("T14 採番: 発行済みの見積をもう一度確定しても、2つ目の番号を取らない", async () => {
  const db = fakeDb([{ nextQuoteNumber: 7 }]);
  addQuote(db, "q1");
  const route = await loadFinalize(db);
  const first = await post(route, "q1");
  const retry = await post(route, "q1");

  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(first.body.quoteNumber, number(7));
  assert.equal(retry.body.quoteNumber, number(7));
  assert.equal(retry.body.idempotent, true);
  assert.equal(db.profiles[0].nextQuoteNumber, 8);
  assert.equal(db.documents.length, 1);
  assert.equal(db.uploads, 1);
});

test("T14 採番: 保存に失敗した発行をやり直すと、確保済みの番号をそのまま使う", async () => {
  const db = fakeDb([{ nextQuoteNumber: 7 }]);
  addQuote(db, "q1");
  const route = await loadFinalize(db);
  db.failStorage = true;
  const failed = await post(route, "q1");
  assert.equal(failed.status, 503, JSON.stringify(failed.body));
  // 番号は見積に確保されたまま（下書きのまま）
  assert.equal(db.quotes.get("q1").quoteNumber, number(7));
  assert.equal(db.quotes.get("q1").status, "draft");
  assert.equal(db.profiles[0].nextQuoteNumber, 8);

  db.failStorage = false;
  const retry = await post(route, "q1");
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.quoteNumber, number(7));
  assert.equal(db.profiles[0].nextQuoteNumber, 8);
  assert.equal(db.documents.length, 1);
});

test("T14 採番: 同じ見積の確定ボタンを同時に2回押しても、番号は1つだけ使う", async () => {
  const db = fakeDb([{ nextQuoteNumber: 7 }]);
  addQuote(db, "q1");
  const route = await loadFinalize(db);
  const results = await Promise.all([post(route, "q1"), post(route, "q1")]);

  for (const result of results) assert.ok([200, 409].includes(result.status), JSON.stringify(result.body));
  const succeeded = results.filter((result) => result.status === 200);
  assert.ok(succeeded.length >= 1);
  for (const result of succeeded) assert.equal(result.body.quoteNumber, number(7));
  assert.equal(db.quotes.get("q1").quoteNumber, number(7));
  assert.equal(db.quotes.get("q1").status, "final");
  assert.equal(db.profiles[0].nextQuoteNumber, 8);
  assert.equal(db.documents.length, 1);
});

test("T14 採番: 見積の会社の連番だけを進め、その会社の接頭辞と発行者情報を使う", async () => {
  const db = fakeDb([
    { tenantId: "tenant-a", numberPrefix: "L", nextQuoteNumber: 3, legalName: "架空A社" },
    { tenantId: "tenant-b", numberPrefix: "R", nextQuoteNumber: 40, legalName: "架空B社" },
  ]);
  addQuote(db, "qb", { tenantId: "tenant-b" });
  const route = await loadFinalize(db);
  const result = await post(route, "qb");

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.quoteNumber, number(40, "R"));
  assert.equal(db.profiles[0].nextQuoteNumber, 3);
  assert.equal(db.profiles[1].nextQuoteNumber, 41);
  assert.equal(db.quotes.get("qb").issuerSnapshot.legalName, "架空B社");
  assert.equal(db.quotes.get("qb").issuerSnapshot.numberPrefix, "R");
});

test("T14 2タブ同時発行: 2タブ目が読んだ後に1タブ目が発行したら、2タブ目は「採番に失敗」ではなく同じ発行結果を返す", async () => {
  const db = fakeDb([{ nextQuoteNumber: 7 }]);
  addQuote(db, "q1");
  const route = await loadFinalize(db);
  let secondPromise;
  // 1タブ目が番号を確保するトランザクションの中（ロック中）で、2タブ目が下書きの見積を読み、ロック待ちに入る
  db.afterProfileRead = async () => {
    secondPromise = post(route, "q1");
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  const first = await post(route, "q1");
  const second = await secondPromise;

  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.notEqual(second.body.error, "採番に失敗しました。再度お試しください");
  assert.equal(second.body.quoteNumber, number(7));
  assert.equal(second.body.documentId, first.body.documentId);
  assert.equal(second.body.idempotent, true);
  assert.equal(second.body.alreadyIssued, true);
  assert.match(second.body.message, /この見積はすでに発行されています/);
  // 番号・PDF・資料は1つだけ
  assert.equal(db.profiles[0].nextQuoteNumber, 8);
  assert.equal(db.documents.length, 1);
  assert.equal(db.uploads, 1);
  assert.equal(db.quotes.get("q1").status, "final");
});

test("T14 発行済みの見積をもう一度確定すると、すでに発行済みであることを返す", async () => {
  const db = fakeDb([{ nextQuoteNumber: 7 }]);
  addQuote(db, "q1");
  const route = await loadFinalize(db);
  await post(route, "q1");
  const again = await post(route, "q1");
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.alreadyIssued, true);
  assert.match(again.body.message, /この見積はすでに発行されています（L-20260930-0007）/);
});

test("T14 2タブ同時発行: 2タブ目が1タブ目の番号確保の後に読んでも、先に確定した1タブ目は「編集中に更新されました」にならない", async () => {
  const db = fakeDb([{ nextQuoteNumber: 7 }]);
  addQuote(db, "q1");
  const route = await loadFinalize(db);
  let secondPromise;
  let secondRendering;
  const secondEntered = new Promise((resolve) => { secondRendering = resolve; });
  let releaseSecond;
  const secondReleased = new Promise((resolve) => { releaseSecond = resolve; });
  let renders = 0;
  // 1タブ目が番号を確保して PDF を作っている間に2タブ目が見積を読み（確保済みの値）、2タブ目も PDF を作り始める。
  // 1タブ目が先に確定し、そのあと2タブ目が確定しにいく。
  db.duringRender = async () => {
    renders += 1;
    if (renders === 1) {
      secondPromise = post(route, "q1");
      await secondEntered;
    } else {
      secondRendering();
      await secondReleased;
    }
  };
  const first = await post(route, "q1");
  releaseSecond();
  const second = await secondPromise;

  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.quoteNumber, number(7));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.quoteNumber, number(7));
  assert.equal(second.body.documentId, first.body.documentId);
  assert.equal(db.profiles[0].nextQuoteNumber, 8);
  assert.equal(db.documents.length, 1);
  assert.equal(db.quotes.get("q1").status, "final");
});

test("T14 保存に失敗した後に内容を編集してから発行し直すと、確保済みの番号のまま最新の金額で発行する", async () => {
  const db = fakeDb([{ nextQuoteNumber: 7 }]);
  addQuote(db, "q1");
  const route = await loadFinalize(db);
  db.failStorage = true;
  assert.equal((await post(route, "q1")).status, 503);
  db.failStorage = false;
  // 編集（見積の更新）：明細の単価を変える
  const row = db.quotes.get("q1");
  row.lines = [{ ...row.lines[0], unitPrice: 200_000 }];
  row.updatedAt = new Date(row.updatedAt.getTime() + 5);
  const retry = await post(route, "q1");
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.quoteNumber, number(7));
  assert.equal(db.quotes.get("q1").grandTotal, 220_000);
});
