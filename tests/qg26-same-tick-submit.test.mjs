import test from "node:test";
import assert from "node:assert/strict";
import { clickable, findAll, loadComponent, mountComponent } from "./helpers/component-harness.mjs";

// QG26-10 (ui.json sameTickRequests): two clicks in the same event, before React
// re-renders the disabled button, must send one request. Like Meet発行 (meetInFlight),
// each action is guarded by a ref; after the request ends the button works again.
const clickTwice = (element) => {
  element.props.onClick({ preventDefault() {}, stopPropagation() {} });
  element.props.onClick({ preventDefault() {}, stopPropagation() {} });
};
const matching = (app, method, pattern) => app.requests.filter((r) => r.method === method && pattern.test(r.url));

test("QG26-10 AI再分析 (minutes-editor) sends one analyze request for a same-tick double click", async () => {
  const bundle = await loadComponent("src/components/deals/minutes-editor.tsx");
  const app = mountComponent(bundle, "MinutesEditor", {
    meetingId: "meeting-1", initialMinutes: "架空の議事録", initialTranscript: "", meetingDate: "2026-10-01T00:00:00Z",
  });
  clickTwice(clickable(app.tree(), "AI再分析"));
  const analyze = matching(app, "POST", /\/api\/meetings\/meeting-1\/analyze$/);
  assert.equal(analyze.length, 1);
  analyze[0].answer({ ok: true });
  await app.settle();
  clickable(app.tree(), "AI再分析").props.onClick();
  assert.equal(matching(app, "POST", /\/analyze$/).length, 2, "released after the request ends");
});

test("QG26-10 保存してAI分析 (upload-recording) saves the record once for a same-tick double click", async () => {
  const bundle = await loadComponent("src/components/deals/upload-recording.tsx");
  const app = mountComponent(bundle, "UploadRecording", { dealId: "deal-1" });
  clickable(app.tree(), "議事録テキスト").props.onClick();
  await app.settle();
  const [textarea] = findAll(app.tree(), (node) => node.type === "Textarea");
  textarea.props.onChange({ target: { value: "架空の商談メモ" } });
  await app.settle();
  clickTwice(clickable(app.tree(), "保存してAI分析"));
  const saves = matching(app, "POST", /\/api\/meetings$/);
  assert.equal(saves.length, 1);
  saves[0].answer({ error: "保存できません" }, 500);
  await app.settle();
  clickable(app.tree(), "保存してAI分析").props.onClick();
  assert.equal(matching(app, "POST", /\/api\/meetings$/).length, 2, "released after the request ends");
});

test("QG26-10 事前準備を作成 (preparation-panel) posts once for a same-tick double click", async () => {
  const bundle = await loadComponent("src/components/deals/preparation-panel.tsx");
  const app = mountComponent(bundle, "PreparationPanel", { dealId: "deal-1", status: "LEAD", preparationV2Enabled: true }, (request) => {
    if (request.method !== "GET") return undefined;
    return Response.json(request.url.includes("history=1") ? { briefs: [] } : { brief: null, can_create: true });
  });
  await app.settle();
  clickTwice(clickable(app.tree(), "事前準備を作成"));
  const posts = matching(app, "POST", /\/api\/deals\/deal-1\/preparation$/);
  assert.equal(posts.length, 1);
  posts[0].answer({ error: "失敗" }, 500);
  await app.settle();
  clickable(app.tree(), "事前準備を作成").props.onClick();
  assert.equal(matching(app, "POST", /\/preparation$/).length, 2, "released after the request ends");
});

test("QG26-10 AI再集約 (bant-summary) posts once for a same-tick double click", async () => {
  const bundle = await loadComponent("src/components/deals/bant-summary.tsx");
  const app = mountComponent(bundle, "BantSummary", {
    dealId: "deal-1", initial: null, bantUpdatedAt: null, meetingsCount: 1, canEdit: true, meetings: [],
  });
  await app.settle();
  clickTwice(clickable(app.tree(), "AI再集約"));
  const posts = matching(app, "POST", /\/api\/deals\/deal-1\/summarize-bant$/);
  assert.equal(posts.length, 1);
  posts[0].answer({ error: "AI再集約が処理中です。" }, 409);
  await app.settle();
  clickable(app.tree(), "AI再集約").props.onClick();
  assert.equal(matching(app, "POST", /\/summarize-bant$/).length, 2, "released after the request ends");
});

test("QG26-10 見積の確定してPDF発行・下書き保存 (quote-builder) send one request for a same-tick double click", async () => {
  const bundle = await loadComponent("src/components/deals/quote-builder.tsx");
  const draft = {
    id: "quote-1", status: "draft", quoteNumber: null, clientName: "架空株式会社", clientHonorific: "御中", subject: "架空の件名",
    note: null, taxRate: 10, version: null, issueDate: "2026-10-01T00:00:00Z", createdAt: "2026-10-01T00:00:00Z", finalizedAt: null,
    documentId: null, dealProduct: null, parentQuoteId: null, revisionOfId: null, subtotal: 1000, taxTotal: 100, grandTotal: 1100,
    lines: [{ name: "架空の品目", detail: null, qty: 1, unitPrice: 1000, unit: "式", taxCategory: "taxable", taxRate: 10 }],
  };
  const app = mountComponent(bundle, "QuoteBuilder", {
    dealId: "deal-1", companyName: "架空株式会社", dealProducts: [], canEdit: true, featureV2: true,
  }, (request) => {
    if (request.method !== "GET") return undefined;
    if (request.url.endsWith("/api/deals/deal-1/quotes")) return Response.json({ quotes: [draft] });
    if (request.url.includes("/api/quote-templates")) return Response.json({ templates: [] });
    return Response.json({});
  });
  await app.settle();

  // The list's 確定してPDF発行 (finalizeExisting).
  clickTwice(clickable(app.tree(), "確定してPDF発行"));
  const finalizes = matching(app, "POST", /\/api\/quotes\/quote-1\/finalize$/);
  assert.equal(finalizes.length, 1);
  finalizes[0].answer({ error: "採番に失敗しました" }, 409);
  await app.settle();

  // The form's 下書き保存 and 確定してPDF発行 (save) while editing the draft.
  clickable(app.tree(), "この見積を修正する").props.onClick();
  await app.settle();
  const formButtons = () => findAll(app.tree(), (node) => node.type === "Button" && typeof node.props.onClick === "function");
  const formSave = () => formButtons().find((node) => JSON.stringify(node.props.children ?? "").includes("下書き"));
  assert.ok(formSave(), "下書き保存 button");
  clickTwice(formSave());
  const patches = matching(app, "PATCH", /\/api\/quotes\/quote-1$/);
  assert.equal(patches.length, 1);
  patches[0].answer({ error: "保存に失敗しました" }, 500);
  await app.settle();
  formSave().props.onClick();
  assert.equal(matching(app, "PATCH", /\/api\/quotes\/quote-1$/).length, 2, "released after the request ends");
});
