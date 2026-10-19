"""Normal local app, confirmed development DB, read-only after demo-account login."""
import unittest
from playwright.sync_api import sync_playwright, expect
BASE = "http://127.0.0.1:3003"
DEAL = "/deals/0d010000-0000-4000-8000-000000000001"
class DevelopmentApp(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.p=sync_playwright().start();cls.browser=cls.p.chromium.launch()
 @classmethod
 def tearDownClass(cls):cls.browser.close();cls.p.stop()
 def setUp(self):
  self.context=self.browser.new_context(viewport={"width":1440,"height":1000})
  self.context.route("**/*",lambda r:r.continue_() if r.request.url.startswith(BASE+"/") else r.abort())
  self.page=self.context.new_page();self.errors=[];self.page.on("pageerror",lambda e:self.errors.append(str(e)))
  r=self.context.request.post(BASE+"/api/auth/login",data={"email":"admin@dev.test","password":"dev1234"})
  self.assertEqual(r.status,200)
 def tearDown(self):self.context.close();self.assertEqual(self.errors,[])
 def test_normal_app_navigation_and_feature_flags(self):
  for route in ["/dashboard","/deals",DEAL,"/agent"]:
   response=self.page.goto(BASE+route,wait_until="domcontentloaded",timeout=60000)
   self.assertEqual(response.status,200,route)
   expect(self.page.locator("body")).not_to_contain_text("Application error")
  expect(self.page.get_by_text("問い合わせエージェント",exact=False)).to_be_visible()
  expect(self.page.locator("body")).not_to_contain_text("リスト作成エージェント")
  response=self.context.request.get(BASE+"/api/quote-templates")
  self.assertEqual(response.status,200);self.assertIsInstance(response.json()["templates"],list)
  response=self.context.request.get(BASE+DEAL.replace("/deals/","/api/deals/")+"/preparation")
  self.assertEqual(response.status,200)
 def test_tabs_preserve_drafts_filters_and_browser_history(self):
  self.page.goto(BASE+DEAL+"?from=yomi%3DA&tab=quote",wait_until="domcontentloaded",timeout=60000)
  self.page.wait_for_load_state('networkidle')
  nav=self.page.get_by_role("navigation",name="商談詳細の内容タブ")
  expect(self.page.locator('[data-deal-tab="quote"]')).to_be_visible()
  self.page.locator('#section-quote').get_by_role('button',name='新規作成',exact=True).click()
  self.page.get_by_placeholder('例: 採用動画制作一式',exact=True).fill('架空・未保存の見積入力')
  nav.get_by_role('button',name='準備・BANT').click()
  expect(self.page.locator('[data-deal-tab="prepare"]')).to_be_visible()
  self.assertIn('from=yomi%3DA',self.page.url)
  nav.get_by_role('button',name='見積・契約').click()
  expect(self.page.get_by_placeholder('例: 採用動画制作一式',exact=True)).to_have_value('架空・未保存の見積入力')
  self.page.evaluate("history.pushState(null,'','?from=yomi%3DA&tab=record')")
  expect(self.page.locator('[data-deal-tab="record"]')).to_be_visible()
  self.page.go_back();expect(self.page.locator('[data-deal-tab="quote"]')).to_be_visible()
  self.page.evaluate("window.dispatchEvent(new CustomEvent('luma:deal-navigate',{detail:{sectionId:'section-upload'}}))")
  expect(self.page.locator('[data-deal-tab="record"]')).to_be_visible()
  expect(self.page.get_by_label('商談記録の添付ファイル')).to_be_visible()
  expect(self.page.get_by_text('次の一手',exact=True)).to_be_visible()
  expect(self.page.get_by_role('link',name='商談一覧に戻る')).to_have_attribute('href','/deals?yomi=A')
  self.page.screenshot(path=str(__import__('pathlib').Path(__file__).resolve().parents[1]/'.verification/t24-desktop.png'))
 def test_mobile_invalid_tab_and_recording_route(self):
  self.page.set_viewport_size({"width":390,"height":844})
  self.page.goto(BASE+DEAL+"?tab=does-not-exist",wait_until="domcontentloaded",timeout=60000)
  self.page.wait_for_load_state('networkidle')
  expect(self.page.locator('[data-deal-tab="overview"]')).to_be_visible()
  self.page.get_by_role('navigation',name='商談詳細の内容タブ').get_by_role('button',name='商談記録').click()
  expect(self.page.get_by_test_id('meeting-recording-route')).to_be_visible()
  expect(self.page.get_by_label('商談記録の添付ファイル')).to_be_visible()
  self.assertGreaterEqual(self.page.get_by_test_id('meeting-recording-route').bounding_box()['width'],300)
  self.page.get_by_role('button',name='ナビゲーションを開く').click()
  expect(self.page.get_by_role('dialog',name='ナビゲーション')).to_be_visible()
  self.page.keyboard.press('Escape');expect(self.page.get_by_role('dialog',name='ナビゲーション')).to_have_count(0)
  self.page.get_by_test_id('meeting-recording-route').scroll_into_view_if_needed()
  self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'),390)
  self.page.screenshot(path=str(__import__('pathlib').Path(__file__).resolve().parents[1]/'.verification/t24-mobile.png'))
if __name__=="__main__":unittest.main(verbosity=2)
