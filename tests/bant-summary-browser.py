"""Offline UI regression tests: python3 tests/bant-summary-browser.py.

Uses installed esbuild/React and Python Playwright. Does not start Next.js, read
environment files, or contact an app, database, AI provider, or other service.
"""
from pathlib import Path
import subprocess
import tempfile
import unittest

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
DEAL_A = "demo-deal-a"
DEAL_B = "demo-deal-b"


def bant(label):
    return {
        "budget": f"予算{label}：100万円",
        "authority": f"決裁者{label}",
        "need": f"採用課題{label}",
        "timeline": f"開始時期{label}",
        "summary": f"サマリー{label}",
        "updatedBy": "auto",
        "items": {"budget": {"value": f"予算{label}：100万円", "status": "confirmed"}},
    }


class BantSummaryBrowserTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="luma-bant-offline-ui-")
        output = Path(cls.temp.name) / "bant-preview.js"
        subprocess.run(
            ["node", str(ROOT / "scripts/build-bant-ui-test.mjs"), str(output)],
            cwd=ROOT, check=True,
        )
        cls.bundle = output.read_text()
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
        self.context = self.browser.new_context(service_workers="block")
        self.network_requests = []
        self.context.on("request", lambda request: self.network_requests.append(request.url))
        self.context.route("**/*", lambda route: route.abort())
        self.page = self.context.new_page()
        self.page_errors = []
        self.page.on("pageerror", lambda error: self.page_errors.append(str(error)))
        self.page.set_default_timeout(5000)
        self.page.set_content("""
            <!doctype html><html lang="ja"><head><meta charset="utf-8">
            <meta http-equiv="Content-Security-Policy"
              content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'">
            <title>Offline BANT UI test</title></head><body><div id="root"></div></body></html>
        """)
        self.page.add_script_tag(content=self.bundle)
        self.render(dealId=DEAL_A, initial=bant("A"))
        expect(self.page.get_by_text(bant("A")["budget"], exact=True)).to_be_visible()

    def tearDown(self):
        try:
            state = self.snapshot()
            self.assertEqual(state["unexpectedFetches"], [], "All fetches must use registered mocks")
            self.assertEqual(self.network_requests, [], "No browser network requests are permitted")
            self.assertEqual(self.page_errors, [], "No unhandled browser errors are permitted")
            self.assertEqual(state["queuedCount"], 0, "Every queued response must be exercised")
            self.assertEqual(state["pendingCount"], 0, "Deferred mock requests must finish")
        finally:
            self.context.close()

    def render(self, **props):
        self.page.evaluate("props => window.bantTest.render(props)", props)

    def snapshot(self):
        return self.page.evaluate("window.bantTest.snapshot()")

    def test_source_link_switches_to_the_records_tab_instead_of_a_dead_hash(self):
        # T07/T24: the source meeting lives in the hidden 商談記録 panel; a bare #anchor cannot reach it.
        source = {**bant("A"), "items": {"budget": {"value": bant("A")["budget"], "status": "confirmed",
                                                     "source_meeting_id": "src-1", "quote": "予算は100万円です"}}}
        self.render(initial=source, meetings=[{"id": "src-1", "title": "第1回", "meetingDate": "2026-08-10T15:00:00.000Z"}])
        self.page.evaluate("""() => {
            window.navigateEvents = [];
            window.addEventListener('luma:deal-navigate', e => window.navigateEvents.push(e.detail.sectionId));
            const panel = document.createElement('div');
            panel.dataset.dealTab = 'records';
            panel.hidden = true;
            panel.innerHTML = '<div id="meeting-src-1"></div>';
            document.body.appendChild(panel);
        }""")
        link = self.page.get_by_role("link", name="出典：第1回（8/11）", exact=True)
        # Opening in a new tab or copying the link also lands on the records tab.
        expect(link).to_have_attribute("href", "?tab=record#meeting-src-1")
        # Record whether the app handled the click, then stop any real navigation of the test page.
        self.page.evaluate("""() => {
            window.clickDefaults = [];
            window.addEventListener('click', e => { window.clickDefaults.push(e.defaultPrevented); e.preventDefault(); });
        }""")
        link.click()
        self.assertEqual(self.page.evaluate("window.navigateEvents"), ["meeting-src-1"])
        self.assertEqual(self.page.evaluate("window.clickDefaults"), [True], "the dead hash navigation is prevented")
        # Without the tabbed page (no data-deal-tab panel) the link keeps its normal behavior.
        self.page.evaluate("document.querySelector('[data-deal-tab]').remove(); document.body.insertAdjacentHTML('beforeend', '<div id=\"meeting-src-1\"></div>')")
        link.click()
        self.assertEqual(self.page.evaluate("window.navigateEvents"), ["meeting-src-1"])
        self.assertEqual(self.page.evaluate("window.clickDefaults"), [True, False])

    def test_manual_value_stays_visible_and_only_changed_proposal_is_displayed(self):
        current = bant("手動")
        current["manualFields"] = {"budget": True}
        current["aiSuggestion"] = {"budget": {"value": current["budget"] + "\n"}}
        self.render(initial=current)
        expect(self.page.get_by_text("AI提案（未反映）", exact=True)).to_have_count(0)
        expect(self.page.get_by_text(current["budget"], exact=True)).to_be_visible()
        current["aiSuggestion"]["budget"] = {"value": "最新商談の予算80万円"}
        self.render(initial=current)
        expect(self.page.get_by_text("AI提案（未反映）", exact=True)).to_be_visible()
        expect(self.page.get_by_text("最新商談の予算80万円", exact=True)).to_be_visible()
        expect(self.page.get_by_text(current["budget"], exact=True)).to_be_visible()
        self.assertEqual(self.snapshot()["requests"], [])


    def queue(self, method="PATCH", deal=DEAL_A, **response):
        url = f"/api/deals/{deal}" + ("/summarize-bant" if method == "POST" else "")
        self.page.evaluate(
            "response => window.bantTest.queue(response)",
            {"method": method, "url": url, **response},
        )

    def edit(self, budget="入力中の予算"):
        self.page.get_by_role("button", name="手動編集", exact=True).click()
        expect(self.page.locator("textarea")).to_have_count(5)
        self.page.locator("textarea").nth(0).fill(budget)

    def save(self):
        self.page.get_by_role("button", name="BANTを保存", exact=True).click()

    def assert_budget(self, value):
        expect(self.page.get_by_text(value, exact=True)).to_be_visible()

    def test_server_props_refresh_updates_reading_view(self):
        self.render(initial=bant("B"))
        self.assert_budget(bant("B")["budget"])
        expect(self.page.get_by_text(bant("B")["summary"], exact=True)).to_be_visible()
        expect(self.page.get_by_text(bant("A")["budget"], exact=True)).to_have_count(0)
        self.assertEqual(self.snapshot()["requests"], [])

    def test_confirmation_counts_follow_cards_and_refresh_without_using_legacy_percent(self):
        current = bant("確認状況")
        current["confidence"] = 0
        current["authority"] = "未確定: 決裁者を確認する必要あり"
        current["items"] = {
            "budget": {"status": "estimated"},
            "authority": {"status": "unknown"},
            "need": {"status": "estimated"},
            "timeline": {"status": "estimated"},
        }
        self.render(initial=current)
        summary = self.page.get_by_role("region", name="BANT確認状況", exact=True)
        expect(summary).to_be_visible()
        expect(summary.locator("li")).to_have_text(["確定 0項目", "推定 3項目", "未確定 1項目", "手動未判定 0項目"])
        expect(self.page.get_by_text("確度 0%", exact=True)).to_have_count(0)
        expect(self.page.get_by_text("情報確度", exact=True)).to_have_count(0)

        current["confidence"] = 100
        current["manualFields"] = {"budget": True}
        current["items"]["budget"]["status"] = "confirmed"
        current["items"]["need"]["status"] = "confirmed"
        self.render(initial=current)
        expect(summary.locator("li")).to_have_text(["確定 1項目", "推定 1項目", "未確定 1項目", "手動未判定 1項目"])
        expect(self.page.get_by_text("未判定", exact=True)).to_have_count(1)
        expect(self.page.get_by_text("確度 100%", exact=True)).to_have_count(0)

        for key in ("budget", "authority", "need", "timeline"):
            current[key] = "未確認"
        self.render(initial=current)
        expect(summary.locator("li")).to_have_text(["確定 0項目", "推定 0項目", "未確定 4項目", "手動未判定 0項目"])
        self.assertEqual(self.snapshot()["requests"], [])

    def test_refresh_preserves_draft_and_cancel_uses_latest_props(self):
        self.edit()
        self.page.locator("textarea").nth(4).fill("入力中の総合所感")
        self.render(initial=bant("B"))
        expect(self.page.locator("textarea").nth(0)).to_have_value("入力中の予算")
        expect(self.page.locator("textarea").nth(4)).to_have_value("入力中の総合所感")
        self.assert_budget(bant("B")["budget"])
        self.page.get_by_role("button", name="キャンセル", exact=True).click()
        expect(self.page.locator("textarea")).to_have_count(0)
        self.assert_budget(bant("B")["budget"])
        self.page.get_by_role("button", name="手動編集", exact=True).click()
        expect(self.page.locator("textarea").nth(0)).to_have_value(bant("B")["budget"])

    def test_save_http_failure_keeps_input_and_shows_error(self):
        self.edit()
        self.page.locator("textarea").nth(4).fill("保存したい所感")
        self.queue(status=500, body={"error": "保存に失敗しました（テスト）"})
        self.save()
        expect(self.page.get_by_role("alert")).to_have_text("保存に失敗しました（テスト）")
        expect(self.page.locator("textarea").nth(0)).to_have_value("入力中の予算")
        expect(self.page.locator("textarea").nth(4)).to_have_value("保存したい所感")
        self.assert_budget(bant("A")["budget"])
        self.assertEqual(self.snapshot()["refreshCount"], 0)

    def test_save_transport_or_invalid_response_keeps_input(self):
        self.edit()
        for response in [
            {"error": "通信エラー（テスト）"},
            {"rawText": "not-json"},
            {"body": {"deal": {}}},
        ]:
            with self.subTest(response=response):
                self.queue(**response)
                self.save()
                expect(self.page.get_by_role("alert")).to_be_visible()
                expect(self.page.locator("textarea").nth(0)).to_have_value("入力中の予算")
                expect(self.page.get_by_role("button", name="BANTを保存", exact=True)).to_be_enabled()
        self.assertEqual(self.snapshot()["refreshCount"], 0)

    def test_ai_failures_keep_draft_and_saved_view(self):
        self.edit()
        for response in [
            {"status": 503, "body": {"error": "AI処理失敗（テスト）"}},
            {"error": "AI通信失敗（テスト）"},
            {"rawText": "not-json"},
            {"body": {"bant": []}},
        ]:
            with self.subTest(response=response):
                self.queue(method="POST", **response)
                self.page.get_by_role("button", name="AI再集約", exact=True).click()
                expect(self.page.get_by_role("alert")).to_be_visible()
                expect(self.page.locator("textarea").nth(0)).to_have_value("入力中の予算")
                self.assert_budget(bant("A")["budget"])
                expect(self.page.get_by_role("button", name="AI再集約", exact=True)).to_be_enabled()
        self.assertEqual(self.snapshot()["refreshCount"], 0)

    def test_save_success_then_new_server_props_replace_response(self):
        self.edit("保存した予算")
        saved = {**bant("保存後"), "budget": "保存した予算", "updatedBy": "manual"}
        self.queue(body={"deal": {"bant": saved}})
        self.save()
        expect(self.page.locator("textarea")).to_have_count(0)
        self.assert_budget("保存した予算")
        self.assertEqual(self.snapshot()["refreshCount"], 1)
        self.render(initial=bant("最新"))
        self.assert_budget(bant("最新")["budget"])
        expect(self.page.get_by_text("保存した予算", exact=True)).to_have_count(0)

    def test_ai_success_updates_cards_without_overwriting_draft(self):
        self.edit()
        self.queue(method="POST", body={"bant": bant("AI"), "fallback": False})
        self.page.get_by_role("button", name="AI再集約", exact=True).click()
        self.assert_budget(bant("AI")["budget"])
        expect(self.page.locator("textarea").nth(0)).to_have_value("入力中の予算")
        self.assertEqual(self.snapshot()["refreshCount"], 1)
        self.render(initial=bant("最新"))
        expect(self.page.locator("textarea").nth(0)).to_have_value("入力中の予算")
        self.page.get_by_role("button", name="キャンセル", exact=True).click()
        self.assert_budget(bant("最新")["budget"])

    def test_empty_fields_are_sent_as_empty_strings(self):
        self.edit("")
        for field in self.page.locator("textarea").all():
            field.fill("")
            expect(field).to_have_value("")
        empty = dict.fromkeys(["budget", "authority", "need", "timeline", "summary"], "")
        self.queue(body={"deal": {"bant": empty}})
        self.save()
        expect(self.page.locator("textarea")).to_have_count(0)
        expect(self.page.get_by_text("まだBANT情報が登録されていません。", exact=True)).to_be_visible()
        self.assertEqual(self.snapshot()["requests"][0]["body"], {"bant": empty})

    def test_only_user_changed_fields_are_patched_after_refresh(self):
        self.edit("変更した予算だけ")
        self.render(initial=bant("新しい集約"))
        saved = {**bant("新しい集約"), "budget": "変更した予算だけ"}
        self.queue(body={"deal": {"bant": saved}})
        self.save()
        expect(self.page.locator("textarea")).to_have_count(0)
        self.assertEqual(
            self.snapshot()["requests"][0]["body"],
            {"bant": {"budget": "変更した予算だけ"}},
        )
        expect(self.page.get_by_text(bant("新しい集約")["authority"], exact=True)).to_be_visible()

    def test_unchanged_draft_closes_without_saving_stale_fields(self):
        self.page.get_by_role("button", name="手動編集", exact=True).click()
        self.render(initial=bant("新しい集約"))
        self.save()
        expect(self.page.locator("textarea")).to_have_count(0)
        self.assert_budget(bant("新しい集約")["budget"])
        self.assertEqual(self.snapshot()["requests"], [])

    def test_switching_deal_discards_draft_and_error(self):
        self.edit()
        self.queue(status=500, body={"error": "案件Aのエラー"})
        self.save()
        expect(self.page.get_by_role("alert")).to_be_visible()
        self.render(dealId=DEAL_B, initial=bant("別案件"))
        expect(self.page.locator("textarea")).to_have_count(0)
        expect(self.page.get_by_role("alert")).to_have_count(0)
        self.assert_budget(bant("別案件")["budget"])
        self.page.get_by_role("button", name="手動編集", exact=True).click()
        expect(self.page.locator("textarea").nth(0)).to_have_value(bant("別案件")["budget"])

    def test_old_deal_response_cannot_overwrite_new_deal(self):
        self.edit()
        self.queue(body={"deal": {"bant": bant("古い応答")}}, deferred=True)
        self.save()
        self.assertEqual(self.snapshot()["pendingCount"], 1)
        self.render(dealId=DEAL_B, initial=bant("別案件"))
        self.page.evaluate("window.bantTest.resolvePending()")
        # wait_for_function re-evaluates a source string, which strict CSP forbids.
        # Poll within one DevTools evaluation without permitting unsafe-eval.
        self.page.evaluate("""async () => {
            for (let i = 0; i < 100; i++) {
                if (window.bantTest.snapshot().refreshCount === 1) return;
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            throw new Error("Deferred save did not finish");
        }""")
        self.assert_budget(bant("別案件")["budget"])
        expect(self.page.get_by_text(bant("古い応答")["budget"], exact=True)).to_have_count(0)
        expect(self.page.locator("textarea")).to_have_count(0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
