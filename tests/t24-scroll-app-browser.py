"""Read-only scroll regression against the real local development app."""
import json
import os
import unittest
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

BASE = "http://127.0.0.1:3003"
DEAL = "/deals/0d010000-0000-4000-8000-000000000001"
BASELINE = os.environ.get("T24_SCROLL_BASELINE") == "1"
SCROLLER = "div.flex-1.overflow-y-auto.bg-zinc-50"
TRACK_SCROLL = """(() => {
  window.__observedScrollIntoView = [];
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function(...args) {
    window.__observedScrollIntoView.push({id: this.id, tag: this.tagName,
      classes: this.className, parentClasses: this.parentElement?.className,
      text: this.textContent?.slice(0, 60), options: args[0],
      stack: new Error().stack?.split('\\n').slice(1, 4).join('\\n')});
    return original.apply(this, args);
  };
})()"""


class DealEntryScroll(unittest.TestCase):
    def test_detail_entry_and_explicit_section_navigation(self):
        with sync_playwright() as runtime:
            browser = runtime.chromium.launch()
            context = browser.new_context(viewport={"width": 1440, "height": 1000})
            # Login uses the API context below; all browser traffic is read-only.
            context.route("**/*", lambda route: route.continue_()
                          if route.request.url.startswith(BASE + "/")
                          and route.request.method in ("GET", "HEAD", "OPTIONS") else route.abort())
            context.add_init_script(TRACK_SCROLL)
            page = context.new_page()
            writes, errors = [], []
            page.on("request", lambda request: writes.append(request.url)
                    if "/api/" in request.url and request.method in ("POST", "PATCH", "DELETE") else None)
            page.on("pageerror", lambda error: errors.append(str(error)))
            try:
                login = context.request.post(BASE + "/api/auth/login", data={
                    "email": "admin@dev.test", "password": "dev1234"})
                self.assertEqual(login.status, 200)
                for width, height, size in ((1440, 1000, "desktop"), (390, 844, "mobile")):
                    if os.environ.get("T24_SCROLL_SIZE") and os.environ["T24_SCROLL_SIZE"] != size:
                        continue
                    page.set_viewport_size({"width": width, "height": height})
                    for tab in ("overview", "prepare", "record", "quote"):
                        response = page.goto(BASE + DEAL + "?tab=" + tab,
                                             wait_until="networkidle", timeout=60000)
                        self.assertEqual(response.status, 200)
                        expect(page.locator(f'[data-deal-tab="{tab}"]')).to_be_visible()
                        state = page.locator(SCROLLER).evaluate("""el => ({top: el.scrollTop,
                          height: el.clientHeight, full: el.scrollHeight,
                          calls: window.__observedScrollIntoView})""")
                        print(f"{size}/{tab}: {json.dumps(state, ensure_ascii=False)}", flush=True)
                        if not BASELINE:
                            self.assertLessEqual(state["top"], 1, f"{size}/{tab} must open at the top")
                            self.assertEqual(state["calls"], [], "Ordinary entry must not scroll into chat")
                    response = page.goto(BASE + "/deals", wait_until="networkidle", timeout=60000)
                    self.assertEqual(response.status, 200)
                    link = page.locator(f'a[href^="{DEAL}"]').first
                    print(f"{size}/list-link target: {link.get_attribute('href')}", flush=True)
                    link.click()
                    page.wait_for_url(BASE + DEAL + "**", wait_until="domcontentloaded", timeout=30000)
                    page.wait_for_load_state("networkidle")
                    state = page.locator(SCROLLER).evaluate("el => ({top: el.scrollTop, height: el.clientHeight, full: el.scrollHeight, calls: window.__observedScrollIntoView})")
                    print(f"{size}/list-link: {json.dumps(state, ensure_ascii=False)}", flush=True)
                    if not BASELINE:
                        self.assertLessEqual(state["top"], 1, f"{size} list entry must open at the top")
                        nav = page.get_by_role("navigation", name="商談詳細の内容タブ")
                        for tab, label in (("prepare", "準備・BANT"), ("record", "商談記録"), ("quote", "見積・契約"), ("overview", "概要")):
                            nav.get_by_role("button", name=label, exact=False).click()
                            expect(page.locator(f'[data-deal-tab="{tab}"]')).to_be_visible()
                            self.assertLessEqual(page.locator(SCROLLER).evaluate("el => el.scrollTop"), 1)
                        page.evaluate("window.__observedScrollIntoView = []; window.dispatchEvent(new CustomEvent('luma:deal-navigate',{detail:{sectionId:'section-upload'}}))")
                        expect(page.locator('[data-deal-tab="record"]')).to_be_visible()
                        page.wait_for_function("document.querySelector('div.flex-1.overflow-y-auto.bg-zinc-50').scrollTop > 10")
                        # Smooth scrolling may continue for a few animation frames; wait for the target.
                        page.wait_for_function("""() => {
                          const target = document.getElementById('section-upload');
                          const rect = target.getBoundingClientRect();
                          return rect.top >= 0 && rect.top < innerHeight / 2;
                        }""")
                        explicit = page.evaluate("window.__observedScrollIntoView")
                        self.assertTrue(any(call["id"] == "section-upload" for call in explicit))
                        page.screenshot(path=str(Path(__file__).resolve().parents[1] /
                                                 f".verification/t24-explicit-scroll-{size}.png"))
                self.assertEqual(writes, [], "No AI, saves, or other mutations are allowed")
                self.assertEqual(errors, [])
            except Exception:
                print(f"Failure URL: {page.url}; mutation requests: {writes}", flush=True)
                page.screenshot(path=str(Path(__file__).resolve().parents[1] / ".verification/t24-scroll-failure.png"))
                raise
            finally:
                context.close()
                browser.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
