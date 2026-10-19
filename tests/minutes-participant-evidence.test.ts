import assert from "node:assert/strict";
import test from "node:test";
import { groundMinutesParticipants } from "../src/lib/ai/minutes-participant-evidence";

// UI確認 2026-10-01（edge-02）：2分30秒の対面録音で、同席していない「工場長の石田」（話の中で名前が出ただけ）が参加者に入った。
// 参加者は、発言者（文字起こしの話者ラベル）か、同席が原文で分かる人だけにする。
const MIC = [
  "話者1: 架空の検証用商談でルーマの佐藤が担当します。",
  "話者2: 水楢正規、総務部の森田です。",
  "話者1: 最終的なご判断はどなたがされますか。",
  "話者2: 決済は工場長の石田です。",
  "話者2: 私が比較した資料を石田に上げて決めます。",
].join("\n");

test("a person only mentioned in the conversation is not a participant (edge-02)", () => {
  const draft = ["話者1: ルーマの佐藤", "話者2: 水楢正規、総務部の森田", "話者2: 工場長の石田"];
  const result = groundMinutesParticipants(MIC, draft);
  assert.deepEqual(result.participants, ["話者1: ルーマの佐藤", "話者2: 水楢正規、総務部の森田"]);
  assert.deepEqual(result.audit.rejected, [{ index: 2, participant: "話者2: 工場長の石田", reason: "duplicate_speaker_label" }]);
  // 話者ラベルの無い「工場長の石田」も、同席の発言が無ければ参加者にしない。
  assert.deepEqual(groundMinutesParticipants(MIC, ["話者1", "話者2", "工場長の石田"]).participants, ["話者1", "話者2"]);
});

test("speakers are kept with their supplements and label forms", () => {
  const transcript = "営業：本日はありがとうございます。\n山田（顧客）：よろしくお願いします。\n話者3：はい。";
  assert.deepEqual(groundMinutesParticipants(transcript, ["営業", "山田（顧客）", "話者3（所属未確認）", "話者3: 鈴木"]).participants,
    ["営業", "山田（顧客）", "話者3（所属未確認）"]);
});

test("a non-speaker is kept only when the source states attendance, never when it is negated", () => {
  const present = "顧客：本日は部長の田中も同席しております。\n営業：ありがとうございます。";
  assert.deepEqual(groundMinutesParticipants(present, ["顧客", "営業", "部長の田中様"]).participants, ["顧客", "営業", "部長の田中様"]);
  // 役割ラベル（顧客・営業）は複数人が共有しうるため、同じラベルの2人目は同席の発言がある場合だけ残す。
  assert.deepEqual(groundMinutesParticipants(present, ["顧客: 森田", "顧客: 部長の田中", "顧客: 工場長の石田"]).participants,
    ["顧客: 森田", "顧客: 部長の田中"]);
  const absent = "顧客：部長の田中は今日は同席できません。\n営業：承知しました。";
  assert.deepEqual(groundMinutesParticipants(absent, ["顧客", "営業", "部長の田中"]).participants, ["顧客", "営業"]);
});

test("unlabelled transcripts cannot verify speakers, so the draft participants are kept as they are", () => {
  const transcript = "本日はよろしくお願いします。\n課題は応募数です。";
  assert.deepEqual(groundMinutesParticipants(transcript, ["営業", "顧客"]).participants, ["営業", "顧客"]);
  assert.deepEqual(groundMinutesParticipants(transcript, "invalid").participants, []);
});
