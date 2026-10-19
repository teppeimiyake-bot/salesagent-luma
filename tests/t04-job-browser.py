"""T04: the actual MeetingHistory in the Cloud Run job mode, with synthetic HTTP only (no database/network)."""
from pathlib import Path
import subprocess
import tempfile
import unittest
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


def job_status(meeting_id, status="transcribing", completed=2, total=6, auto=False, has_transcript=False):
    return {
        "id": meeting_id, "processingStatus": status, "processingError": None, "durationSec": 3600,
        "audioSizeBytes": 1, "processingStartedAt": None, "processingCompletedAt": None,
        "hasTranscript": has_transcript, "hasMinutes": False, "hasSummary": False, "hasRecording": True,
        "analysisStalled": False, "transcriptionStalled": False,
        "transcription": {"mode": "job", "state": "done" if auto else "transcribe", "completed": completed,
                          "total": total, "durationSec": 3600, "waiting": True, "autoAnalyzePending": auto},
    }


def long_status(meeting_id, state="extract", completed=1, total=6, status="analyzing"):
    """Status of a long record analyzed from a verbatim excerpt (text attachment: no recording)."""
    return {
        "id": meeting_id, "processingStatus": status, "processingError": None, "durationSec": None,
        "audioSizeBytes": None, "processingStartedAt": None, "processingCompletedAt": None,
        "hasTranscript": True, "hasMinutes": False, "hasSummary": False, "hasRecording": False,
        "analysisStalled": False, "transcriptionStalled": False, "transcription": None, "playbackReady": False,
        "analysis": {"mode": "long", "state": state, "completed": completed, "total": total, "waiting": True},
        "analysisInput": None,
    }


TEXT_RECORD = {"id": "text-a", "recordingUrl": None, "transcript": "本文", "durationSec": None, "audioSizeBytes": None}


