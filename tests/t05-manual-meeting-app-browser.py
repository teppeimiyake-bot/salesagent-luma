"""Run via scripts/t05-manual-meeting-fixture.mjs; uses an owned temporary deal."""
import os
import re
import unittest
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

BASE = "http://127.0.0.1:3003"
DEAL_ID = os.environ.get("T05_FIXTURE_DEAL", "")
if not re.fullmatch(r"[0-9a-f-]{36}", DEAL_ID) or DEAL_ID == "0d010000-0000-4000-8000-000000000001":
    raise RuntimeError("Use fixture wrapper; original user demo must not be modified")


class ManualMeetingApp(unittest.TestCase):
    def test_create_then_edit_minutes_on_real_app(self):
        with sync_playwright() as runtime:
            browser = runtime.chromium.launch()
            context = browser.new_context(viewport={"width": 1440, "height": 1000}, timezone_id="Asia/Tokyo")
            context.route("**/*", lambda route: route.continue_()
                          if route.request.url.startswith(BASE + "/") else route.abort())
            page = context.new_page()
            errors, meeting_writes = [], []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("request", lambda request: meeting_writes.append(request)
                    if request.url.startswith(BASE + "/api/meetings")
                    and request.method in ("POST", "PATCH") else None)
            try:
                login = context.request.post(BASE + "/api/auth/login", data={
                    "email": "admin@dev.test", "password": "dev1234"})
                self.assertEqual(login.status, 200)
                response = page.goto(BASE + "/deals/" + DEAL_ID + "?tab=record",
                                     wait_until="networkidle", timeout=60000)
                self.assertEqual(response.status, 200)
                page.get_by_role("button", name="新しい商談を記録", exact=True).click()
                page.get_by_label("商談ラベル（任意）", exact=True).fill("T05追加・保存確認")
                page.get_by_label("商談日", exact=True).fill("2026-09-25")
                with page.expect_response(lambda response: response.url == BASE + "/api/meetings"
                                          and response.request.method == "POST", timeout=60000) as created:
                    page.get_by_role("button", name="追加", exact=True).click()
                self.assertEqual(created.value.status, 200)
                meeting = created.value.json()["meeting"]
                meeting_id = meeting["id"]
                self.assertEqual(meeting["title"], "T05追加・保存確認")
                self.assertEqual(meeting["meetingDate"], "2026-09-25T00:00:00.000Z")
                card = page.locator("#meeting-" + meeting_id)
                expect(card).to_be_visible()
                expect(card.get_by_text("商談要約（議事録）", exact=False)).to_be_visible()
                self.assertEqual(len(meeting_writes), 1, "Creation must be a single atomic POST")
                self.assertEqual(meeting_writes[0].method, "POST")
                self.assertEqual(meeting_writes[0].post_data_json, {
                    "dealId": DEAL_ID, "meetingDate": "2026-09-25T00:00:00.000Z",
                    "title": "T05追加・保存確認", "createDraft": True})
                page.reload(wait_until="networkidle", timeout=60000)
                expect(card.get_by_text("T05追加・保存確認", exact=True)).to_be_visible()
                expect(card).to_contain_text("2026/09/25")
                for amount in ("100", "80"):
                    card.get_by_role("button", name="編集", exact=True).click()
                    editor = card.get_by_role("textbox", name="議事録", exact=True)
                    minutes = f"予算は{amount}万円。\n課題は新卒採用への応募数不足。\n決裁者は未確認。導入時期は未定。"
                    editor.fill(minutes)
                    with page.expect_response(lambda response: response.url == BASE + "/api/meetings/" + meeting_id
                                              and response.request.method == "PATCH", timeout=60000) as saved:
                        card.get_by_role("button", name="保存", exact=True).click()
                    self.assertEqual(saved.value.status, 200)
                    expect(editor).not_to_be_visible()
                    page.reload(wait_until="networkidle", timeout=60000)
                    expect(card).to_contain_text(f"予算は{amount}万円。")
                self.assertEqual(sum(request.method == "POST" for request in meeting_writes), 1)
                self.assertEqual(sum(request.method == "PATCH" for request in meeting_writes), 2)
                self.assertEqual(errors, [])
                page.screenshot(path=str(Path(__file__).resolve().parents[1] / ".verification/t05-manual-meeting.png"))
            finally:
                context.close()
                browser.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
