"""Real AiChat + local Tailwind, delayed mock API only; no app/DB/AI traffic."""
from pathlib import Path
import subprocess
import tempfile
import unittest

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SUGGESTION = "今週、最優先で動くべき案件は？"


def history(count, label="初期履歴"):
    return [
        {"id": str(index), "role": "assistant", "content": f"{label}{index + 1}。\n架空商談の確認用メッセージです。\n次回の確認事項を整理します。"}
        for index in range(count)
    ]


class ChatScroll(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="luma-chat-scroll-")
        bundle = Path(cls.temp.name) / "preview.js"
        css = Path(cls.temp.name) / "preview.css"
        subprocess.run([
            "node", "scripts/build-ticket-ui-test.mjs",
            "tests/fixtures/t24-chat-scroll-preview.tsx", str(bundle),
        ], cwd=ROOT, check=True)
        # Compile the installed Tailwind version, using the actual component's
        # classes rather than hand-built CSS that could mask flex overflow bugs.
        subprocess.run(["node", "--input-type=module", "-e", r"""
          import postcss from 'postcss';
          import tailwind from '@tailwindcss/postcss';
          import { writeFileSync } from 'node:fs';
          const input = '@import "tailwindcss" source(none);\n' +
            '@source "./src/components/dashboard/ai-chat.tsx";\n' +
            '@source "./src/components/ui";\n';
          const result = await postcss([tailwind()]).process(input, {
            from: process.cwd() + '/t24-chat-test.css',
          });
          writeFileSync(process.argv[1], result.css);
        """, str(css)], cwd=ROOT, check=True)
        cls.bundle = bundle.read_text()
        cls.css = css.read_text()
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(args=[
            "--disable-background-networking", "--disable-component-update",
            "--disable-default-apps", "--disable-sync", "--no-first-run",
        ])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.temp.cleanup()

    def setUp(self):
        self.context = self.browser.new_context(viewport={"width": 1200, "height": 800}, service_workers="block")
        self.network = []
        self.context.on("request", lambda request: self.network.append(request.url))
        self.context.route("**/*", lambda route: route.abort())
        self.page = self.context.new_page()
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.set_content("""
          <!doctype html><html lang="ja"><head><meta charset="utf-8">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'">
          <title>Chat scroll regression</title></head><body>
          <div style="height:650px">上部のページ内容</div>
          <main id="outer-scroll" style="height:540px;width:740px;overflow:auto;margin-left:50px">
            <div style="height:720px">商談概要・機能カード</div>
            <div id="chat-host" style="height:440px;width:460px"></div>
            <div style="height:800px">ページ末尾の内容</div>
          </main>
          <div style="height:1400px">ページの下部</div>
          </body></html>
        """)
        self.page.add_style_tag(content=self.css)
        self.page.add_script_tag(content=self.bundle)
        self.page.set_default_timeout(6000)
        self.reset_outer_position()

    def tearDown(self):
        try:
            state = self.page.evaluate("chatScrollTest.snapshot()")
            self.assertEqual(state["unexpectedFetches"], [])
            self.assertEqual(state["queuedCount"], 0)
            self.assertEqual(state["pendingCount"], 0)
            self.assertEqual(self.network, [])
            self.assertEqual(self.errors, [])
        finally:
            self.context.close()

    def reset_outer_position(self):
        self.page.evaluate("""() => {
          window.scrollTo(0, 230);
          document.getElementById('outer-scroll').scrollTop = 170;
        }""")
        self.expected_scroll = self.outer_position()
        self.assertEqual(self.expected_scroll, {"window": 230, "outer": 170})

    def outer_position(self):
        return self.page.evaluate("({window: window.scrollY, outer: document.getElementById('outer-scroll').scrollTop})")

    def assert_outer_unchanged(self):
        # An accidental smooth scroll can start after React commits, so wait for
        # its animation before checking the preserved ancestor positions.
        self.page.wait_for_timeout(700)
        self.assertEqual(self.outer_position(), self.expected_scroll)

    def queue(self, method, body, deferred=False):
        self.page.evaluate("response => chatScrollTest.queue(response)", {
            "method": method, "body": body, "deferred": deferred,
        })

    def mount_history(self, messages, deferred=False):
        self.queue("GET", {"messages": messages}, deferred)
        self.page.evaluate("chatScrollTest.mount()")

    def resolve(self):
        self.page.evaluate("chatScrollTest.resolvePending()")

    def assert_latest_in_chat(self, text):
        message = self.page.locator("#chat-host .overflow-y-auto").get_by_text(text, exact=True)
        expect(message).to_have_count(1)
        # Evaluate within DevTools instead of wait_for_function's CSP eval.
        result = self.page.evaluate("""async () => {
          const viewport = document.querySelector('#chat-host .overflow-y-auto');
          for (let attempt = 0; attempt < 100; attempt++) {
            if (viewport.scrollTop > 0 && Math.abs(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop) <= 2) {
              return {clientHeight: viewport.clientHeight, scrollHeight: viewport.scrollHeight};
            }
            await new Promise(resolve => setTimeout(resolve, 30));
          }
          throw Error('Chat did not scroll to its latest message');
        }""")
        self.assertGreater(result["clientHeight"], 100)
        self.assertLess(result["clientHeight"], 440)
        self.assertGreater(result["scrollHeight"], result["clientHeight"])
        latest = message.bounding_box()
        viewport = self.page.locator("#chat-host .overflow-y-auto").bounding_box()
        self.assertGreaterEqual(latest["y"], viewport["y"] - 1)
        self.assertLessEqual(latest["y"] + latest["height"], viewport["y"] + viewport["height"] + 2)

    def test_empty_mount_and_delayed_empty_history_preserve_page_position(self):
        self.mount_history([], deferred=True)
        expect(self.page.get_by_text("聞きたいことを選ぶか、直接入力してください", exact=True)).to_be_visible()
        self.assert_outer_unchanged()
        self.resolve()
        self.assert_outer_unchanged()
        self.assertEqual(self.page.locator("#chat-host .overflow-y-auto").evaluate("el => el.scrollTop"), 0)

    def test_delayed_long_history_scrolls_only_inside_chat(self):
        messages = history(30)
        self.mount_history(messages, deferred=True)
        self.assert_outer_unchanged()
        self.resolve()
        self.assert_latest_in_chat(messages[-1]["content"])
        self.assert_outer_unchanged()

    def test_reload_keeps_parent_position_and_shows_latest_history(self):
        self.mount_history(history(20))
        self.assert_latest_in_chat(history(20)[-1]["content"])
        self.page.locator("#chat-host .overflow-y-auto").evaluate("el => el.scrollTop = 0")
        messages = history(45, "更新後履歴")
        self.queue("GET", {"messages": messages}, deferred=True)
        # DOM click deliberately avoids Playwright scrolling the offscreen
        # control into view; only the component may move scroll positions here.
        self.page.get_by_title("再読み込み", exact=True).evaluate("el => el.click()")
        self.assert_outer_unchanged()
        self.resolve()
        self.assert_latest_in_chat(messages[-1]["content"])
        self.assert_outer_unchanged()

    def test_send_and_delayed_reply_scroll_chat_without_moving_ancestors(self):
        self.mount_history(history(20))
        self.assert_latest_in_chat(history(20)[-1]["content"])
        self.page.locator("#chat-host .overflow-y-auto").evaluate("el => el.scrollTop = 0")
        reply = "返信の確認です。\n次回は採用人数と予算を確認してください。"
        self.queue("POST", {"reply": reply}, deferred=True)
        self.page.get_by_role("button", name=SUGGESTION, exact=True).evaluate("el => el.click()")
        self.assert_latest_in_chat(SUGGESTION)
        self.assert_outer_unchanged()
        self.resolve()
        self.assert_latest_in_chat(reply)
        self.assert_outer_unchanged()
        requests = self.page.evaluate("chatScrollTest.snapshot().requests")
        self.assertEqual(requests[-1]["body"], {"scope": "deal:scroll-demo", "content": SUGGESTION})


if __name__ == "__main__":
    unittest.main(verbosity=2)
