from pathlib import Path
import subprocess,tempfile,unittest
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
class Preparation(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.tmp=tempfile.TemporaryDirectory();p=Path(cls.tmp.name)/'preview.js'
  subprocess.run(['node','scripts/build-ticket-ui-test.mjs','tests/fixtures/t10-preview.tsx',str(p)],cwd=ROOT,check=True)
  cls.bundle=p.read_text();cls.p=sync_playwright().start();cls.browser=cls.p.chromium.launch()
 @classmethod
 def tearDownClass(cls):cls.browser.close();cls.p.stop();cls.tmp.cleanup()
 def setUp(self):
  self.page=self.browser.new_page();self.errors=[];self.page.on('pageerror',lambda e:self.errors.append(str(e)));self.page.route('**/*',lambda r:r.abort())
  self.page.set_content('<div id="root"></div>');self.page.add_script_tag(content=self.bundle)
 def tearDown(self):self.page.close();self.assertEqual(self.errors,[])
 def test_legacy_failure_then_retry(self):
  self.page.get_by_role('button',name='AI準備').click();expect(self.page.get_by_role('alert')).to_contain_text('検証用エラー')
  self.page.evaluate('prepTest.fail=false');self.page.get_by_role('button',name='AI準備').click();expect(self.page.get_by_role('button',name='再生成')).to_be_enabled()
 def test_proposal_stage_and_history(self):
  self.page.evaluate('prepTest.render(true)');expect(self.page.get_by_text('事前準備ブリーフ',exact=True)).to_be_visible()
  expect(self.page.get_by_text('AIによる仮説です。断定せず商談の土台として使ってください。')).to_be_visible()
  expect(self.page.get_by_text('latest',exact=True)).to_be_visible();self.page.get_by_role('combobox',name='過去のブリーフ').select_option('older')
  expect(self.page.get_by_text('older',exact=True)).to_be_visible();expect(self.page.get_by_role('link',name='検証用の出典')).to_have_attribute('href','https://example.com')
 def test_markdown_is_readable_without_executable_html(self):
  self.page.evaluate('prepTest.renderMarkdown()')
  proposal=self.page.get_by_text('提案ストーリー',exact=True).locator('xpath=../..')
  expect(proposal.get_by_role('heading',name='商材提案',exact=True)).to_be_visible()
  expect(proposal.locator('strong')).to_have_text('採用動画')
  expect(proposal.locator('ul > li')).to_have_text(['若手社員へのインタビュー','仕事紹介'])
  expect(proposal.get_by_role('heading',name='次の確認',exact=True)).to_be_visible()
  expect(proposal.locator('ol > li')).to_have_text(['予算を確認','公開時期を確認'])
  link=proposal.get_by_role('link',name='公式サイト',exact=True)
  expect(link).to_have_attribute('href','https://example.com/recruit')
  expect(link).to_have_attribute('rel','noopener noreferrer')
  expect(proposal.get_by_role('link',name='危険なリンク')).to_have_count(0)
  expect(proposal.get_by_text('危険なリンク',exact=True)).to_be_visible()
  expect(proposal.locator('script,img,iframe')).to_have_count(0)
  self.assertFalse(self.page.evaluate('window.__markdownExecuted === true'))
  self.assertNotIn('**',proposal.inner_text());self.assertNotIn('##',proposal.inner_text())
  summary=self.page.get_by_text('業界サマリー',exact=True).locator('xpath=../..')
  expect(summary.locator('strong')).to_have_text('採用広報')
  expect(summary.locator('ul > li')).to_have_text(['公式情報を確認','不明点は商談で確認'])
  hiring=self.page.get_by_text('採用状況',exact=True).locator('xpath=../..')
  expect(hiring.locator('strong')).to_have_text('公式採用ページ')
  expect(hiring.locator('ul > li')).to_have_text(['製造職','営業職'])
  hypothesis=self.page.get_by_text('課題仮説',exact=True).locator('xpath=../..')
  expect(hypothesis.locator('strong')).to_have_text(['仕事理解','要確認'])
 def test_grounding_markdown_preserves_google_attribution(self):
  self.page.evaluate('prepTest.renderMarkdown()')
  grounding=self.page.get_by_text('公開情報の検索結果',exact=True).locator('xpath=../..')
  expect(grounding.get_by_role('heading',name='公開情報',exact=True)).to_be_visible()
  expect(grounding.locator('strong')).to_have_text('公式ページ')
  expect(grounding.locator('ul > li')).to_have_text(['募集職種を掲載','会社紹介を掲載'])
  expect(grounding.get_by_role('link',name='検索出典')).to_have_attribute('href','https://example.com/source')
  iframe=grounding.locator('iframe[title="Google検索候補"]')
  expect(iframe).to_have_attribute('sandbox','allow-popups allow-popups-to-escape-sandbox')
  expect(iframe).to_have_attribute('referrerpolicy','no-referrer')
  expect(iframe).to_have_attribute('srcdoc','<a href="https://www.google.com/search?q=demo" target="_blank">Google検索候補の表示</a>')
  expect(self.page.frame_locator('iframe[title="Google検索候補"]').get_by_role('link',name='Google検索候補の表示')).to_be_visible()
  expect(self.page.get_by_role('link',name='検証用の出典')).to_have_attribute('href','https://example.com')
 def test_unidentified_company_explanation_without_search_html(self):
  self.page.evaluate('prepTest.renderUnknownResearch()')
  grounding=self.page.get_by_text('公開情報の検索結果',exact=True).locator('xpath=../..')
  expect(grounding.get_by_text('対象企業と一致する公開情報は確認できず、他社の情報を提案の根拠には使用していません。',exact=True)).to_be_visible()
  expect(grounding.locator('iframe')).to_have_count(0)
if __name__=='__main__':unittest.main(verbosity=2)
