import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// T21/T16：記録ルートの文言は、自社Meetだけ自動記録フラグ（FEATURE_MEET_AUTO_RECORD）で変わる。
// OFF（既定値・切り戻し時）は自動記録が動かないので、自社Meetも従来のブラウザ録音（タブ音声）を案内する。
const require = createRequire(import.meta.url);
const { recordingRouteFor } = require("../src/lib/meetings/recording-route.ts");
const { MeetingRecordingRoute } = require("../src/components/deals/meeting-recording-route.tsx");

const OWNERS = ["own_meet", "guest_meet", "zoom", "in_person", "unknown"];
const texts = (route) => Object.entries(route).filter(([, v]) => typeof v === "string" && v !== route.kind).map(([, v]) => v).join("\n");

test("T16 rollback: own Meet route describes browser recording when auto-record is off", () => {
  const on = recordingRouteFor("own_meet", { autoRecordEnabled: true });
  const off = recordingRouteFor("own_meet", { autoRecordEnabled: false });
  assert.equal(on.kind, "automatic");
  assert.equal(off.kind, "browser");
  assert.equal(on.ownMeet, true);
  assert.equal(off.ownMeet, true, "フラグOFFでも参加先は同じ自社Meet");
  assert.equal(`${off.ownerLabel}・${off.routeLabel}`, "自社発行Meet・ブラウザ録音");
  assert.equal(off.manualSectionTitle, "自社発行Meetをブラウザ録音");
  assert.match(off.manualSectionDescription, /ライブ商談録音の「タブ音声」/);
  assert.match(off.heroAction, /「タブ音声」を選んで録音を開始し、終了後に「停止して送信」/);
  assert.doesNotMatch(texts(off), /自動記録|自動取得|操作は不要|必要な場合の手動添付/);
  // ON は自動記録＋必要な場合の手動添付（T16 AC8）
  assert.equal(`${on.ownerLabel}・${on.routeLabel}`, "自社発行Meet・自動記録");
  assert.equal(on.manualSectionTitle, "必要な場合の手動添付");
  assert.match(on.heroAction, /録音開始の操作は不要/);
  assert.match(on.note, /自社Meetは自動取得します/);
});

test("T21 other meeting types keep the same route whatever the auto-record flag", () => {
  for (const owner of OWNERS.filter((o) => o !== "own_meet")) {
    const { note: noteOn, ...on } = recordingRouteFor(owner, { autoRecordEnabled: true });
    const { note: noteOff, ...off } = recordingRouteFor(owner, { autoRecordEnabled: false });
    assert.deepEqual(off, on, owner);
    assert.equal(on.ownMeet, false, owner);
    assert.match(noteOn, /自社Meetは自動取得します/, owner);
    assert.doesNotMatch(noteOff, /自動取得/, `${owner}: OFFでは自社Meetも自動取得しない`);
  }
});

// 記録ルート表示だけのプレビュー（tests/fixtures/t21-preview.tsx）はフラグを渡さない。省略時は従来の自動記録表示。
test("T21 omitted flag keeps the auto-record presentation", () => {
  for (const owner of OWNERS) {
    assert.deepEqual(recordingRouteFor(owner), recordingRouteFor(owner, { autoRecordEnabled: true }), owner);
  }
});

test("T16 rollback: the recording route card does not promise auto capture when auto-record is off", () => {
  const render = (owner, autoRecordEnabled) =>
    renderToStaticMarkup(createElement(MeetingRecordingRoute, { route: recordingRouteFor(owner, { autoRecordEnabled }) }));
  const off = render("own_meet", false);
  assert.match(off, /自社発行Meet・ブラウザ録音/);
  assert.match(off, /ブラウザのタブ音声録音で相手の声も含めて記録/);
  assert.doesNotMatch(off, /自動記録|自動取得/);
  const on = render("own_meet", true);
  assert.match(on, /自社発行Meet・自動記録/);
  assert.match(on, /自社Meetは自動取得します。取得できない成果物と先方会議は手動添付を利用し/);
  for (const owner of OWNERS.filter((o) => o !== "own_meet")) {
    assert.doesNotMatch(render(owner, false), /自社Meetは自動取得します/, owner);
  }
});
