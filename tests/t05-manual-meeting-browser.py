"""Actual MeetingHistory component with isolated HTTP responses, no database/network."""
from pathlib import Path
import subprocess
import tempfile
import unittest
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


class MeetingBrowserCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        bundle = Path(cls.tmp.name) / "preview.js"
        subprocess.run([
            "node", "scripts/build-ticket-ui-test.mjs",
            "tests/fixtures/t05-manual-meeting-preview.tsx", str(bundle),
        ], cwd=ROOT, check=True)
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
        self.page.add_script_tag(content=self.bundle)

    def tearDown(self):
        self.page.close()
        self.assertEqual(self.errors, [])


class ManualMeetingCreate(MeetingBrowserCase):
    def setUp(self):
        super().setUp()
        self.page.get_by_role("button", name="新しい商談を記録", exact=True).click()
        self.title = self.page.get_by_label("商談ラベル（任意）", exact=True)
        self.date = self.page.get_by_label("商談日", exact=True)
        self.title.fill("  架空の手入力テスト  ")
        self.date.fill("2026-09-25")

    def add(self):
        self.page.get_by_role("button", name="追加", exact=True).click()

    def assert_draft_retained(self):
        expect(self.title).to_have_value("  架空の手入力テスト  ")
        expect(self.date).to_have_value("2026-09-25")
        expect(self.page.get_by_role("button", name="追加", exact=True)).to_be_enabled()

    def test_http_error_visible_then_retry_creates_atomically(self):
        self.add()
        expect(self.page.get_by_role("alert")).to_contain_text("記録を追加できません（検証用）")
        self.assert_draft_retained()
        self.page.evaluate("manualMeetingTest.mode = 'success'")
        self.add()
        expect(self.page.get_by_label("商談ラベル（任意）", exact=True)).to_have_count(0)
        expect(self.page.get_by_role("alert")).to_have_count(0)
        requests = self.page.evaluate("manualMeetingTest.requests")
        self.assertEqual(len(requests), 2)
        for request in requests:
            self.assertEqual(request["url"], "/api/meetings")
            self.assertEqual(request["method"], "POST")
            self.assertEqual(request["body"], {
                "dealId": "manual-demo-deal", "meetingDate": "2026-09-25T00:00:00.000Z",
                "title": "架空の手入力テスト", "createDraft": True,
            })

    def test_connection_error_visible_and_input_retained(self):
        self.page.evaluate("manualMeetingTest.mode = 'network'")
        self.add()
        expect(self.page.get_by_role("alert")).to_contain_text("通信に失敗しました")
        self.assert_draft_retained()

    def test_non_json_failure_is_visible(self):
        self.page.evaluate("manualMeetingTest.mode = 'malformed'")
        self.add()
        expect(self.page.get_by_role("alert")).to_contain_text("商談記録を追加できませんでした")
        self.assert_draft_retained()

    def test_response_without_meeting_is_not_silent_success(self):
        self.page.evaluate("manualMeetingTest.mode = 'missing'")
        self.add()
        expect(self.page.get_by_role("alert")).to_contain_text("商談記録を追加できませんでした")
        self.assert_draft_retained()

    def test_empty_date_does_not_send_request(self):
        self.date.fill("")
        self.add()
        expect(self.page.get_by_role("alert")).to_contain_text("商談日を入力してください")
        self.assertEqual(self.page.evaluate("manualMeetingTest.requests.length"), 0)

    def test_repeated_clicks_while_pending_do_not_duplicate(self):
        self.page.evaluate("manualMeetingTest.mode = 'deferred'")
        self.page.get_by_role("button", name="追加", exact=True).evaluate("button => { button.click(); button.click(); }")
        expect(self.page.get_by_role("button", name="追加中...", exact=True)).to_be_disabled()
        expect(self.title).to_be_disabled()
        expect(self.date).to_be_disabled()
        expect(self.page.get_by_role("button", name="キャンセル", exact=True)).to_be_disabled()
        self.assertEqual(self.page.evaluate("manualMeetingTest.requests.length"), 1)
        self.page.evaluate("manualMeetingTest.resolve()")
        expect(self.page.get_by_label("商談ラベル（任意）", exact=True)).to_have_count(0)
        self.assertEqual(self.page.evaluate("manualMeetingTest.requests.length"), 1)


