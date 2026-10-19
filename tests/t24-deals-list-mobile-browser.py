"""Read-only mobile/list navigation regression for the local development app.

Only the isolated demo-account login below sends a POST. All browser requests
are restricted to this localhost app and GET/HEAD/OPTIONS; no data is saved.
"""
import json
import os
import unittest
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


BASE = "http://127.0.0.1:3003"
DEAL = "/deals/0d010000-0000-4000-8000-000000000001"
OUTPUT = Path(__file__).resolve().parents[1] / ".verification"
WIDTHS = (390, 600, 700, 900, 1440)
READ_METHODS = ("GET", "HEAD", "OPTIONS")


class DealsListMobile(unittest.TestCase):
    def assert_within_viewport(self, page, locator, name, min_width=1):
        expect(locator).to_be_visible()
        bounds = locator.bounding_box()
        self.assertIsNotNone(bounds, name)
        viewport = page.viewport_size
        self.assertGreaterEqual(bounds["width"], min_width, f"{name}: {bounds}")
        self.assertGreaterEqual(bounds["x"], -1, f"{name}: clipped on the left {bounds}")
        self.assertLessEqual(bounds["x"] + bounds["width"], viewport["width"] + 1,
                             f"{name}: clipped on the right {bounds}")
        self.assertGreaterEqual(bounds["y"], -1, f"{name}: above viewport {bounds}")
        self.assertLessEqual(bounds["y"] + bounds["height"], viewport["height"] + 1,
                             f"{name}: below viewport {bounds}")

    def assert_no_page_overflow(self, page):
        dimensions = page.evaluate("""() => ({
          viewport: innerWidth,
          document: document.documentElement.scrollWidth,
          body: document.body.scrollWidth
        })""")
        self.assertLessEqual(dimensions["document"], dimensions["viewport"] + 1, dimensions)
        self.assertLessEqual(dimensions["body"], dimensions["viewport"] + 1, dimensions)

    def check_navigation_drawer(self, page, width):
        trigger = page.get_by_role("button", name="ナビゲーションを開く", exact=True)
        if width < 768:
            expect(trigger).to_be_visible()
        elif width == 1440:
            expect(trigger).not_to_be_visible()
        # At intermediate widths either responsive mode is allowed, provided
        # navigation remains accessible and the content fits its viewport.
        if trigger.is_visible():
            self.assert_within_viewport(page, trigger, "navigation trigger")
            trigger.click()
            drawer = page.get_by_role("dialog", name="ナビゲーション", exact=True)
            self.assert_within_viewport(page, drawer, "navigation drawer")
            expect(drawer.get_by_role("link", name="商談", exact=True)).to_be_visible()
            page.keyboard.press("Escape")
            expect(drawer).to_have_count(0)
            expect(trigger).to_be_focused()
            # Opening again and following the current list route closes the
            # drawer without writing any record or entering an external app.
            trigger.click()
            drawer.get_by_role("link", name="商談", exact=True).click()
            expect(drawer).to_have_count(0)
            page.wait_for_load_state("networkidle")
            expect(page.get_by_role("heading", name="商談一覧", exact=True)).to_be_visible()
        else:
            sidebar = page.locator("aside:visible").first
            self.assert_within_viewport(page, sidebar, "persistent sidebar", min_width=200)
            expect(sidebar.get_by_role("link", name="商談", exact=True)).to_be_visible()

    def check_filter_scroll(self, page):
        # Filter links have horizontal scrolling containers. Exercise the
        # actual right edge rather than accepting an offscreen final option.
        groups = []
        for label in ("全員", "全プロダクト", "すべて", "次回アクション順"):
            link = page.get_by_role("link", name=label, exact=True)
            expect(link).to_have_count(1)
            row = link.locator("..")
            self.assert_within_viewport(page, row, f"{label} filter row")
            metrics = row.evaluate("""el => {
              el.scrollLeft = el.scrollWidth;
              return {width: el.clientWidth, full: el.scrollWidth, left: el.scrollLeft};
            }""")
            last = row.get_by_role("link").last
            # The row can remain partially clipped at its start; its last
            # option must be completely reachable at the other edge.
            self.assert_within_viewport(page, last, f"{label} final option")
            option_rect = last.bounding_box()
            row_rect = row.bounding_box()
            self.assertGreaterEqual(option_rect["x"], row_rect["x"] - 1)
            self.assertLessEqual(option_rect["x"] + option_rect["width"],
                                 row_rect["x"] + row_rect["width"] + 1)
            if metrics["full"] > metrics["width"] + 2:
                self.assertGreater(metrics["left"], 0, f"{label} did not scroll")
            last.click(trial=True)
            row.evaluate("el => { el.scrollLeft = 0; }")
            groups.append({"label": label, **metrics})
        return groups

    def check_page(self, context, width):
        page = context.new_page()
        writes, blocked_external, errors = [], [], []

        def guard(route):
            request = route.request
            if not request.url.startswith(BASE + "/"):
                blocked_external.append(request.url)
                route.abort()
            elif request.method not in READ_METHODS:
                writes.append({"method": request.method, "url": request.url})
                route.abort()
            else:
                route.continue_()

        context.route("**/*", guard)
        page.on("pageerror", lambda error: errors.append(str(error)))
        try:
            response = page.goto(BASE + "/deals", wait_until="networkidle", timeout=60000)
            self.assertEqual(response.status, 200)
            self.assert_no_page_overflow(page)
            self.check_navigation_drawer(page, width)

            title = page.get_by_role("heading", name="商談一覧", exact=True)
            new_deal = page.get_by_role("button", name="新規商談", exact=True)
            search = page.get_by_role("button", name="企業・商談を検索", exact=True)
            self.assert_within_viewport(page, title, "list title", min_width=40)
            self.assert_within_viewport(page, new_deal, "new deal trigger", min_width=30)
            self.assert_within_viewport(page, search, "search trigger", min_width=24)
            title_rect, new_rect = title.bounding_box(), new_deal.bounding_box()
            self.assertLessEqual(title_rect["x"] + title_rect["width"], new_rect["x"] + 1,
                                 "List heading overlaps the new-deal action")

            search.click()
            search_input = page.get_by_placeholder("企業名・商談・プロダクト・代表者…", exact=True)
            self.assert_within_viewport(page, search_input, "search input", min_width=100)
            search_input.fill("サンプル")
            expect(search_input).to_have_value("サンプル")
            self.assert_no_page_overflow(page)
            page.keyboard.press("Escape")
            expect(search_input).to_have_count(0)

            new_deal.click()
            form_dialog = page.get_by_role("dialog", name="新規商談を作成", exact=True)
            self.assert_within_viewport(page, form_dialog, "new-deal dialog", min_width=200)
            self.assert_no_page_overflow(page)
            page.keyboard.press("Escape")
            expect(form_dialog).to_have_count(0)

            filter_metrics = self.check_filter_scroll(page)
            list_url = page.url
            company_link = page.locator(f'a[href^="{DEAL}"]').first
            expect(company_link).to_be_visible()
            company_name = company_link.locator("..").get_by_text("サンプル製菓株式会社", exact=True)
            company_name.scroll_into_view_if_needed()
            name_rect = company_name.bounding_box()
            point = {"x": name_rect["x"] + name_rect["width"] / 2,
                     "y": name_rect["y"] + name_rect["height"] / 2}
            # Rows intentionally use an overlay link. Verify that a normal
            # pointer click on the visible company name reaches that link.
            hit = page.evaluate("""point => {
              const target = document.elementFromPoint(point.x, point.y);
              return {tag: target?.tagName, href: target?.closest('a')?.getAttribute('href')};
            }""", point)
            self.assertEqual(hit["href"], company_link.get_attribute("href"), hit)
            page.mouse.click(point["x"], point["y"])
            page.wait_for_url(BASE + DEAL + "**", wait_until="domcontentloaded", timeout=30000)
            expect(page.locator('[data-deal-tab="overview"]')).to_be_visible(timeout=30000)
            self.assert_no_page_overflow(page)
            # The detail drawer must still work after extending the list.
            if width < 768:
                trigger = page.get_by_role("button", name="ナビゲーションを開く", exact=True)
                trigger.click()
                drawer = page.get_by_role("dialog", name="ナビゲーション", exact=True)
                expect(drawer).to_be_visible()
                page.keyboard.press("Escape")
                expect(drawer).to_have_count(0)
            page.get_by_role("link", name="商談一覧に戻る", exact=True).click()
            page.wait_for_url(lambda url: urlsplit(url).path == "/deals", timeout=30000)
            expect(title).to_be_visible(timeout=30000)
            self.assert_no_page_overflow(page)
            self.assert_within_viewport(page, new_deal, "new-deal action after list return")
            page.screenshot(path=str(OUTPUT / f"t24-list-{width}.png"))
            print(json.dumps({"width": width, "list_url": list_url, "return_url": page.url,
                              "filters": filter_metrics, "blocked_external": blocked_external},
                             ensure_ascii=False), flush=True)
            self.assertEqual(writes, [], "No AI, creates, updates, or deletes may be attempted")
            self.assertEqual(errors, [], "No browser runtime exceptions are expected")
        except Exception:
            print(json.dumps({"width": width, "failure_url": page.url,
                              "writes": writes, "errors": errors,
                              "blocked_external": blocked_external}, ensure_ascii=False), flush=True)
            page.screenshot(path=str(OUTPUT / f"t24-list-{width}-failure.png"))
            raise
        finally:
            page.close()

    def test_readonly_list_at_mobile_tablet_and_desktop_widths(self):
        OUTPUT.mkdir(exist_ok=True)
        selected = os.environ.get("T24_LIST_WIDTHS")
        widths = tuple(int(value) for value in selected.split(",")) if selected else WIDTHS
        with sync_playwright() as runtime:
            browser = runtime.chromium.launch()
            try:
                for width in widths:
                    with self.subTest(width=width):
                        context = browser.new_context(
                            viewport={"width": width, "height": 1000}, service_workers="block")
                        try:
                            # This is the only non-read operation in the test;
                            # it authenticates a fresh isolated browser context.
                            login = context.request.post(BASE + "/api/auth/login", max_redirects=0, data={
                                "email": "admin@dev.test", "password": "dev1234"})
                            self.assertEqual(login.status, 200)
                            self.check_page(context, width)
                        finally:
                            context.close()
            finally:
                browser.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
