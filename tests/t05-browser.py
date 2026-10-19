from pathlib import Path
import subprocess,tempfile,unittest
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
class Minutes(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.tmp=tempfile.TemporaryDirectory();p=Path(cls.tmp.name)/'preview.js'
  subprocess.run(['node','scripts/build-ticket-ui-test.mjs','tests/fixtures/t05-preview.tsx',str(p)],cwd=ROOT,check=True)
  cls.bundle=p.read_text();cls.p=sync_playwright().start();cls.browser=cls.p.chromium.launch()
 @classmethod
 def tearDownClass(cls):cls.browser.close();cls.p.stop();cls.tmp.cleanup()
 def setUp(self):
  self.page=self.browser.new_page();self.errors=[];self.page.on('pageerror',lambda e:self.errors.append(str(e)));self.page.route('**/*',lambda r:r.abort())
  self.page.set_content('<div id="root"></div>');self.page.add_script_tag(content=self.bundle)
 def tearDown(self):self.page.close();self.assertEqual(self.errors,[])
 def test_save_failure_keeps_draft_and_can_retry(self):
  self.page.get_by_role('button',name='編集',exact=True).click();field=self.page.get_by_role('textbox',name='議事録');field.fill('人が書いた本文')
  self.page.get_by_role('button',name='保存',exact=True).click();expect(self.page.get_by_role('alert')).to_contain_text('保存できません');expect(field).to_have_value('人が書いた本文')
  self.page.evaluate('minutesTest.fail=false');self.page.get_by_role('button',name='保存',exact=True).click();expect(self.page.get_by_text('人が書いた本文',exact=True)).to_be_visible()
 def test_analysis_error_visible(self):
  self.page.get_by_role('button',name='AI再分析').click();expect(self.page.get_by_role('alert')).to_contain_text('検証用エラー');expect(self.page.get_by_role('button',name='AI再分析')).to_be_enabled()
 def test_server_refresh_and_dirty_draft(self):
  self.page.evaluate("minutesTest.render('サーバーの新しい議事録')");expect(self.page.get_by_text('サーバーの新しい議事録',exact=True)).to_be_visible()
  self.page.get_by_role('button',name='編集',exact=True).click();field=self.page.get_by_role('textbox',name='議事録');field.fill('編集中の内容')
  self.page.evaluate("minutesTest.render('同時更新')");expect(field).to_have_value('編集中の内容')
if __name__=='__main__':unittest.main(verbosity=2)