class MeetingAnalysisStatus(MeetingBrowserCase):
    # Use the actual component and the same offline browser bundle; every HTTP
    # response below is synthetic, including the provider's 429 error.
    def setUp(self):
        super().setUp()
        self.page.clock.install()
        self.page.evaluate("meetingAnalysisTest.show()")

    def analyze(self):
        self.page.get_by_role("button", name="分析を実行", exact=True).click()

    def assert_retry(self, message):
        expect(self.page.get_by_text("処理状態: エラー", exact=True)).to_be_visible()
        expect(self.page.get_by_role("alert")).to_contain_text(message)
        expect(self.page.get_by_role("button", name="分析を実行", exact=True)).to_be_enabled()
        expect(self.page.get_by_role("button", name="文字起こし再実行", exact=True)).to_have_count(0)
        expect(self.page.get_by_text("処理状態: 分析中", exact=True)).to_have_count(0)

    def test_provider_429_releases_status_and_retries_saved_transcript(self):
        for mode in ["http429", "http500"]:
            with self.subTest(response=mode):
                self.page.evaluate("meetingAnalysisTest.refresh({processingStatus: 'transcribed', processingError: null})")
                self.page.evaluate("meetingAnalysisTest.mode = 'deferred'")
                self.analyze()
                expect(self.page.get_by_text("処理状態: 分析中", exact=True)).to_be_visible()
                self.page.evaluate("mode => { meetingAnalysisTest.mode = mode; meetingAnalysisTest.resolve(); }", mode)
                self.assert_retry("429")
                self.page.evaluate("meetingAnalysisTest.mode = 'deferred'")
                self.analyze()
                expect(self.page.get_by_text("処理状態: 分析中", exact=True)).to_be_visible()
                expect(self.page.get_by_role("alert")).to_have_count(0)
                self.page.evaluate("meetingAnalysisTest.mode = 'success'; meetingAnalysisTest.resolve()")
                expect(self.page.get_by_text("処理状態: 完了", exact=True)).to_be_visible()
                expect(self.page.get_by_role("button", name="分析再実行", exact=True)).to_be_enabled()
        self.page.get_by_role("button", name="録画の文字起こし（生データ）", exact=True).click()
        expect(self.page.get_by_text("保存済みの架空商談本文。予算は80万円です。", exact=True)).to_be_visible()
        requests = self.page.evaluate("meetingAnalysisTest.requests")
        self.assertEqual(len(requests), 4)
        self.assertTrue(all(request["url"] == "/api/meetings/analysis-demo/analyze" and request["method"] == "POST" and request["body"] == {} for request in requests))

    def test_analysis_connection_error_releases_pending_and_can_retry(self):
        self.page.evaluate("meetingAnalysisTest.mode = 'network'")
        self.analyze()
        self.assert_retry("通信に失敗しました")
        self.page.evaluate("meetingAnalysisTest.mode = 'success'")
        self.analyze()
        expect(self.page.get_by_text("処理状態: 完了", exact=True)).to_be_visible()

    def test_analysis_non_json_error_releases_pending(self):
        self.page.evaluate("meetingAnalysisTest.mode = 'malformed'")
        self.analyze()
        self.assert_retry("AI分析に失敗しました")

    def test_refreshed_server_error_replaces_stale_optimistic_status(self):
        self.page.evaluate("meetingAnalysisTest.mode = 'deferred'")
        self.analyze()
        self.page.evaluate("meetingAnalysisTest.refresh({ processingStatus: 'error', processingError: 'サーバーで確定した429エラー' })")
        expect(self.page.get_by_text("処理状態: エラー", exact=True)).to_be_visible()
        self.page.evaluate("meetingAnalysisTest.mode = 'http429'; meetingAnalysisTest.resolve()")
        self.assert_retry("サーバーで確定した429エラー")

    def test_retry_clears_previous_server_error_while_pending(self):
        self.page.evaluate("meetingAnalysisTest.refresh({processingStatus: 'error', processingError: '前回の429エラー'})")
        self.assert_retry("前回の429エラー")
        self.page.evaluate("meetingAnalysisTest.mode = 'deferred'")
        self.analyze()
        expect(self.page.get_by_text("処理状態: 分析中", exact=True)).to_be_visible()
        expect(self.page.get_by_role("alert")).to_have_count(0)
        self.page.evaluate("meetingAnalysisTest.mode = 'success'; meetingAnalysisTest.resolve()")
        expect(self.page.get_by_text("処理状態: 完了", exact=True)).to_be_visible()
        expect(self.page.get_by_role("alert")).to_have_count(0)

    def test_in_flight_response_polls_to_error_and_stops(self):
        self.page.evaluate("meetingAnalysisTest.mode = 'inflight'")
        self.analyze()
        expect(self.page.get_by_text("処理状態: 分析中", exact=True)).to_be_visible()
        self.page.evaluate("meetingAnalysisTest.status = {...meetingAnalysisTest.status, processingStatus:'error', processingError:'ポーリングで確定した429エラー'}")
        self.page.clock.fast_forward(5000)
        self.assert_retry("ポーリングで確定した429エラー")
        request_count = self.page.evaluate("meetingAnalysisTest.requests.length")
        self.page.clock.fast_forward(15000)
        self.assertEqual(self.page.evaluate("meetingAnalysisTest.requests.length"), request_count)

    def test_poll_connection_failure_recovers_to_terminal_status(self):
        for failure in ["network", "http"]:
            with self.subTest(response=failure):
                self.page.evaluate("mode => { meetingAnalysisTest.statusMode = mode; meetingAnalysisTest.refresh({processingStatus:'analyzing', processingError:null}); }", failure)
                expect(self.page.get_by_text("処理状態: 分析中", exact=True)).to_be_visible()
                self.page.evaluate("meetingAnalysisTest.statusMode = 'success'; meetingAnalysisTest.status = {...meetingAnalysisTest.status, processingStatus:'error', processingError:'再接続後の429エラー'}")
                self.page.clock.fast_forward(5000)
                self.assert_retry("再接続後の429エラー")

    def test_repeated_analysis_click_does_not_duplicate_requests(self):
        self.page.evaluate("meetingAnalysisTest.mode = 'deferred'")
        self.page.get_by_role("button", name="分析を実行", exact=True).evaluate("button => { button.click(); button.click(); }")
        self.assertEqual(self.page.evaluate("meetingAnalysisTest.requests.length"), 1)
        self.page.evaluate("meetingAnalysisTest.mode = 'http429'; meetingAnalysisTest.resolve()")
        self.assert_retry("429")


if __name__ == "__main__":
    unittest.main(verbosity=2)
