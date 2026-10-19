"""Actual DealStatusBar/MeetingDateTimeEditor; all API and clipboard calls mocked."""
from pathlib import Path
import subprocess
import tempfile
import unittest
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
URL = "https://meet.google.com/abc-defg-hij"
NEW_URL = "https://meet.google.com/xyz-abcd-efg"


class T02Browser(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="luma-t02-offline-")
        output = Path(cls.temp.name) / "preview.js"
        subprocess.run(["node", "scripts/build-t02-ui-test.mjs", str(output)], cwd=ROOT, check=True)
        cls.bundle = output.read_text()
        cls.runtime = sync_playwright().start()
        cls.browser = cls.runtime.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.runtime.stop(); cls.temp.cleanup()

    def setUp(self):
        self.context = self.browser.new_context(service_workers="block")
        self.network = []; self.errors = []
        self.context.on("request", lambda r: self.network.append(r.url))
        self.context.route("**/*", lambda r: r.abort())
        self.page = self.context.new_page()
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))
        self.page.set_default_timeout(6000)
        self.page.set_content('''<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'"><div id="root"></div>''')
        self.page.add_script_tag(content=self.bundle)
        expect(self.page.get_by_role("button", name="Meet発行", exact=True)).to_be_visible()

    def tearDown(self):
        snapshot = self.snapshot()
        self.context.close()
        self.assertEqual(snapshot["unexpected"], [])
        self.assertEqual(snapshot["queued"], 0)
        self.assertEqual(self.network, [])
        self.assertEqual(self.errors, [])

    def snapshot(self):
        return self.page.evaluate("window.meetTest.snapshot()")

    def configure(self, **props):
        self.page.evaluate("p => window.meetTest.configure(p)", props)

    def queue(self, method="POST", **response):
        self.page.evaluate("r => window.meetTest.queue(r)", {"method": method, **response})

    def ready(self, url=URL, event="event1"):
        self.queue(body={"deal": {"meetUrl": url, "meetEventId": event}})

    def test_auto_issue_after_datetime_save_and_copy(self):
        self.configure(deal={"meetingStartAt": None, "meetingEndAt": None})
        self.queue(method="PATCH")
        self.ready()
        field = self.page.get_by_role("textbox", name="商談開始日時", exact=True)
        field.fill("2026-09-24 10:00"); field.press("Enter")
        expect(self.page.get_by_role("link", name="Meet", exact=True)).to_have_attribute("href", URL)
        self.assertEqual([r["method"] for r in self.snapshot()["requests"]], ["PATCH", "POST"])
        self.page.get_by_role("button", name="Meet URLをコピー", exact=True).click()
        expect(self.page.get_by_role("status")).to_contain_text("コピーしました")
        self.assertEqual(self.snapshot()["copied"], URL)

    def test_pending_poll_then_success_without_reissue(self):
        self.queue(status=202, body={"status": "pending", "deal": {"meetUrl": None, "meetEventId": "event1"}})
        self.ready()
        self.page.get_by_role("button", name="Meet発行", exact=True).click()
        expect(self.page.get_by_role("status")).to_contain_text("発行中")
        expect(self.page.get_by_role("link", name="Meet", exact=True)).to_have_count(0)
        expect(self.page.get_by_role("link", name="Meet", exact=True)).to_have_attribute("href", URL)
        self.assertEqual(len(self.snapshot()["requests"]), 2)
        self.assertTrue(all(not r["body"]["forceRecreate"] for r in self.snapshot()["requests"]))

    def test_pending_checks_are_bounded_then_manual_retry(self):
        for _ in range(4):
            self.queue(status=202, body={"status": "pending", "deal": {"meetUrl": None, "meetEventId": "event1"}})
        self.page.get_by_role("button", name="Meet発行", exact=True).click()
        button = self.page.get_by_role("button", name="発行状況を確認", exact=True)
        expect(button).to_be_enabled()
        self.assertEqual(len(self.snapshot()["requests"]), 4)
        self.ready(); button.click()
        expect(self.page.get_by_role("link", name="Meet", exact=True)).to_have_attribute("href", URL)

    def test_network_failure_is_visible_and_retryable(self):
        self.queue(error="network failed")
        self.page.get_by_role("button", name="Meet発行", exact=True).click()
        expect(self.page.get_by_role("alert")).to_contain_text("通信に失敗")
        self.ready()
        self.page.get_by_role("button", name="Meet連携を再試行", exact=True).click()
        expect(self.page.get_by_role("link", name="Meet", exact=True)).to_have_attribute("href", URL)

    def test_config_failure_preserves_saved_times(self):
        self.queue(status=503, body={"message": "Meet連携が未設定です。商談日時は保存されています。"})
        self.page.get_by_role("button", name="Meet発行", exact=True).click()
        expect(self.page.get_by_role("alert")).to_contain_text("未設定")
        expect(self.page.get_by_role("textbox", name="商談開始日時", exact=True)).to_have_value("2026-09-24 10:00")
        expect(self.page.get_by_role("button", name="Meet連携を再試行", exact=True)).to_be_enabled()

    def test_reissue_sends_expected_event_id_and_displays_new_url(self):
        self.configure(deal={"meetUrl": URL, "meetEventId": "event1"})
        self.ready(NEW_URL, "event2")
        self.page.get_by_role("button", name="再発行", exact=True).click()
        expect(self.page.get_by_role("link", name="Meet", exact=True)).to_have_attribute("href", NEW_URL)
        self.assertEqual(self.snapshot()["requests"][0]["body"], {"forceRecreate": True, "expectedEventId": "event1"})

    def test_copy_failure_is_visible(self):
        self.configure(deal={"meetUrl": URL, "meetEventId": "event1"})
        self.page.evaluate("window.meetTest.clipboardFail = true")
        self.page.get_by_role("button", name="Meet URLをコピー", exact=True).click()
        expect(self.page.get_by_role("alert")).to_contain_text("コピーできません")

    def test_feature_off_hides_datetime_and_meet_ui(self):
        self.configure(showMeetingDateTime=False)
        expect(self.page.get_by_role("textbox", name="商談開始日時", exact=True)).to_have_count(0)
        expect(self.page.get_by_role("button", name="Meet発行", exact=True)).to_have_count(0)
        self.assertEqual(self.snapshot()["requests"], [])

    def test_viewer_can_open_link_but_cannot_issue(self):
        self.configure(canEdit=False, deal={"meetUrl": URL, "meetEventId": "event1"})
        expect(self.page.get_by_role("link", name="Meet", exact=True)).to_have_attribute("href", URL)
        expect(self.page.get_by_role("button", name="再発行", exact=True)).to_have_count(0)
        expect(self.page.get_by_role("textbox", name="商談開始日時", exact=True)).to_have_count(0)

    def test_non_owner_datetime_save_does_not_issue_meet(self):
        self.configure(allowMeetIssuance=False, deal={"meetingStartAt": None, "meetingEndAt": None})
        expect(self.page.get_by_role("button", name="Meet発行", exact=True)).to_have_count(0)
        self.queue(method="PATCH")
        field = self.page.get_by_role("textbox", name="商談開始日時", exact=True)
        field.fill("2026-09-24 10:00"); field.press("Enter")
        expect(self.page.get_by_role("status")).to_contain_text("保存")
        self.assertEqual([r["method"] for r in self.snapshot()["requests"]], ["PATCH"])

    def test_non_owner_hides_reissue_and_sync(self):
        self.configure(allowMeetIssuance=False, deal={"meetUrl": URL, "meetEventId": "event1"})
        expect(self.page.get_by_role("button", name="再発行", exact=True)).to_have_count(0)
        expect(self.page.get_by_role("button", name="同期", exact=True)).to_have_count(0)
        self.assertEqual(self.snapshot()["requests"], [])

    def test_equal_times_do_not_issue(self):
        self.configure(deal={"meetingEndAt": "2026-09-24T01:00:00Z"})
        expect(self.page.get_by_role("button", name="Meet発行", exact=True)).to_be_disabled()
        self.assertEqual(self.snapshot()["requests"], [])

    def test_server_refresh_replaces_the_displayed_link(self):
        self.configure(deal={"meetUrl": URL, "meetEventId": "event1"})
        self.page.evaluate("window.meetTest.updateServer({meetUrl:'https://meet.google.com/xyz-abcd-efg',meetEventId:'event2'})")
        expect(self.page.get_by_role("link", name="Meet", exact=True)).to_have_attribute("href", NEW_URL)


if __name__ == "__main__":
    unittest.main(verbosity=2)
