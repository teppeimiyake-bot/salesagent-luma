// T04: 記録カードの処理状態欄（録音時間・サイズ）と「この回でのBANTメモ（履歴）」の見出し。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import facts from "../src/lib/meetings/recording-facts.ts";

const { recordingFactsLabel } = facts;

test("T04 processing facts put the separator only between duration and size (text attachments have no leading '/')", () => {
  assert.equal(recordingFactsLabel(null, 2 * 1024), "サイズ 2 KB");
  assert.equal(recordingFactsLabel(150, 484 * 1024), "録音時間 2:30 / サイズ 484 KB");
  assert.equal(recordingFactsLabel(3603, null), "録音時間 60:03");
  assert.equal(recordingFactsLabel(null, null), null);
  assert.equal(recordingFactsLabel(0, 0), null);
});

test("T04 the record card uses the shared label, and the BANT memo heading stays on one line at 390px", async () => {
  const source = await readFile(new URL("../src/components/deals/meeting-history.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /<> \/ サイズ /u, "no unconditional leading separator");
  assert.match(source, /recordingFactsLabel\(durationSec, audioSizeBytes\)/u);
  // The title is its own non-wrapping item; only the note wraps to the next line.
  assert.match(source, /<span className="inline-flex items-center gap-1 whitespace-nowrap">\s*<Target[^>]*\/>\s*この回でのBANTメモ（履歴）\s*<\/span>/u);
  assert.match(source, /<p className="[^"]*flex flex-wrap[^"]*">\s*<span className="inline-flex items-center gap-1 whitespace-nowrap">/u);
});

test("T04/T03 the record card player keeps the native controls on desktop and adds a full-width seek slider only below sm", async () => {
  const history = await readFile(new URL("../src/components/deals/meeting-history.tsx", import.meta.url), "utf8");
  const player = await readFile(new URL("../src/components/deals/recording-player.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(history, /<audio\b/u, "the card renders the shared player");
  assert.match(history, /<RecordingPlayer\s+\/\/[^\n]*\n\s*key=\{`\$\{m\.id\}-\$\{playbackReady \? "ready" : "original"\}`\}\s*src=\{`\/api\/meetings\/\$\{m\.id\}\/recording`\}/u);
  // Desktop: unchanged native player.
  assert.match(player, /<audio\s+ref=\{audio\}\s+controls\s+preload="metadata"\s+className="w-full h-10"/u);
  // Narrow screens: a full-width range input that seeks the same element, shown once the duration is known.
  assert.match(player, /\{duration > 0 && \(\s*<div className="mt-2 sm:hidden">\s*<input\s+type="range"/u);
  assert.match(player, /className="block h-8 w-full[^"]*"/u);
  assert.match(player, /element\.currentTime = Number\(event\.target\.value\)/u);
  assert.match(player, /Number\.isFinite\(element\.duration\) \? element\.duration : 0/u, "no slider for an unknown (Infinity) duration");
});
