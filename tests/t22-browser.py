from pathlib import Path
import subprocess,tempfile,unittest
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
class Upload(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.tmp=tempfile.TemporaryDirectory();p=Path(cls.tmp.name)/'preview.js'
  subprocess.run(['node','scripts/build-ticket-ui-test.mjs','tests/fixtures/t22-preview.tsx',str(p)],cwd=ROOT,check=True)
  cls.bundle=p.read_text();cls.p=sync_playwright().start();cls.browser=cls.p.chromium.launch()
 @classmethod
 def tearDownClass(cls):cls.browser.close();cls.p.stop();cls.tmp.cleanup()
 def setUp(self):
  self.page=self.browser.new_page();self.errors=[];self.page.on('pageerror',lambda e:self.errors.append(str(e)));self.page.route('**/*',lambda r:r.abort())
  self.page.set_content('<div id="root"></div>');self.page.add_script_tag(content=self.bundle)
 def tearDown(self):self.page.close();self.assertEqual(self.errors,[])
 def attach(self,name):self.page.get_by_label('商談記録の添付ファイル').set_input_files({'name':name,'mimeType':'text/plain','buffer':b'demo'})
 def test_analysis_network_retry_reuses_saved_record(self):
  self.attach('demo.txt');self.page.get_by_role('button',name='保存してAI分析').click()
  expect(self.page.get_by_role('status')).to_contain_text('同じ記録から分析を再試行');self.assertEqual(self.page.evaluate('uploadTest.uploads'),1)
  self.page.evaluate('uploadTest.fail=false');self.page.get_by_role('button',name='保存してAI分析').click()
  expect(self.page.get_by_role('status')).to_contain_text('完了');self.assertEqual(self.page.evaluate('uploadTest.uploads'),1);self.assertEqual(self.page.evaluate('uploadTest.analyses'),2)
  expect(self.page.get_by_role('button',name='保存してAI分析')).to_be_disabled()
 def test_pdf_rejected_before_upload(self):
  self.attach('demo.pdf');expect(self.page.get_by_role('status')).to_contain_text('対応していません');self.assertEqual(self.page.evaluate('uploadTest.uploads'),0)
 def test_polling_auth_failure_is_immediate(self):
  self.page.evaluate('uploadTest.pending=true');self.attach('demo.mp4');self.page.get_by_role('button',name='保存してAI分析').click()
  expect(self.page.get_by_role('status')).to_contain_text('HTTP 401');expect(self.page.get_by_role('button',name='保存してAI分析')).to_be_enabled();self.assertEqual(self.page.evaluate('uploadTest.analyses'),0)
if __name__=='__main__':unittest.main(verbosity=2)
