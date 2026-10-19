"""Tab scroll regression on the local development app; no browser writes or AI calls."""
import json
import os
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright


BASE = os.environ.get("T24_SCROLL_BASE_URL", "http://127.0.0.1:3003")
DEAL = "/deals/0d010000-0000-4000-8000-000000000001"
SCROLLER = "div.flex-1.overflow-y-auto.bg-zinc-50"
RUN = os.environ.get("T24_SCROLL_RUN", "fixed")
ARTIFACTS = Path(__file__).resolve().parents[1] / ".verification"
TABS = (("overview", "概要"), ("prepare", "準備・BANT"),
        ("record", "商談記録"), ("quote", "見積・契約"))


class TabSwitchScroll(unittest.TestCase):
    def exercise(self, width, height, size):
        observations, errors, blocked = [], [], []
        ARTIFACTS.mkdir(exist_ok=True)
        with sync_playwright() as runtime:
            browser = runtime.chromium.launch()
            context = browser.new_context(viewport={"width": width, "height": height},
                                          extra_http_headers=json.loads(os.environ.get("T24_SCROLL_EXTRA_HEADERS", "{}")))

            def read_only(route):
                request = route.request
                if request.url.startswith(BASE + "/") and request.method in ("GET", "HEAD", "OPTIONS"):
                    route.continue_()
                else:
                    blocked.append({"method": request.method, "url": request.url})
                    route.abort()

            context.route("**/*", read_only)
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            try:
                # The reviewed development fixture login is the only mutation.
                login = context.request.post(BASE + "/api/auth/login", data={
                    "email": "admin@dev.test", "password": "dev1234"}, max_redirects=0)
                self.assertEqual(login.status, 200)
                response = page.goto(BASE + DEAL + "?from=yomi%3DA&tab=quote#scroll-regression",
                                     wait_until="networkidle", timeout=60000)
                self.assertEqual(response.status, 200)
                scroller = page.locator(SCROLLER)
                nav = page.get_by_role("navigation", name="商談詳細の内容タブ")
                expect(page.locator('[data-deal-tab="quote"]')).to_be_visible()
                initial_history = page.evaluate("history.length")

                def check_url(tab):
                    parsed = urlparse(page.url)
                    query = parse_qs(parsed.query)
                    self.assertEqual(query.get("from"), ["yomi=A"])
                    self.assertEqual(query.get("tab"), None if tab == "overview" else [tab])
                    self.assertEqual(parsed.fragment, "scroll-regression")
                    self.assertEqual(page.evaluate("history.length"), initial_history)

                def bottom():
                    state = scroller.evaluate("""el => {
                      el.scrollTo({top: el.scrollHeight, behavior: 'instant'});
                      return {top: el.scrollTop, max: el.scrollHeight - el.clientHeight};
                    }""")
                    self.assertGreater(state["top"], 100, "Fixture must really start away from the top")
                    self.assertAlmostEqual(state["top"], state["max"], delta=1)
                    # Let the browser commit this synthetic scroll before another
                    # scroll command; two commands in one animation frame coalesce.
                    page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
                    return state["top"]

                def switch_at_bottom(tab, label):
                    before = bottom()
                    nav.get_by_role("button", name=label, exact=False).click()
                    expect(page.locator(f'[data-deal-tab="{tab}"]')).to_be_visible()
                    page.wait_for_timeout(100)
                    after = scroller.evaluate("el => el.scrollTop")
                    observations.append({"case": f"bottom-to-{tab}", "before": before, "after": after})
                    self.assertLessEqual(after, 1, f"{size}: switching to {tab} must open at the top")
                    check_url(tab)

                # This is the reported case: a long quote page must not carry its position to overview.
                switch_at_bottom("overview", "概要")
                for tab, label in TABS[1:]:
                    switch_at_bottom(tab, label)
                switch_at_bottom("quote", "見積・契約")  # Same-tab click is an explicit return to top.

                # Opening and typing a new quote is local React state; never press Save.
                page.locator("#section-quote").get_by_role("button", name="新規作成", exact=True).click()
                subject = page.get_by_placeholder("例: 採用動画制作一式", exact=True)
                subject.fill("架空・スクロール確認用の未保存見積")
                switch_at_bottom("overview", "概要")
                switch_at_bottom("quote", "見積・契約")
                expect(subject).to_have_value("架空・スクロール確認用の未保存見積")
                observations.append({"case": "unsaved-quote-preserved", "ok": True})

                def reveal_first_tab(case):
                    # The tab bar scrolls horizontally on narrow screens. Use a DOM click:
                    # Playwright's click would scroll the button into view by itself.
                    state = page.evaluate("""() => {
                      const nav = document.querySelector('nav[aria-label="商談詳細の内容タブ"]');
                      nav.scrollLeft = nav.scrollWidth;
                      const before = nav.scrollLeft;
                      [...nav.querySelectorAll('button')].find(el => el.textContent.trim().startsWith('概要')).click();
                      return {before, max: nav.scrollWidth - nav.clientWidth};
                    }""")
                    self.assertGreater(state["max"], 1, "Fixture tab bar must really overflow at this width")
                    self.assertAlmostEqual(state["before"], state["max"], delta=1)
                    expect(page.locator('[data-deal-tab="overview"]')).to_be_visible()
                    page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
                    after = nav.evaluate("""nav => {
                      const button = nav.querySelector('button[aria-current="page"]');
                      const area = nav.getBoundingClientRect();
                      const rect = button.getBoundingClientRect();
                      return {left: nav.scrollLeft, label: button.textContent.trim(),
                              buttonLeft: rect.left, buttonRight: rect.right,
                              navLeft: area.left, navRight: area.right};
                    }""")
                    observations.append({"case": case, "before": state["before"], **after})
                    self.assertTrue(after["label"].startswith("概要"))
                    self.assertLessEqual(after["left"], 1, f"{size}: the tab bar must return to its first tab")
                    self.assertGreaterEqual(after["buttonLeft"], after["navLeft"] - 1, "概要 must not be hidden on the left")
                    self.assertLessEqual(after["buttonRight"], after["navRight"] + 1, "概要 must fit inside the tab bar")
                    check_url("overview")

                if size == "mobile":
                    reveal_first_tab("tab-bar-reveals-overview-after-switch")  # From 見積・契約.
                    reveal_first_tab("tab-bar-reveals-overview-same-tab")  # Re-selecting 概要.

                def section_navigation(case):
                    page.evaluate("window.dispatchEvent(new CustomEvent('luma:deal-navigate', {detail: {sectionId: 'section-upload'}}))")
                    expect(page.locator('[data-deal-tab="record"]')).to_be_visible()
                    page.wait_for_function("""() => {
                      const container = document.querySelector('div.flex-1.overflow-y-auto.bg-zinc-50');
                      const target = document.getElementById('section-upload');
                      const area = container.getBoundingClientRect();
                      const rect = target.getBoundingClientRect();
                      const margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
                      return container.scrollTop > 10 && Math.abs(rect.top - area.top - margin) <= 2;
                    }""", timeout=10000)
                    page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
                    observations.append({"case": case, "top": scroller.evaluate("el => el.scrollTop")})
                    check_url("record")

                bottom()
                section_navigation("explicit-target-in-hidden-panel")
                bottom()
                section_navigation("explicit-target-in-same-panel")

                # A normal tab click must win over a just-started explicit smooth scroll.
                page.evaluate("""() => {
                  window.dispatchEvent(new CustomEvent('luma:deal-navigate', {detail: {sectionId: 'section-history'}}));
                  const nav = document.querySelector('nav[aria-label="商談詳細の内容タブ"]');
                  [...nav.querySelectorAll('button')].find(el => el.textContent.trim().startsWith('概要')).click();
                }""")
                expect(page.locator('[data-deal-tab="overview"]')).to_be_visible()
                page.wait_for_timeout(600)
                self.assertLessEqual(scroller.evaluate("el => el.scrollTop"), 1,
                                     "An older section scroll must not override the latest tab click")
                observations.append({"case": "latest-tab-click-wins", "ok": True})
                check_url("overview")

                # Native history navigation retains the existing URL/panel behavior.
                page.evaluate("history.pushState(null, '', '?from=yomi%3DA&tab=record#scroll-regression')")
                expect(page.locator('[data-deal-tab="record"]')).to_be_visible()
                page.go_back(wait_until="domcontentloaded")
                expect(page.locator('[data-deal-tab="overview"]')).to_be_visible()
                self.assertEqual(parse_qs(urlparse(page.url).query).get("from"), ["yomi=A"])
                observations.append({"case": "browser-back-panel-and-query", "ok": True})
                self.assertEqual(blocked, [], "No API writes, AI calls, or external browser requests allowed")
                self.assertEqual(errors, [])
                page.screenshot(path=str(ARTIFACTS / f"t24-tab-switch-{RUN}-{size}.png"))
            except Exception:
                page.screenshot(path=str(ARTIFACTS / f"t24-tab-switch-{RUN}-{size}-failure.png"))
                raise
            finally:
                report = {"size": size, "observations": observations, "blockedRequests": blocked, "pageErrors": errors}
                print(json.dumps(report, ensure_ascii=False), flush=True)
                (ARTIFACTS / f"t24-tab-switch-{RUN}-{size}.json").write_text(
                    json.dumps(report, ensure_ascii=False, indent=2) + "\n")
                context.close()
                browser.close()

    def test_desktop(self):
        self.exercise(1440, 1000, "desktop")

    def test_mobile(self):
        self.exercise(390, 844, "mobile")


if __name__ == "__main__":
    unittest.main(verbosity=2)
