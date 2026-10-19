"""Real recording component and IndexedDB, simulated media permission/recorder and API."""
from pathlib import Path
import subprocess, tempfile, unittest
from playwright.sync_api import sync_playwright, expect
ROOT = Path(__file__).resolve().parents[1]
MEDIA = '''
window.mediaTest = { stopped:0, calls:0, uploads:[], failUpload:true, denied:false, options:null, opened:[], slices:[] };
const track = {stop(){mediaTest.stopped++}};
const stream = {getTracks:()=>[track], getAudioTracks:()=>[track], getVideoTracks:()=>[]};
Object.defineProperty(navigator, 'mediaDevices', {value:{
  async getUserMedia(){mediaTest.calls++; if(mediaTest.denied) throw Error('permission denied'); return stream},
  async getDisplayMedia(){mediaTest.calls++; return stream}
}});
window.MediaStream = class {getTracks(){return [track]}};
window.MediaRecorder = class {
  static isTypeSupported(){return true}
  constructor(s, options){mediaTest.options=options; mediaTest.recorder=this; this.state='inactive'}
  start(slice){this.state='recording';mediaTest.slices.push(slice)}
  emit(text='audio'){this.ondataavailable?.({data:new Blob([text],{type:'audio/webm'})})}
  stop(){this.emit('last');this.state='inactive';queueMicrotask(()=>this.onstop?.())}
};
window.open=(url)=>{mediaTest.opened.push(url);return null};
window.fetch=async(url,options)=>{
  if(url==='/api/meetings') {
    mediaTest.uploads.push({text:await options.body.get('file').text(),dealId:options.body.get('dealId')});
    return Response.json(mediaTest.failUpload?{error:'simulated failure'}:{meeting:{id:'saved',hasTranscript:true}}, {status:mediaTest.failUpload?500:201});
  }
  if(url==='/api/meetings/saved/analyze') return Response.json({});
  throw Error('Unexpected request '+url);
};
'''

class Recorder(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory(); out=Path(cls.tmp.name)/'bundle.js'
        subprocess.run(['node','scripts/build-ticket-ui-test.mjs','tests/fixtures/t03-preview.tsx',str(out)],cwd=ROOT,check=True)
        cls.bundle=out.read_text(); cls.p=sync_playwright().start(); cls.browser=cls.p.chromium.launch()
    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.p.stop(); cls.tmp.cleanup()
    def setUp(self):
        self.ctx=self.browser.new_context(); self.page=self.ctx.new_page(); self.errors=[]
        self.page.on('pageerror',lambda e:self.errors.append(str(e)))
        self.ctx.route('**/*',lambda r:r.fulfill(body='<div id="root"></div>',content_type='text/html') if r.request.url=='http://127.0.0.1/t03-test' else r.abort())
        self.page.goto('http://127.0.0.1/t03-test'); self.page.add_script_tag(content=MEDIA); self.page.add_script_tag(content=self.bundle)
        expect(self.page.get_by_role('button',name='録音開始',exact=True)).to_be_visible()
    def tearDown(self):
        self.ctx.close(); self.assertEqual(self.errors,[])
    def start(self):
        self.page.get_by_role('button',name='録音開始',exact=True).click()
        expect(self.page.get_by_role('button',name='停止して送信')).to_be_visible()
    def emit(self,text='first'):
        self.page.evaluate('(s)=>mediaTest.recorder.emit(s)',text)
        self.page.wait_for_function("new Promise(resolve=>{const r=indexedDB.open('reeasy-meeting-recorder');r.onsuccess=()=>{const d=r.result;const q=d.transaction('recordings').objectStore('recordings').get('t03-demo');q.onsuccess=()=>{d.close();resolve(q.result?.chunkCount>0)}}})")
    def test_bitrate_and_timeslice(self):
        self.start(); self.assertEqual(self.page.evaluate('mediaTest.options.audioBitsPerSecond'),32000)
        self.assertEqual(self.page.evaluate('mediaTest.slices'),[500])
    def test_failure_keeps_backup_and_blocks_overwrite(self):
        self.start();self.emit();self.page.get_by_role('button',name='停止して送信').click()
        expect(self.page.get_by_role('button',name='復元して送信')).to_be_visible()
        expect(self.page.get_by_role('button',name='録音開始',exact=True)).to_be_disabled()
        self.assertEqual(self.page.evaluate('mediaTest.uploads[0].text'),'firstlast')
    def test_navigation_retains_backup_without_upload(self):
        self.start();self.emit();self.page.evaluate('recorderTest.hide()')
        expect(self.page.get_by_role('button',name='停止して送信')).to_have_count(0)
        self.assertEqual(self.page.evaluate('mediaTest.uploads'),[])
        self.page.evaluate('recorderTest.mount()')
        expect(self.page.get_by_role('button',name='復元して送信')).to_be_visible()
        self.page.evaluate('mediaTest.failUpload=false');self.page.get_by_role('button',name='復元して送信').click()
        expect(self.page.get_by_text('録音処理が完了しました。文字起こしと議事録を確認できます。')).to_be_visible()
        expect(self.page.get_by_role('button',name='復元して送信')).to_have_count(0)
        self.assertEqual(self.page.evaluate('mediaTest.uploads[0].text'),'firstlast')
    def test_discard_enables_new_recording(self):
        self.start();self.emit();self.page.get_by_role('button',name='停止して送信').click()
        self.page.get_by_role('button',name='破棄',exact=True).click()
        expect(self.page.get_by_role('button',name='録音開始',exact=True)).to_be_enabled()
    def test_permission_rejection_can_retry(self):
        self.page.evaluate('mediaTest.denied=true');self.page.get_by_role('button',name='録音開始',exact=True).click()
        expect(self.page.get_by_text('録音開始に失敗しました: permission denied')).to_be_visible()
        self.page.evaluate('mediaTest.denied=false');self.start()
    def test_tab_audio_without_meet_shortcut(self):
        # T16 AC8: 「Meetに参加して録音開始」は廃止。タブ音声は先方Meet／Zoom向けに明示選択で残り、Meetは開かない
        expect(self.page.get_by_role('button',name='Meetに参加して録音開始')).to_have_count(0)
        expect(self.page.get_by_text('上のMeetボタン')).to_have_count(0)
        self.page.get_by_role('button',name='タブ音声',exact=True).click();self.start()
        self.assertEqual(self.page.evaluate('mediaTest.opened'),[])
    def test_recorder_creation_failure_stops_stream(self):
        self.page.evaluate("() => {window.MediaRecorder=class {static isTypeSupported(){return true};constructor(){throw Error('unsupported')}}}")
        self.page.get_by_role('button',name='録音開始',exact=True).click()
        expect(self.page.get_by_text('録音開始に失敗しました: unsupported')).to_be_visible()
        self.assertGreater(self.page.evaluate('mediaTest.stopped'),0)

if __name__=='__main__':unittest.main(verbosity=2)
