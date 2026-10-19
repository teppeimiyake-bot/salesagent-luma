from pathlib import Path
import subprocess,tempfile,unittest
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
class Owner(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.tmp=tempfile.TemporaryDirectory();p=Path(cls.tmp.name)/'preview.js'
  subprocess.run(['node','scripts/build-ticket-ui-test.mjs','tests/fixtures/t21-preview.tsx',str(p)],cwd=ROOT,check=True)
  cls.bundle=p.read_text();cls.p=sync_playwright().start();cls.browser=cls.p.chromium.launch()
 @classmethod
 def tearDownClass(cls):cls.browser.close();cls.p.stop();cls.tmp.cleanup()
 def setUp(self):
  self.page=self.browser.new_page();self.errors=[];self.page.on('pageerror',lambda e:self.errors.append(str(e)));self.page.route('**/*',lambda r:r.abort())
  self.page.set_content('<div id="root"></div>');self.page.add_script_tag(content=self.bundle)
 def tearDown(self):self.page.close();self.assertEqual(self.errors,[])
 def test_network_failure_restores_choice_and_allows_retry(self):
  combo=self.page.get_by_role('combobox');combo.click();self.page.get_by_role('option',name='先方発行の Zoom').click()
  expect(self.page.get_by_role('alert')).to_be_visible();expect(combo).to_be_enabled();expect(combo).to_contain_text('自社発行')
  self.page.evaluate('ownerTest.fail=false');combo.click();self.page.get_by_role('option',name='先方発行の Zoom').click();expect(combo).to_contain_text('先方発行の Zoom');expect(self.page.get_by_role('alert')).to_have_count(0)
 def test_routes_and_viewer(self):
  for owner,label in [('own_meet','自社発行Meet・自動記録'),('guest_meet','先方発行Meet・手動添付'),('zoom','先方発行Zoom・手動添付'),('in_person','対面商談・マイク録音'),('unknown','会議種別未選択・ルート未確定')]:
   self.page.evaluate('(v)=>ownerTest.render(v,false)',owner);expect(self.page.get_by_text(label,exact=True)).to_be_visible();expect(self.page.get_by_role('combobox')).to_be_disabled()
if __name__=='__main__':unittest.main(verbosity=2)
