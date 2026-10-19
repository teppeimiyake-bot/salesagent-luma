import { createRoot } from "react-dom/client";
import { PreparationPanel } from "../../src/components/deals/preparation-panel";
const root=createRoot(document.getElementById("root")!);
const brief=(id:string,markdown=false)=>({
 id,status:"done",created_at:"2026-09-21T00:00:00Z",
 industry_summary:markdown?"**採用広報**を確認する。\n\n- 公式情報を確認\n- 不明点は商談で確認":id,
 hiring_insights:markdown?{media:"**公式採用ページ**",roles:"- 製造職\n- 営業職",scale:"確認できず",sources:[]}:null,
 pain_hypotheses:markdown?[{hypothesis:"**仕事理解**の不足という仮説",confidence:"low",evidence:"根拠は**要確認**。",source_url:""}]:[],
 proposal_story:markdown?[
  "# 商材提案", "", "**採用動画**を提案します。", "",
  "- 若手社員へのインタビュー", "- 仕事紹介", "",
  "## 次の確認", "", "1. 予算を確認", "2. 公開時期を確認", "",
  "[公式サイト](https://example.com/recruit)", "",
  "[危険なリンク](javascript:alert%281%29)", "",
  '<script>window.__markdownExecuted=true</script>', "",
  '<img src="https://invalid.example/tracker" onerror="window.__markdownExecuted=true">', "",
  "![外部画像](https://invalid.example/image.png)",
 ].join("\n"):"# 商材提案\n架空の採用動画提案",
 sources:[{title:"検証用の出典",url:"https://example.com"}],model:"mock",
 vertex_grounding:markdown?{
  text:"## 公開情報\n\n**公式ページ**の情報です。\n\n- 募集職種を掲載\n- 会社紹介を掲載\n\n[検索出典](https://example.com/source)",
  searchHtml:'<a href="https://www.google.com/search?q=demo" target="_blank">Google検索候補の表示</a>',
 }:null,
});
const history=[brief("latest"),brief("older")];
declare global {interface Window {prepTest:{fail:boolean;v2:boolean;render:(v2:boolean)=>void;renderMarkdown:()=>void;renderUnknownResearch:()=>void}}}
window.prepTest={fail:true,v2:false,render(v2){window.prepTest.v2=v2;root.render(<PreparationPanel key={String(v2)} dealId="demo" status={v2?"PROPOSAL":"LEAD"} preparationV2Enabled={v2}/>);},renderMarkdown(){history[0]=brief("markdown",true);window.prepTest.render(true);},renderUnknownResearch(){history[0]={...brief("unknown",true),vertex_grounding:{text:"対象企業と一致する公開情報は確認できず、他社の情報を提案の根拠には使用していません。",searchHtml:""}};window.prepTest.render(true);}};
window.fetch=async(input,init)=>{
 if(init?.method==="POST")return Response.json(window.prepTest.fail?{error:"検証用エラー"}:{preparation:{hearing_questions:[],hypotheses:[],talking_points:[],common_concerns:[],recommended_materials:[]}}, {status:window.prepTest.fail?500:200});
 return Response.json(String(input).includes("history=1")?{briefs:history}:{brief:history[0]});
};
window.prepTest.render(false);
