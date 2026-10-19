"""Actual styled local app; run only via the isolated development fixture wrapper."""
import json
import os
import re
import unittest
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

BASE = "http://127.0.0.1:3003"
DEAL_ID = os.environ.get("T07_FIXTURE_DEAL", "")
FIELDS = json.loads(os.environ.get("T07_BANT_FIELDS", "{}"))
BASELINE = os.environ.get("T07_BASELINE") == "1"
KEYS = ("budget", "authority", "need", "timeline", "summary")
CARDS = (("budget", "Budget 予算", "予算"), ("authority", "Authority 決裁者", "決裁者"),
         ("need", "Need 課題", "課題"), ("timeline", "Timeline 時期", "時期"))
if not re.fullmatch(r"[0-9a-f-]{36}", DEAL_ID) or DEAL_ID == "0d010000-0000-4000-8000-000000000001":
    raise RuntimeError("Use fixture wrapper; original user demo must not be modified")
if set(FIELDS) != set(KEYS):
    raise RuntimeError("Complete isolated BANT text fixture required")


class BantLayoutApp(unittest.TestCase):
    def test_multiline_manual_bant_roundtrip_and_layout(self):
        with sync_playwright() as runtime:
            browser = runtime.chromium.launch()
            context = browser.new_context(viewport={"width": 1440, "height": 1000}, timezone_id="Asia/Tokyo")
            context.route("**/*", lambda route: route.continue_()
                          if route.request.url.startswith(BASE + "/") else route.abort())
            page = context.new_page()
            errors, writes = [], []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("request", lambda request: writes.append(request)
                    if "/api/" in request.url and request.method in ("POST", "PATCH", "DELETE") else None)
            try:
                login = context.request.post(BASE + "/api/auth/login", data={
                    "email": "admin@dev.test", "password": "dev1234"})
                self.assertEqual(login.status, 200)
                response = page.goto(BASE + "/deals/" + DEAL_ID + "?tab=prepare",
                                     wait_until="networkidle", timeout=60000)
                self.assertEqual(response.status, 200)
                bant = page.locator("#section-bant")
                bant.get_by_role("button", name="手動編集", exact=True).click()
                editors = bant.locator("textarea")
                expect(editors).to_have_count(5)
                for index, key in enumerate(KEYS):
                    editors.nth(index).fill(FIELDS[key])
                with page.expect_response(lambda response: response.url == BASE + "/api/deals/" + DEAL_ID
                                          and response.request.method == "PATCH", timeout=60000) as saved:
                    bant.get_by_role("button", name="BANTを保存", exact=True).click()
                self.assertEqual(saved.value.status, 200)
                for key in KEYS:
                    self.assertEqual(saved.value.json()["deal"]["bant"][key], FIELDS[key])
                page.reload(wait_until="networkidle", timeout=60000)
                bant.get_by_role("button", name="手動編集", exact=True).click()
                for index, key in enumerate(KEYS):
                    expect(editors.nth(index)).to_have_value(FIELDS[key])
                bant.get_by_role("button", name="キャンセル", exact=True).click()
                print("PASS: all five fields preserve exact Japanese text, newlines and blank lines after save/reload", flush=True)
                for width, height, label in ((1440, 1000, "desktop"), (390, 844, "mobile")):
                    page.set_viewport_size({"width": width, "height": height})
                    bant.scroll_into_view_if_needed()
                    # Preserve every stored character while allowing paragraphs to become separate DOM nodes.
                    rendered = bant.inner_text()
                    for key in KEYS:
                        for paragraph in FIELDS[key].split("\n"):
                            self.assertIn(paragraph, rendered)
                    geometry = bant.evaluate("""el => ({width: el.clientWidth, scrollWidth: el.scrollWidth,
                      right: el.getBoundingClientRect().right, viewport: innerWidth,
                      documentWidth: document.documentElement.scrollWidth,
                      whitespace: [...el.querySelectorAll('p')].filter(p => p.textContent.includes('\\n'))
                        .map(p => getComputedStyle(p).whiteSpace)})""")
                    print(f"{label} layout: {json.dumps(geometry, ensure_ascii=False)}", flush=True)
                    if not BASELINE:
                        self.assertLessEqual(geometry["scrollWidth"], geometry["width"] + 1)
                        self.assertLessEqual(geometry["right"], width + 1)
                        self.assertLessEqual(geometry["documentWidth"], width)
                        summary = bant.locator("[data-bant-summary]")
                        self.assertEqual(summary.text_content(), FIELDS["summary"])
                        self.assertEqual(summary.evaluate("el => getComputedStyle(el).whiteSpace"), "pre-wrap")
                        for key, title, field_label in CARDS:
                            card = bant.get_by_role("region", name=title, exact=True)
                            text = card.locator("[data-bant-text]")
                            self.assertEqual(text.text_content(), FIELDS[key])
                            self.assertEqual(text.evaluate("el => getComputedStyle(el).whiteSpace"), "pre-wrap")
                            expand = card.get_by_role("button", name=field_label + "の全文を表示", exact=True)
                            expect(expand).to_be_visible()
                            expect(expand).to_have_attribute("aria-expanded", "false")
                            measurements = text.evaluate("el => ({height: el.clientHeight, full: el.scrollHeight, line: parseFloat(getComputedStyle(el).lineHeight)})")
                            self.assertLessEqual(measurements["height"], measurements["line"] * 6 + 1)
                            self.assertGreater(measurements["full"], measurements["height"])
                            expand.click()
                            collapse = card.get_by_role("button", name=field_label + "を折りたたむ", exact=True)
                            expect(collapse).to_have_attribute("aria-expanded", "true")
                            expanded = text.evaluate("el => ({height: el.clientHeight, full: el.scrollHeight, width: el.clientWidth, scrollWidth: el.scrollWidth})")
                            self.assertGreaterEqual(expanded["height"], expanded["full"] - 1)
                            self.assertLessEqual(expanded["scrollWidth"], expanded["width"] + 1)
                            self.assertEqual(text.text_content(), FIELDS[key])
                            if key == "need":
                                card.screenshot(path=str(Path(__file__).resolve().parents[1] /
                                                         f".verification/t07-bant-expanded-{label}.png"))
                            collapse.click()
                            expect(card.get_by_role("button", name=field_label + "の全文を表示", exact=True)).to_have_attribute("aria-expanded", "false")
                        print(f"PASS: {label} all four long cards expand/collapse at six lines, full original text accessible", flush=True)
                    bant.scroll_into_view_if_needed()
                    page.screenshot(path=str(Path(__file__).resolve().parents[1] /
                                             f".verification/t07-bant-{'baseline-' if BASELINE else ''}{label}.png"))
                if not BASELINE:
                    expect(bant.get_by_text("未判定", exact=True)).to_have_count(4)
                    bant.get_by_role("button", name="手動編集", exact=True).click()
                    editors.nth(3).fill("未定")
                    with page.expect_response(lambda response: response.url == BASE + "/api/deals/" + DEAL_ID
                                              and response.request.method == "PATCH", timeout=60000) as saved_unknown:
                        bant.get_by_role("button", name="BANTを保存", exact=True).click()
                    self.assertEqual(saved_unknown.value.status, 200)
                    page.reload(wait_until="networkidle", timeout=60000)
                    expect(bant.get_by_text("未判定", exact=True)).to_have_count(3)
                    expect(bant.get_by_text("未確定", exact=True)).to_have_count(1)
                    timeline = bant.get_by_role("region", name="Timeline 時期", exact=True)
                    expect(timeline.locator("[data-bant-text]")).to_have_text("未定")
                    expect(timeline.get_by_role("button", name="時期の全文を表示", exact=True)).to_have_count(0)
                self.assertEqual(errors, [])
                self.assertTrue(all(request.method == "PATCH" and request.url == BASE + "/api/deals/" + DEAL_ID
                                    for request in writes), "Only own-deal manual save is allowed; no AI call")
                self.assertEqual(len(writes), 1 if BASELINE else 2)
            finally:
                context.close()
                browser.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
