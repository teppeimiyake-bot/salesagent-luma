"""Actual T01 React component -> actual route -> development Neon demo only.

Start `npm run dev:t01` first. No real Google / AI / Notion API is accessible.
"""
import unittest
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ORIGIN = "http://127.0.0.1:3005"


class T01Browser(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runtime = sync_playwright().start()
        cls.browser = cls.runtime.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.runtime.stop()

    def setUp(self):
        # A non-JST browser catches accidental dependence on the machine timezone.
        self.context = self.browser.new_context(timezone_id="America/Los_Angeles", viewport={"width": 1100, "height": 850})
        self.page = self.context.new_page()
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.deal = self.context.request.get(ORIGIN + "/demo").json()["deal"]
        self.endpoint = ORIGIN + "/api/deals/" + self.deal["id"]
        self.reset()
        self.page.goto(ORIGIN)
        self.start = self.page.get_by_role("textbox", name="商談開始日時", exact=True)
        self.end = self.page.get_by_role("textbox", name="商談終了日時", exact=True)
        expect(self.start).to_have_value("")

    def tearDown(self):
        self.reset()
        self.context.close()
        self.assertEqual(self.errors, [])

    def reset(self):
        response = self.context.request.patch(self.endpoint,
            headers={"Origin": ORIGIN}, data={"meetingStartAt": None, "meetingEndAt": None})
        self.assertEqual(response.status, 200)

    def saved(self):
        return self.context.request.get(ORIGIN + "/demo").json()["deal"]

    def enter(self, field, value):
        field.fill(value)
        field.press("Enter")

    def seed(self):
        self.enter(self.start, "2026-09-21 23:30")
        expect(self.page.get_by_test_id("saved-range")).to_have_text("2026/09/21（月） 23:30–2026/09/22 00:30")
        expect(self.start).to_be_enabled()

    def test_register_reload_and_jst_date_sync(self):
        self.seed()
        expect(self.end).to_have_value("2026-09-22 00:30")
        self.assertEqual(self.saved()["meetingStartAt"], "2026-09-21T14:30:00.000Z")
        self.assertEqual(self.saved()["meetingScheduledAt"], "2026-09-20T15:00:00.000Z")
        self.page.reload()
        expect(self.start).to_have_value("2026-09-21 23:30")
        expect(self.end).to_have_value("2026-09-22 00:30")
        expect(self.page.get_by_test_id("scheduled-date")).to_have_text("2026-09-21")

    def test_reschedule_and_auto_end(self):
        self.seed()
        self.enter(self.start, "2026/9/24 10:00")
        expect(self.page.get_by_test_id("saved-range")).to_have_text("2026/09/24（木） 10:00–11:00")
        expect(self.page.get_by_test_id("scheduled-date")).to_have_text("2026-09-24")
        self.enter(self.end, "20260924 1130")
        expect(self.page.get_by_test_id("saved-range")).to_have_text("2026/09/24（木） 10:00–11:30")

    def test_invalid_range_keeps_db_and_draft(self):
        self.seed()
        before = self.saved()
        self.enter(self.end, "2026-09-20 09:00")
        expect(self.page.get_by_role("alert")).to_contain_text("終了日時は開始日時以降")
        expect(self.end).to_have_value("2026-09-20 09:00")
        self.assertEqual(self.saved(), before)
        self.enter(self.end, "2026-09-22 01:00")
        expect(self.page.get_by_test_id("saved-range")).to_contain_text("01:00")
        expect(self.page.get_by_role("alert")).to_have_count(0)

    def test_clear_persists(self):
        self.seed()
        self.page.get_by_role("button", name="クリア", exact=True).click()
        expect(self.page.get_by_test_id("saved-range")).to_have_text("未設定")
        self.page.reload()
        expect(self.start).to_have_value("")
        expect(self.end).to_have_value("")
        self.assertIsNone(self.saved()["meetingScheduledAt"])

    def test_http_failure_then_retry(self):
        self.page.route(self.endpoint, lambda route: route.fulfill(status=500,
            content_type="application/json", body='{"message":"テスト用の保存失敗"}'), times=1)
        self.enter(self.start, "2026-09-24 10:00")
        expect(self.page.get_by_role("alert")).to_contain_text("テスト用の保存失敗")
        expect(self.start).to_have_value("2026-09-24 10:00")
        self.assertIsNone(self.saved()["meetingStartAt"])
        self.page.get_by_role("button", name="再試行").click()
        expect(self.page.get_by_test_id("saved-range")).to_have_text("2026/09/24（木） 10:00–11:00")

    def test_network_failure_then_retry(self):
        self.page.route(self.endpoint, lambda route: route.abort("failed"), times=1)
        self.enter(self.start, "2026-09-24 10:00")
        expect(self.page.get_by_role("alert")).to_contain_text("通信に失敗")
        expect(self.start).to_have_value("2026-09-24 10:00")
        self.assertIsNone(self.saved()["meetingStartAt"])
        self.page.get_by_role("button", name="再試行").click()
        expect(self.page.get_by_test_id("saved-range")).to_have_text("2026/09/24（木） 10:00–11:00")

    def test_invalid_calendar_input_and_end_without_start(self):
        self.enter(self.start, "2026-02-30 10:00")
        expect(self.start).to_have_value("")
        self.assertIsNone(self.saved()["meetingStartAt"])
        self.enter(self.end, "2026-09-24 10:00")
        expect(self.page.get_by_role("alert")).to_contain_text("開始日時を先に")
        self.assertIsNone(self.saved()["meetingEndAt"])

    def test_server_is_limited_to_t01_demo(self):
        response = self.context.request.patch(self.endpoint, headers={"Origin": "https://example.invalid"}, data={"meetingStartAt": None})
        self.assertEqual(response.status, 403)
        response = self.context.request.patch(self.endpoint, headers={"Origin": ORIGIN}, data={"title": "not allowed"})
        self.assertEqual(response.status, 400)
        self.assertEqual(self.context.request.get(ORIGIN + "/api/deals/other").status, 404)
        self.assertEqual(self.context.request.post(self.endpoint + "/meet").status, 404)

    def test_z_visual_and_mobile_layout(self):
        self.seed()
        self.page.screenshot(path=str(Path(".verification/t01/desktop.png")), full_page=True)
        self.page.set_viewport_size({"width": 390, "height": 844})
        self.assertTrue(self.page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"))
        self.page.screenshot(path=str(Path(".verification/t01/mobile.png")), full_page=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