class JobModeMeetingHistory(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        bundle = Path(cls.tmp.name) / "preview.js"
        subprocess.run(["node", "scripts/build-ticket-ui-test.mjs", "tests/fixtures/t04-job-preview.tsx", str(bundle)], cwd=ROOT, check=True)
        cls.bundle = bundle.read_text()
        cls.p = sync_playwright().start()
        cls.browser = cls.p.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.p.stop()
        cls.tmp.cleanup()

    def setUp(self):
        self.page = self.browser.new_page()
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.route("**/*", lambda route: route.abort())
        self.page.set_content('<div id="root"></div>')
        self.page.clock.install()
        self.page.add_script_tag(content=self.bundle)

    def tearDown(self):
        self.page.close()
        self.assertEqual(self.errors, [])

    def show(self, meetings, statuses):
        self.page.evaluate("([m, s]) => jobTest.show(m, s)", [meetings, statuses])

    def count(self, fragment, method=None):
        return self.page.evaluate("([f, m]) => jobTest.count(f, m)", [fragment, method])

    def test_progress_is_shown_and_only_one_continuation_runs_at_a_time(self):
        self.show([
            {"id": "job-a", "meetingDate": "2026-09-24T00:00:00.000Z"},
            {"id": "job-b", "meetingDate": "2026-09-23T00:00:00.000Z", "processingStatus": "uploaded"},
        ], {"job-a": job_status("job-a"), "job-b": job_status("job-b", status="uploaded", completed=0, total=0)})
        expect(self.page.get_by_text("区間 3/6 を文字起こし中（完了 2件）", exact=True)).to_be_visible()
        self.page.wait_for_function("() => jobTest.count('/transcription', 'POST') >= 1")
        for _ in range(4):
            self.page.clock.fast_forward(5000)
            self.page.wait_for_timeout(30)
        self.assertEqual(self.count("/transcription", "POST"), 1, "a pending continuation blocks new ones from this page")
        self.assertGreaterEqual(self.count("/status", "GET"), 4, "status polling continues meanwhile")

    def test_continuations_advance_segments_and_a_forbidden_record_is_not_retried(self):
        self.page.evaluate("jobTest.continueMode = 'progress'")
        self.show([{"id": "job-a"}], {"job-a": job_status("job-a")})
        expect(self.page.get_by_text("区間 4/6 を文字起こし中（完了 3件）", exact=True)).to_be_visible()
        self.page.evaluate("jobTest.continueMode = 'forbidden'")
        for _ in range(3):
            self.page.clock.fast_forward(5000)
            self.page.wait_for_timeout(20)
        posts = self.count("/transcription", "POST")
        for _ in range(3):
            self.page.clock.fast_forward(5000)
            self.page.wait_for_timeout(20)
        self.assertEqual(self.count("/transcription", "POST"), posts, "a viewer (403) does not keep sending continuations")

    def test_auto_analysis_pending_is_driven_but_local_transcribed_records_are_not_polled(self):
        self.show([
            {"id": "job-a", "processingStatus": "transcribed", "transcript": "本文",
             "meta": {"transcriptionJob": {"state": "done", "autoAnalyze": True}}},
            {"id": "job-b", "meetingDate": "2026-09-20T00:00:00.000Z", "processingStatus": "transcribed", "transcript": "本文"},
        ], {"job-a": job_status("job-a", status="transcribed", completed=6, auto=True, has_transcript=True)})
        self.page.wait_for_function("() => jobTest.count('/job-a/transcription', 'POST') >= 1")
        self.page.wait_for_timeout(200)
        self.assertEqual(self.count("/job-a/transcription", "POST"), 1)
        self.assertEqual(self.count("/job-b/"), 0, "a transcribed recording without a pending job sends no requests")

    def test_split_upload_player_waits_for_the_normalized_audio(self):
        parts = "/uploads/recordings/parts/0f0e0d0c-0b0a-4000-8000-000000000001/manifest.json"
        self.show([{"id": "job-a", "recordingUrl": parts, "processingStatus": "uploaded"}],
                  {"job-a": job_status("job-a", status="uploaded", completed=0, total=0)})
        expect(self.page.get_by_text("再生用の音声を準備中です。準備ができると再生できます。", exact=True)).to_be_visible()
        self.assertEqual(self.page.locator("audio").count(), 0)
        self.assertEqual(self.count("/recording"), 0)
        # Once the normalized audio exists it is playable during transcription and after a failure.
        ready = {**job_status("job-a"), "playbackReady": True}
        self.show([{"id": "job-a", "recordingUrl": parts, "meta": {"transcriptionJob": {"state": "transcribe", "playbackFile": "normalized.mp3"}}}], {"job-a": ready})
        expect(self.page.locator("audio")).to_have_count(1)
        failed = {**job_status("job-a", status="error"), "processingError": "区間4/6の文字起こしに失敗しました", "playbackReady": True}
        self.show([{"id": "job-a", "recordingUrl": parts, "processingStatus": "error", "meta": {"transcriptionJob": {"state": "transcribe", "playbackFile": "normalized.mp3"}}}], {"job-a": failed})
        expect(self.page.locator("audio")).to_have_count(1)
        # A failure before the audio was prepared says so instead of "preparing".
        self.show([{"id": "job-a", "recordingUrl": parts, "processingStatus": "error"}], {"job-a": {**job_status("job-a", status="error"), "playbackReady": False}})
        expect(self.page.get_by_text("再生用の音声を作成できませんでした。「文字起こし再実行」で作成し直します。", exact=True)).to_be_visible()

    def test_cross_tenant_refusal_is_retried_after_a_minute_but_forbidden_is_not(self):
        self.page.evaluate("""() => {
            const original = window.fetch;
            window.fetch = async (input, options) => {
                if (String(input).endsWith('/transcription')) {
                    jobTest.requests.push({ url: String(input), method: 'POST' });
                    return Response.json({ error: 'x', code: 'CROSS_TENANT_READ_ONLY' }, { status: 409 });
                }
                return original(input, options);
            };
        }""")
        self.show([{"id": "job-a"}], {"job-a": job_status("job-a")})
        self.page.wait_for_function("() => jobTest.count('/transcription', 'POST') >= 1")
        for _ in range(6):
            self.page.clock.fast_forward(5000)
            self.page.wait_for_timeout(20)
        self.assertEqual(self.count("/transcription", "POST"), 1, "not resent within a minute")
        for _ in range(8):
            self.page.clock.fast_forward(5000)
            self.page.wait_for_timeout(20)
        self.assertGreaterEqual(self.count("/transcription", "POST"), 2, "resent after a minute (e.g. after switching company)")

    def test_long_analysis_of_a_text_record_is_continued_and_the_excerpt_is_noted(self):
        self.page.evaluate("jobTest.continueMode = 'progress'")
        self.show([{**TEXT_RECORD, "processingStatus": "analyzing"}], {"text-a": long_status("text-a", completed=1)})
        expect(self.page.get_by_text("長い記録のため、関係する発言を原文のまま抜粋しています（区間 3/6）", exact=True)).to_be_visible()
        self.assertEqual(self.count("/text-a/transcription", "POST"), 1, "a text record without a recording is continued too")
        self.page.evaluate("jobTest.continueMode = 'deferred'")
        self.show([{**TEXT_RECORD, "processingStatus": "analyzing"}], {"text-a": long_status("text-a", state="pipeline", completed=6)})
        expect(self.page.get_by_text("抜粋した発言から議事録・BANTを生成中", exact=True)).to_be_visible()
        meta = {"analysisInput": {"version": 1, "mode": "condensed", "originalChars": 32000, "condensedChars": 5200, "chunks": 6, "sourceLineIds": [1, 2]}}
        self.show([{**TEXT_RECORD, "processingStatus": "completed", "summary": "要約", "meta": meta}], {})
        expect(self.page.get_by_text("長い記録のため、関係する発言を原文のまま抜粋して分析しました（元 32,000字 → 抜粋 5,200字・6区間）。", exact=True)).to_be_visible()
        expect(self.page.get_by_text("抜粋した発言から議事録・BANTを生成中", exact=True)).to_have_count(0)
        expect(self.page.get_by_text("AIが選んだ発言の一部は抜粋に含められませんでした", exact=False)).to_have_count(0)
        # When selected lines did not fit, the note says so.
        dropped = {"analysisInput": {**meta["analysisInput"], "selection": {"droppedForBudget": 2, "skippedLongLines": 0}}}
        self.show([{**TEXT_RECORD, "processingStatus": "completed", "summary": "要約", "meta": dropped}], {})
        expect(self.page.get_by_text("分量の上限のため、AIが選んだ発言の一部は抜粋に含められませんでした。", exact=False)).to_be_visible()

    def test_analyze_click_on_a_long_record_is_accepted_and_continued(self):
        self.show([{**TEXT_RECORD, "processingStatus": "transcribed"}], {"text-a": long_status("text-a", completed=0)})
        self.assertEqual(self.count("/text-a/"), 0, "nothing is sent before the click")
        self.page.get_by_role("button", name="分析を実行").click()
        expect(self.page.get_by_text("長い記録のため、関係する発言を原文のまま抜粋しています（区間 1/6）", exact=True)).to_be_visible()
        self.page.wait_for_function("() => jobTest.count('/text-a/transcription', 'POST') >= 1")
        self.assertEqual(self.count("/text-a/analyze", "POST"), 1)
        expect(self.page.get_by_role("alert")).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
