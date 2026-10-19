import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {offlineModule} from "./helpers/offline-module.mjs";
async function setup(){
 const mocks={prompts:[],reply:null,replies:null,heavyReply:null,contextReads:[],contextText:"架空商材"};
 const entry="src/lib/ai/pipeline.ts";
 const pipeline=await offlineModule(entry,mocks,{
  "./anthropic":"export const callClaudeHeavyJSON=async p=>{mocks.prompts.push(p);return mocks.heavyReply};export const callClaudeJSON=async p=>{mocks.prompts.push(p);return mocks.replies?mocks.replies.shift():mocks.reply};export const tryParseJSON=JSON.parse;",
  "./provider":"export const hasAiTextKey=()=>false;",
  "./luma-context":"export const getLumaContextText=async input=>{mocks.contextReads.push(input);return mocks.contextText};export const formatLumaContextForPrompt=t=>t;",
 },[entry,"src/lib/ai/fewshot.ts","src/lib/ai/bant-definitions.ts","src/lib/ai/bant-withdrawal.ts", "src/lib/ai/bant-reconciliation.ts","src/lib/ai/timeline-evidence.ts", "src/lib/ai/customer-conditions.ts", "src/lib/ai/offer-evidence.ts", "src/lib/ai/strategy-text.ts", "src/lib/ai/action-outcome.ts", "src/lib/ai/minutes-proposal-evidence.ts", "src/lib/ai/issue-evidence.ts", "src/lib/ai/need-evidence.ts", "src/lib/ai/action-reason-evidence.ts", "src/lib/ai/recommendation-source-references.ts", "src/lib/ai/minutes-action-evidence.ts","src/lib/ai/minutes-participant-evidence.ts", "src/lib/ai/causal-evidence.ts"]);
 return{pipeline,mocks};
}
function includesTranscript(user, transcript) {
 return transcript.split(/\r?\n/u).filter(Boolean).every(line => user.includes(line) || user.includes(JSON.stringify(line).slice(1,-1)));
}
const ctx={companyName:"架空テスト社",dealTitle:"品質検証"};
test("recorded agreed-case minutes retain the acknowledged deadline and both literal seller offers",async()=>{
 const {pipeline,mocks}=await setup();
 const transcript=readFileSync(new URL("./fixtures/uat/t18-agreed-conditions.txt",import.meta.url),"utf8");
 const draft=JSON.parse(readFileSync(new URL("./fixtures/uat/t18-agreed-minutes-draft.json",import.meta.url),"utf8"));
 const before=JSON.stringify(draft);
 mocks.heavyReply={parsed:draft,usedFallback:false};
 const result=await pipeline.generateMeetingMinutes(transcript,{...ctx,companyName:"星見設備株式会社"});
 const expectedAction="私、田中が2026年9月30日17時までに、今回合意した内容を記載した企画書と正式見積書を、佐伯様へメールで送付します。";
 assert.deepEqual(JSON.parse(JSON.stringify(result.json.next_actions)),[{action:expectedAction,owner:"営業",due:"2026年9月30日17時"}]);
 assert.equal(result.json.proposals.length,2);
 for(const [index,candidate] of draft.proposals.entries()){
  assert.equal(result.json.proposals[index],`営業側の検討案：${candidate.source_quote}`);
 }
 assert.equal(result.json.summary,draft.summary);
 assert.deepEqual(Array.from(result.json.decisions),draft.decisions);
 assert.deepEqual(Array.from(result.json.participants),draft.participants);
 assert.match(result.markdown,/期限: 2026年9月30日17時/);
 assert.ok(result.markdown.includes(draft.decisions[2]),"SNS non-adoption must remain a decision");
 assert.ok(result.actionAudit.rejected.some(row=>row.index===1&&row.reason==="omitted_adjacent_qualifier"),"do not invent a confirmed meeting action from a partial qualified quote");
 assert.equal(JSON.stringify(result.actionAudit.candidates),JSON.stringify(draft.next_actions));
 assert.equal(JSON.stringify(result.proposalAudit.candidates),JSON.stringify(draft.proposals));
 assert.equal(JSON.stringify(draft),before,"the recorded model candidates remain unchanged");
});

test("agreed conditions preserve approved price, decision maker, delivery and literal timed seller commitment",async()=>{
 const {pipeline,mocks}=await setup();const f=reasoningFixture();
 const transcript=readFileSync(new URL("./fixtures/uat/t18-agreed-conditions.txt",import.meta.url),"utf8");
 const specification=JSON.parse(readFileSync(new URL("./fixtures/uat/t18-agreed-conditions.expected.json",import.meta.url),"utf8"));
 const expected=specification.expected;
 // IDs include the fixture headers, exactly as timelineSourceTurns does.
 const sourceLines=transcript.split(/\r?\n/u).filter(line=>line.trim());
 const source=(prefix)=>{const index=sourceLines.findIndex(line=>line.startsWith(prefix));assert.ok(index>=0,prefix);return {id:index+1,text:sourceLines[index]};};
 const need=source("顧客：私は取締役");
 const offer=source("営業：当社は税込");
 const adoption=source("顧客：説明いただいた範囲");
 const dates=source("顧客：はい。2026年12月15日");
 const snsOption=source("営業：別の選択肢としてSNS");
 const snsDeclined=source("顧客：今回はSNS");
 const sellerAction=source("営業：私、田中が");
 const customerAcceptance=source("顧客：はい。企画書");
 const meeting=source("顧客：私も2026年10月5日");
 const body=(line)=>line.replace(/^(?:営業|顧客)：/u,"");
 const firstSentence=(line)=>body(line).match(/^[^。]+。/u)[0];
 const sellerQuote=firstSentence(sellerAction.text);
 const due="2026年9月30日17時";
 const approvedBudget="税込110万円（税抜100万円、消費税10万円）、2026年9月18日に正式承認済み";
 const authority="最終決裁者は取締役・佐伯真理。追加の社内承認は不要。";
 const agreedTimeline="2026年12月15日納品、2027年1月10日公開で正式確定。公開作業は顧客が担当する。";
 const supportedOffer="税込110万円で採用動画を提供できると説明する。";
 const meetingAction="次回面談の候補日2026年10月5日について双方の空き状況を確認する。";
 const decisions=[firstSentence(adoption.text),body(dates.text),body(snsDeclined.text)];
 mocks.heavyReply=minutesReply("星見設備株式会社は承認済みの税込110万円で採用動画の導入・発注に合意した。納品は2026年12月15日、公開は2027年1月10日で正式確定。SNS運用代行は不採用。田中が企画書と正式見積書を2026年9月30日17時までに佐伯へ送付する。次回面談は2026年10月5日が未確定の候補。");
 Object.assign(mocks.heavyReply.parsed,{
  participants:["営業・田中","顧客・取締役 佐伯真理"],issue_source_ids:[need.id],decisions,
  proposals:[{text:"SNS運用代行は別の選択肢として紹介された。",source_quote:firstSentence(snsOption.text),speech_act:"offered_option"}],
  next_actions:[{action:sellerQuote,owner:"営業・田中",due,source_quote:sellerQuote}],
 });
 const structured={...f.structured,speaker_turns:sourceLines.filter(line=>/^(?:営業|顧客)：/u.test(line)).map(line=>({speaker:line.split("：")[0],utterance:body(line)})),
  key_facts:[approvedBudget,authority,agreedTimeline,"SNS運用代行は不採用。"],decisions,open_questions:["次回面談の候補日2026年10月5日は双方の予定確認が必要。"]};
 const analysis={...f.analysis,issue_source_ids:[need.id],need_source_ids:[need.id],timeline_source_ids:[adoption.id,dates.id],
  hidden_needs:[],risks:[],bant:{budget:approvedBudget,authority,need:expected.need.meaning,timeline:agreedTimeline}};
 const topSales={...f.topSales,real_intent:expected.need.meaning,decision_structure:authority,risks:[],winning_scenario:supportedOffer};
 const strategy={...f.strategy,strategy:"合意済みの採用動画を制作する。SNS運用代行は今回採用しない。",differentiation:"合意した範囲の提供を進める。",closing_plan:`${sellerQuote}\n${meetingAction}`};
 const actions={next_actions:[
  {...recommendedAction(sellerQuote),reason_source_ids:[sellerAction.id,customerAcceptance.id],expected_outcome:"合意内容の企画書と正式見積書が佐伯へ届く。"},
  {...recommendedAction(supportedOffer),reason_source_ids:[offer.id,adoption.id],expected_outcome:"合意した価格と制作範囲を共有できる。"},
  {...recommendedAction(meetingAction),reason_source_ids:[meeting.id],expected_outcome:"面談候補日に関する双方の空き状況を確認できる。"},
 ]};
 const before=JSON.stringify({minutes:mocks.heavyReply,structured,analysis,topSales,strategy,actions});
 mocks.replies=[structured,analysis,topSales,strategy,actions,{scores:{actionability:5,specificity:5,impact:5}}];
 const result=await pipeline.runPipeline(transcript,{...ctx,companyName:specification.companyName,dealTitle:"合意済み条件の保持"});
 assert.equal(mocks.replies.length,0);
 assert.equal(JSON.stringify({minutes:mocks.heavyReply,structured,analysis,topSales,strategy,actions}),before,"provider drafts remain immutable");
 assert.equal(result.topSales.winning_scenario,supportedOffer,"seller-confirmed price and scope must survive the offer guard");
 assert.equal(result.strategy.closing_plan,strategy.closing_plan);
 assert.equal(result.nextActions.next_actions[0].action,sellerQuote);
 assert.equal(result.nextActions.next_actions[1].action,supportedOffer);
 assert.equal(result.nextActions.next_actions[2].action,meetingAction);
 assert.equal(result.nextActions.next_actions[0].reason,`原文: ${sellerAction.text}\n原文: ${customerAcceptance.text}`);
 assert.deepEqual(Array.from(result.meetingMinutes.json.decisions),decisions,"rejected SNS must remain separate from the adopted video service");
 // The specification permits mentioning the SNS option; it does not require
 // retaining it. The explicit non-adoption decision above must remain intact.
 assert.doesNotMatch(result.strategy.strategy,/SNS運用代行を(?:採用|導入)する/u);
 assert.ok(!result.trace.some(entry=>["evidence_guard_unconfirmed_need","evidence_guard_unverified_offer","evidence_guard_unagreed_deadline"].includes(entry.step)));
 assert.equal(expected.budget.grossJpy,expected.budget.netJpy+expected.budget.taxJpy);
 const minuteAction=result.meetingMinutes.json.next_actions[0];
 assert.deepEqual({
  budget:result.analysis.bant.budget,authority:result.analysis.bant.authority,
  need:result.analysis.bant.need,
  delivery:result.analysis.bant.timeline.includes("2026年12月15日"),
  publication:result.analysis.bant.timeline.includes("2027年1月10日"),
  formalDates:result.analysis.bant.timeline.includes("正式な日程として確定します"),
  meetingCandidateInTimeline:result.analysis.bant.timeline.includes("2026年10月5日"),
  minutesActionCount:result.meetingMinutes.json.next_actions.length,
  minutesAction:minuteAction?.action,minutesOwner:minuteAction?.owner,minutesDue:minuteAction?.due,
 },{
  budget:approvedBudget,authority,need:`文字起こし記載: ${need.text}`,
  delivery:true,publication:true,formalDates:true,meetingCandidateInTimeline:false,
  minutesActionCount:1,minutesAction:sellerQuote,minutesOwner:"営業",minutesDue:due,
 },`Faithful agreed conditions must survive. Timeline=${result.analysis.bant.timeline}; action audit=${JSON.stringify(result.meetingMinutes.actionAudit)}`);
});

test("structured strategy is readable before evidence repairs and keeps fields, labels and numbers", async () => {
 const {pipeline,mocks}=await setup();
 const f=reasoningFixture();
 const transcript="顧客：予算は150万円が目安です。正式承認は未了です。説明内容が伝わりにくいことが課題です。資料の提出期限は未合意です。";
 const original={action:"150万円で提供可能な採用動画を説明する。",reason:"150万円で提供可能な採用動画が課題に合うため。",expected_outcome:"次回面談までに比較情報が得られる。",risks:"確認に時間がかかり、次回面談までに情報が揃わない可能性。"};
 const nested={week1:{reason:"顧客が比較するため。150万円で提供可能なので費用の問題はない。",risks:["確認に時間がかかる。次回面談までに情報が揃わない可能性。","150万円で提供可能なので費用の問題はない。"]}};
 const strategy={strategy:"条件を確認する。",differentiation:"比較情報は未確認。",closing_plan:JSON.stringify([original,nested])};
 mocks.heavyReply=minutesReply("費用と承認状況を確認した。");
 mocks.replies=[f.structured,{...f.analysis,need_source_ids:[1],bant:{...f.analysis.bant,need:"説明内容が伝わりにくいことが課題",budget:"150万円目安・正式未承認"}},
  {...f.topSales,real_intent:"仕事内容を伝えたい"},strategy,{next_actions:[recommendedAction("資料の有無を確認する")]},{scores:{actionability:4,specificity:4,impact:4}}];
 const result=await pipeline.runPipeline(transcript,ctx);
 const formatted=result.trace.find(t=>t.step==="step4_strategy").output.closing_plan;
 assert.ok(formatted.includes(original.action));
 assert.ok(formatted.includes(original.reason));
 assert.doesNotMatch(formatted,/"action"|"reason"|\\n|^\[/);
 assert.match(result.strategy.closing_plan,/行動：.*提供範囲と見積/);
 assert.match(result.strategy.closing_plan,/理由：/);
 assert.match(result.strategy.closing_plan,/期待成果：比較情報が得られる。/);
 assert.match(result.strategy.closing_plan,/リスク：確認に時間がかかり、情報が揃わない可能性。/);
 assert.match(result.strategy.closing_plan,/1週目：理由：顧客が比較するため。各商材の提供範囲と見積が未確認のため/);
 assert.match(result.strategy.closing_plan,/1週目：リスク：確認に時間がかかる。情報が揃わない可能性。/);
 assert.match(result.strategy.closing_plan,/1週目：リスク：各商材の提供範囲と見積が未確認のまま/);
 assert.doesNotMatch(result.strategy.closing_plan,/次回面談までに|"action"|\\n/);
 assert.equal(strategy.closing_plan,JSON.stringify([original,nested]),"raw mock response is not mutated");

 mocks.replies=null;
 mocks.reply={...strategy,closing_plan:[{action:"根拠を確認する。",reason:"条件を正確に保つため。"}]};
 const direct=await pipeline.step4Strategy(f.topSales,f.analysis,ctx,transcript);
 assert.match(direct.closing_plan,/行動：根拠を確認する。/);
 assert.match(direct.closing_plan,/理由：条件を正確に保つため。/);
 mocks.reply={...strategy,closing_plan:"1. 原文を確認する。\n2. 予算に収まる場合に説明する。"};
 assert.equal((await pipeline.step4Strategy(f.topSales,f.analysis,ctx,transcript)).closing_plan,mocks.reply.closing_plan);
});

test("public recommendations preserve candidate dates without turning them into deadlines or promised materials", async () => {
 const {pipeline,mocks}=await setup();
 const f=reasoningFixture();
 const transcript="顧客：仕事内容が伝わりにくいことが課題です。次回の面談は2026年10月15日が候補です。資料の提出期限は未合意です。\n営業：紹介できる事例や利用できる資料があるかは確認が必要です。";
 const topSales={...f.topSales,winning_scenario:"次回の面談候補日である2026年10月15日までに検討材料を準備する。"};
 const strategy={...f.strategy,closing_plan:"5. 次回面談（2026年10月15日候補）までに比較資料を準備する。"};
 const availability={...recommendedAction("利用できる事例や資料の有無と内容を社内で確認し、提示できるか検討する"),expected_outcome:"具体的な事例やデータが提供できるようになり、提案の信頼性が向上する。"};
 const schedule=recommendedAction("面談候補日2026年10月15日の空き状況を確認する");
 mocks.heavyReply=minutesReply("仕事内容の説明が課題。面談日程・資料提出期限は未合意。");
 mocks.replies=[f.structured,{...f.analysis,need_source_ids:[1],bant:{...f.analysis.bant,need:"仕事内容が伝わりにくいことが課題"}},topSales,strategy,{next_actions:[availability,schedule]},{scores:{actionability:4,specificity:4,impact:4}}];
 const result=await pipeline.runPipeline(transcript,ctx);
 assert.equal(result.topSales.winning_scenario,"期限を確認したうえで、検討材料を準備する。");
 assert.equal(result.strategy.closing_plan,"5. 期限を確認したうえで、比較資料を準備する。");
 assert.match(result.nextActions.next_actions[0].expected_outcome,/有無と内容.*提供可否.*確認結果/);
 assert.doesNotMatch(result.nextActions.next_actions[0].expected_outcome,/提供できるようになり/);
 assert.equal(result.nextActions.next_actions[1].action,schedule.action);
 assert.equal(result.trace.find(t=>t.step==="step3_top_sales").output.winning_scenario,topSales.winning_scenario);
 assert.equal(result.trace.find(t=>t.step==="step5_next_actions").output.next_actions[0].expected_outcome,availability.expected_outcome);
 assert.equal(result.trace.find(t=>t.step==="evidence_guard_action_outcome").output.changedIndexes[0],0);
});

test("concrete-need reasoning retains source scope for paired contact, media and cause statements", async () => {
 const {pipeline,mocks}=await setup();
 const f=reasoningFixture();
 const pairs=[
  ["顧客：仕事内容が伝わりにくいことが課題です。社内でも話してみたいです。", "顧客：仕事内容が伝わりにくいことが課題です。社内で確認してから連絡します。"],
  ["顧客：説明会後の移行が課題です。サイトとメールがあります。メールには仕事内容の説明が少ないです。", "顧客：説明会後の移行が課題です。サイトとメールの両方で仕事内容の説明が少ないです。"],
  ["顧客：説明会後の移行と仕事内容の伝え方が課題です。原因は調べていません。", "顧客：説明会後の移行と仕事内容の伝え方が課題です。調査した結果、説明不足が原因だと確認しました。"],
 ];
 for (const transcript of pairs.flat()) {
  const start=mocks.prompts.length;
  const analysis={...f.analysis,need_source_ids:[1],bant:{...f.analysis.bant,need:"仕事内容が伝わりにくいことが課題"}};
  mocks.reply=analysis;await pipeline.step2Analyze(transcript,f.structured,ctx);
  mocks.reply=f.topSales;await pipeline.step3TopSales(transcript,f.structured,analysis,ctx);
  mocks.reply=f.strategy;await pipeline.step4Strategy(f.topSales,analysis,ctx,transcript);
  mocks.reply={next_actions:[recommendedAction("原文の条件を確認する")]};await pipeline.step5NextActions(f.topSales,f.strategy,analysis,ctx,transcript);
  await pipeline.step7SelfImprove(mocks.reply,lowScores,f.topSales,f.strategy,analysis,ctx,transcript);
  for (const prompt of mocks.prompts.slice(start)) {
   assert.ok(includesTranscript(prompt.user,transcript));
   assert.match(prompt.system,/一つについて述べた不足・状態を別の対象へ広げない/);
   assert.match(prompt.system,/二つの課題は因果関係の証明ではない/);
   assert.match(prompt.system,/社内検討や日程未定の発言から/);
   assert.match(prompt.system,/指示中の例文を、顧客が発言した事実や推奨の理由へ転用しない/);
  }
 }
});

test("minutes prompt separates voiced options, unapproved facts and genuine unknowns without adding catalog evidence", async () => {
 const {pipeline,mocks}=await setup();
 const transcript="営業：よくある質問を文章で整理する方法もあります。\n顧客：方法は決めていません。予算の正式承認はまだ取れていません。手元の資料はありませんが、別部署にあるかは分かりません。";
 mocks.heavyReply=minutesReply("方法は未決定。予算の正式承認は未取得。資料は手元になく、別部署での有無は未確認。");
 mocks.heavyReply.parsed.proposals=[{text:"よくある質問を文章で整理する方法を検討する。",source_quote:"よくある質問を文章で整理する方法もあります。",speech_act:"offered_option"}];
 const result=await pipeline.generateMeetingMinutes(transcript,contextWithOfferings);
 assert.ok(includesTranscript(mocks.prompts[0].user,transcript));
 assert.doesNotMatch(mocks.prompts[0].user,/採用動画|SNS運用代行|800000/);
 assert.match(mocks.prompts[0].system,/方法・選択肢・条件付き案/);
 assert.match(mocks.prompts[0].system,/否定された提案/);
 assert.match(mocks.prompts[0].system,/未取得・未承認/);
 assert.match(mocks.prompts[0].system,/実行するとの表明がない限り next_actions へ移さない/);
 assert.deepEqual(Array.from(result.json.proposals),["営業側の検討案：よくある質問を文章で整理する方法もあります。"]);
 assert.equal(result.json.summary,mocks.heavyReply.parsed.summary);
 assert.equal(result.json.next_actions.length,0);
 assert.equal(result.json.decisions.length,0);
});

test("minutes publish grounded option quotes and keep rejected question paraphrases only in audit",async()=>{
 const {pipeline,mocks}=await setup();
 const question="学生からの質問は担当者同士で共有されていますか。";
 const option="撮影できる場合は、動画で仕事を紹介する方法もあります。";
 const transcript=`営業：${question}\n顧客：現在は口頭で共有しています。\n営業：${option}\n顧客：撮影の可否は未確認です。`;
 const candidates=[
  {text:"学生の質問を担当者同士で共有する。",source_quote:question,speech_act:"offered_option"},
  {text:"動画を制作する。",source_quote:option,speech_act:"offered_option"},
 ];
 mocks.heavyReply=minutesReply("質問は現在口頭共有。動画は撮影可否による検討案。");
 mocks.heavyReply.parsed.proposals=candidates;
 const result=await pipeline.generateMeetingMinutes(transcript,ctx);
 assert.deepEqual(Array.from(result.json.proposals),[`営業側の検討案：${option}`]);
 assert.equal(result.proposalAudit.rejected[0].index,0);
 assert.equal(result.proposalAudit.accepted[0].index,1);
 assert.equal(JSON.stringify(result.proposalAudit.candidates),JSON.stringify(candidates));
 assert.doesNotMatch(result.markdown,/学生の質問を担当者同士で共有する。|source_quote|speech_act|offered_option/);
 assert.match(result.markdown,/撮影できる場合は/);
});

test("long scoring keeps original evidence, constrains output and validates all three scores",async()=>{
 const {pipeline,mocks}=await setup();
 const transcript=readFileSync(new URL("./fixtures/uat/t18-long-transcript.txt",import.meta.url),"utf8");
 mocks.reply={scores:{actionability:4,specificity:5,impact:3},explanation:"not part of the stored scores"};
 const result=await pipeline.step6Score({next_actions:[]},transcript);
 assert.equal(JSON.stringify(result),JSON.stringify({scores:{actionability:4,specificity:5,impact:3}}));
 const prompt=mocks.prompts[0];
 assert.ok(prompt.user.includes(transcript));
 assert.equal(prompt.maxTokens,400);
 assert.match(prompt.system,/整数を3つだけ/);
 assert.equal(JSON.stringify(prompt.responseSchema.required),JSON.stringify(["scores"]));
 const schema=prompt.responseSchema.properties.scores;
 assert.equal(schema.required.length,3);
 for(const key of ["actionability","specificity","impact"]){
  assert.equal(schema.properties[key].type,"INTEGER");
  assert.equal(schema.properties[key].minimum,1);
  assert.equal(schema.properties[key].maximum,5);
 }
 assert.equal(pipeline.SCORE_PROMPT_VERSION,"20260924-bounded-scores-v1");
 for(const scores of [{actionability:0,specificity:4,impact:4},{actionability:4,specificity:6,impact:4},{actionability:4,specificity:4.5,impact:4},{actionability:4,specificity:4},{actionability:"4",specificity:4,impact:4}]){
  mocks.reply={scores};
  await assert.rejects(pipeline.step6Score({next_actions:[]},transcript),/採点結果が不正/);
 }
});
test("long structure step receives the entire source but requests bounded evidence instead of retranscribing every turn",async()=>{
 const {pipeline,mocks}=await setup();
 const transcript=readFileSync(new URL("./fixtures/uat/t18-long-transcript.txt",import.meta.url),"utf8");
 await pipeline.step1Structure(transcript,ctx);
 assert.ok(mocks.prompts[0].user.includes(transcript));
 assert.match(mocks.prompts[0].system,/speaker_turns.*最大12件/u);
 assert.match(mocks.prompts[0].system,/全発言の再掲は禁止/u);
 assert.match(mocks.prompts[0].system,/訂正後.*未承認.*条件付き/u);
 assert.equal(mocks.prompts[0].maxTokens,3000,"Keep the existing output/cost limit");
 assert.equal(pipeline.STRUCTURE_PROMPT_VERSION,"20260924-bounded-structure-v2");
});
test("offline minutes distinguish sales questions and unresolved decisions from customer facts",async()=>{
 const{pipeline}=await setup();
 const result=await pipeline.generateMeetingMinutes("営業: 採用に課題があるのではないですか？\n顧客: 現時点では情報交換のみです。\n顧客: 導入は未確定です。\n顧客: 合意していません。",ctx);
 assert.equal(result.usedFallback,true);
 assert.deepEqual(Array.from(result.json.customer_issues),["未確認"]);
 assert.match(result.json.decisions[0],/確認できません/);
 assert.doesNotMatch(result.json.summary,/導入は未確定|合意していません/);
});
test("explicit decision and customer figures survive without numeric embellishment",async()=>{
 const{pipeline}=await setup();
 const result=await pipeline.runPipeline("顧客: 予算は250万円以内です。\n顧客: 面接前辞退35％が課題です。\n顧客: 見積の検討を進めることで合意しました。",ctx);
 assert.match(result.meetingMinutes.json.decisions[0],/合意しました/);
 assert.match(result.analysis.bant.budget,/250万円/);
 assert.match(result.analysis.bant.need,/35％/);
 assert.match(result.analysis.bant.timeline,/未確認|未確定/);
 assert.equal(result.fallback,true);
 assert.equal(result.meetingMinutes.promptVersion,pipeline.MEETING_MINUTES_PROMPT_VERSION);
 const minutesTrace=result.trace.find(item=>item.step==="t05_meeting_minutes");
 assert.equal(minutesTrace.input.promptVersion,result.meetingMinutes.promptVersion);
});
test("low-score regeneration keeps missing deadlines unknown",async()=>{
 const{pipeline,mocks}=await setup();
 const fallback=pipeline.buildEvidenceSafeFallback("顧客: 詳細は未確認です。");
 await pipeline.step7SelfImprove(fallback.nextActions,{scores:{actionability:2,specificity:2,impact:2}},fallback.topSales,fallback.strategy,fallback.analysis,ctx);
 assert.equal(mocks.prompts.length,1);
 assert.match(mocks.prompts[0].system,/期限が不明なら「期限未確認」/);
 assert.doesNotMatch(mocks.prompts[0].system,/すべての action に「期限/);
});

const noProposalTranscript = [
 "営業：新卒採用への応募数が不足しているのではないですか？",
 "顧客：応募数が不足しているかは、まだ集計していないので分かりません。今回は情報交換です。",
 "営業：予算や決裁者、導入時期は決まっていますか？",
 "顧客：いずれも未確認です。導入するかどうかも決めていません。",
 "営業：次回の打ち合わせはいかがでしょうか？",
 "顧客：社内で確認してから連絡します。今日は日程を決められません。",
].join("\n");

const contextWithOfferings = {
 ...ctx,
 dealTitle: "案件タイトルだけにある別の企画",
 industry: "原文にない業界名",
 products: ["採用動画", "SNS運用代行（6ヶ月）"],
 dealProducts: [
  { productName: "採用動画", amount: 800000 },
  { productName: "SNS運用代行（6ヶ月）", amount: 1200000 },
 ],
 pastEdits: [{ aiOutput: "古い提案", userEdit: "採用動画とSNS運用代行（6ヶ月）を次回提案する" }],
};

test("minutes evidence excludes catalog, deal offerings and previous edits absent from the transcript",async()=>{
 const {pipeline,mocks}=await setup();
 mocks.contextText="# 商材カタログ\n- 採用動画 / 基準価格800,000円\n- SNS運用代行（6ヶ月） / 基準価格1,200,000円";
 mocks.heavyReply={parsed:{participants:["営業","顧客"],customer_issues:["未確認"],proposals:[],next_actions:[{action:"社内で確認してから連絡する",owner:"顧客",due:"未確認",source_quote:"社内で確認してから連絡します。"}],decisions:[],summary:"情報交換を実施。応募数、予算、決裁者、導入時期と次回日程は未確認です。"},usedFallback:false};
 const result=await pipeline.generateMeetingMinutes(noProposalTranscript,contextWithOfferings);
 const prompt=mocks.prompts[0];
 assert.equal(mocks.prompts.length,1);
 assert.equal(mocks.contextReads.length,0);
 assert.equal(prompt.cacheableSystem,undefined);
 assert.ok(includesTranscript(prompt.user,noProposalTranscript));
 assert.doesNotMatch(`${prompt.user}\n${prompt.cacheableSystem??""}`,/採用動画|SNS運用代行|800,000|1,200,000|古い提案|案件タイトルだけにある別の企画|原文にない業界名/);
 assert.equal(result.usedFallback,false);
 assert.equal(result.promptVersion,pipeline.MEETING_MINUTES_PROMPT_VERSION);
 assert.deepEqual(Array.from(result.json.proposals),[]);
 assert.deepEqual(Array.from(result.json.decisions),[]);
 assert.equal(result.json.next_actions.length,1);
 assert.equal(result.json.next_actions[0].action,"社内で確認してから連絡します。");
 assert.equal(result.json.next_actions[0].due,"未確認");
 assert.doesNotMatch(result.markdown,/採用動画|SNS運用代行|800,000|1,200,000/);
});

test("offline minutes leave proposals empty when only sales questions and unconfirmed introduction exist",async()=>{
 const {pipeline}=await setup();
 const result=await pipeline.generateMeetingMinutes(noProposalTranscript,contextWithOfferings);
 assert.equal(result.usedFallback,true);
 assert.deepEqual(Array.from(result.json.proposals),[]);
 assert.deepEqual(Array.from(result.json.customer_issues),["未確認"]);
 assert.equal(result.json.next_actions.length,1);
 assert.match(result.json.next_actions[0].action,/社内で確認してから連絡します/);
 assert.doesNotMatch(result.json.next_actions[0].action,/日程|次回|[?？]/);
 assert.equal(result.json.next_actions[0].due,"未確認");
 assert.match(result.json.decisions.join("\n"),/確認できません|未確認/);
 assert.doesNotMatch(result.markdown,/採用動画|SNS運用代行/);
});

test("minutes preserve an explicit proposal without treating its undecided adoption as agreement",async()=>{
 const {pipeline,mocks}=await setup();
 const transcript="営業: 採用動画をご提案します。\n顧客: 提案は受け取りましたが、導入も契約も未確定です。";
 mocks.heavyReply={parsed:{participants:["営業","顧客"],customer_issues:["未確認"],proposals:[{text:"採用動画の提案",source_quote:"採用動画をご提案します。",speech_act:"offered_option"}],next_actions:[],decisions:[],summary:"採用動画の提案を受領。導入と契約は未確定。"},usedFallback:false};
 const result=await pipeline.generateMeetingMinutes(transcript,contextWithOfferings);
 assert.equal(result.usedFallback,false);
 assert.deepEqual(Array.from(result.json.proposals),["営業側の検討案：採用動画をご提案します。"]);
 assert.deepEqual(Array.from(result.json.decisions),[]);
 assert.deepEqual(Array.from(result.json.next_actions),[]);
 assert.match(result.markdown,/採用動画/);
 assert.doesNotMatch(result.markdown,/SNS運用代行/);
});

test("offline minutes retain affirmative sales proposals but not proposal questions or refusals",async()=>{
 const {pipeline}=await setup();
 for (const speaker of ["営業","当社","弊社"]) {
  const proposal=`${speaker}：採用動画をご提案します。`;
  const result=await pipeline.generateMeetingMinutes(`${proposal}\n顧客：導入も契約も未確定です。`,contextWithOfferings);
  assert.deepEqual(Array.from(result.json.proposals),[proposal]);
 }
 for (const transcript of [
  "営業：採用動画をご提案してもよろしいですか？",
  "営業：今日は採用動画を提案しません。",
  "営業：今回は採用動画を提案しない方針です。",
  "営業：採用動画は提案していない状態です。",
  "営業：採用動画を提案する方針ではないです。",
  "顧客：採用動画の提案はまだ受けていません。",
 ]) {
  const result=await pipeline.generateMeetingMinutes(transcript,contextWithOfferings);
  assert.deepEqual(Array.from(result.json.proposals),[],transcript);
 }
});

test("offline minutes do not invent next actions from sales questions or absent commitments",async()=>{
 const {pipeline}=await setup();
 for (const transcript of [
  "営業：予算や決裁者を確認できますか？\n営業：次回の打ち合わせはいかがでしょうか？",
  "顧客：今回は情報交換のみです。",
  "営業：資料は送付しない方針です。",
 ]) {
  const result=await pipeline.generateMeetingMinutes(transcript,ctx);
  assert.deepEqual(Array.from(result.json.next_actions),[],transcript);
 }
});

function minutesReply(summary) {
 return {
  parsed: { participants:["顧客"],customer_issues:[],proposals:[],next_actions:[],decisions:[],summary },
  usedFallback:false,
 };
}

const uncollectedCustomerQuote="応募数が不足しているかは、まだ集計していないので分かりません。";

test("minutes retain the complete customer reason when the model summary omits it",async()=>{
 const {pipeline,mocks}=await setup();
 const generatedSummary="応募数不足の有無は未確認で、情報交換を行った。";
 mocks.heavyReply=minutesReply(generatedSummary);
 for (const speaker of ["顧客","先方","お客様"]) {
  const result=await pipeline.generateMeetingMinutes(`${speaker}：${uncollectedCustomerQuote}今回は情報交換です。`,ctx);
  assert.equal(result.usedFallback,false);
  assert.equal(result.generatedSummary,generatedSummary);
  assert.deepEqual(Array.from(result.sourceCaveats),[uncollectedCustomerQuote]);
  assert.equal(result.json.summary,`${generatedSummary}\n顧客発言（原文）: ${uncollectedCustomerQuote}`);
  assert.ok(result.markdown.includes(result.json.summary));
  assert.equal(mocks.heavyReply.parsed.summary,generatedSummary,"keep the generated response distinguishable from the appended quote");
 }
});

test("customer caveats require an explicit customer and a reason in the same non-question sentence",async()=>{
 const {pipeline,mocks}=await setup();
 const summary="確認事項を記録しました。";
 mocks.heavyReply=minutesReply(summary);
 for (const transcript of [
  `営業：${uncollectedCustomerQuote}`,
  `話者A：${uncollectedCustomerQuote}`,
  uncollectedCustomerQuote,
  "顧客：応募数が不足しているかは、まだ集計していないので分かりませんか？",
  "顧客：応募数はまだ集計していません。予算額は不明です。",
 ]) {
  const result=await pipeline.generateMeetingMinutes(transcript,ctx);
  assert.equal(result.json.summary,summary,transcript);
  assert.equal(result.sourceCaveats,undefined,transcript);
  assert.equal(result.generatedSummary,undefined,transcript);
 }
});

test("confirmed positive and negative customer statements gain no source caveat",async()=>{
 const {pipeline,mocks}=await setup();
 for (const [statement,summary] of [
  ["応募数を集計した結果、応募数が不足していると確認しました。","集計により応募数不足を確認済み。"],
  ["応募数を集計した結果、応募数は不足していないと確認しました。","集計により応募数不足がないことを確認済み。"],
  ["応募数は未集計ですが、不足していることは確認しました。","未集計だが応募数不足は確認済み。"],
  ["応募数は未集計ですが、不足していないことは確認しました。","未集計だが応募数不足がないことは確認済み。"],
 ]) {
  mocks.heavyReply=minutesReply(summary);
  const result=await pipeline.generateMeetingMinutes(`顧客：${statement}`,ctx);
  assert.equal(result.json.summary,summary);
  assert.equal(result.sourceCaveats,undefined);
  assert.doesNotMatch(result.markdown,/顧客発言（原文）/);
 }
});

test("customer caveats are unique, capped at two sentences and not repeated from the model summary",async()=>{
 const {pipeline,mocks}=await setup();
 const second="辞退理由は未調査のため不明です。";
 const third="面接前の辞退率も未集計のため判断できません。";
 mocks.heavyReply=minutesReply("情報交換を行った。");
 const result=await pipeline.generateMeetingMinutes([
  `顧客：${uncollectedCustomerQuote}`,
  `先方：${uncollectedCustomerQuote}`,
  `顧客：${second}${third}`,
 ].join("\n"),ctx);
 assert.deepEqual(Array.from(result.sourceCaveats),[uncollectedCustomerQuote,second]);
 assert.equal(result.json.summary.split(uncollectedCustomerQuote).length-1,1);
 assert.equal(result.json.summary.split("顧客発言（原文）").length-1,2);
 assert.equal(result.json.summary.includes(third),false);

 const summary=`顧客は「${uncollectedCustomerQuote}」と説明しました。`;
 mocks.heavyReply=minutesReply(summary);
 const alreadyQuoted=await pipeline.generateMeetingMinutes(`顧客：${uncollectedCustomerQuote}`,ctx);
 assert.equal(alreadyQuoted.json.summary,summary);
 assert.equal(alreadyQuoted.sourceCaveats,undefined);
});

test("customer caveats preserve a full 300-character sentence and skip longer sentences without truncation",async()=>{
 const {pipeline,mocks}=await setup();
 mocks.heavyReply=minutesReply("集計状況を確認しました。");
 const prefix="応募数は未集計で、";
 const suffix="のため不足かどうか不明です。";
 const atLimit=prefix+"確認中の部署".repeat(60).slice(0,300-prefix.length-suffix.length)+suffix;
 assert.equal(atLimit.length,300);
 const accepted=await pipeline.generateMeetingMinutes(`顧客：${atLimit}`,ctx);
 assert.deepEqual(Array.from(accepted.sourceCaveats),[atLimit]);
 assert.ok(accepted.json.summary.endsWith(atLimit));

 const tooLong=atLimit.replace("応募数", "全応募数");
 assert.equal(tooLong.length,301);
 const shorter="応募人数は未集計のため不明です。";
 const skipped=await pipeline.generateMeetingMinutes(`顧客：${tooLong}${shorter}`,ctx);
 assert.deepEqual(Array.from(skipped.sourceCaveats),[shorter]);
 assert.equal(skipped.json.summary.includes(tooLong.slice(0,100)),false);
 assert.ok(skipped.json.summary.endsWith(shorter));
});

test("minutes trace records the original model summary separately from retained source caveats",async()=>{
 const {pipeline,mocks}=await setup();
 const generatedSummary="応募数不足かは未確認です。";
 mocks.heavyReply=minutesReply(generatedSummary);
 const result=await pipeline.runPipeline(noProposalTranscript,ctx);
 const minutes=result.meetingMinutes;
 const trace=result.trace.find(item=>item.step==="t05_meeting_minutes");
 assert.equal(minutes.generatedSummary,generatedSummary);
 assert.deepEqual(Array.from(minutes.sourceCaveats),[uncollectedCustomerQuote]);
 assert.equal(trace.input.promptVersion,minutes.promptVersion);
 assert.equal(trace.output.generatedSummary,generatedSummary);
 assert.deepEqual(Array.from(trace.output.sourceCaveats),Array.from(minutes.sourceCaveats));
 assert.equal(trace.output.json.summary,minutes.json.summary);
 assert.equal(trace.output.usedFallback,false);
});

test("negated uncollected or unresearched reasons do not become customer caveats",async()=>{
 const {pipeline,mocks}=await setup();
 const summary="集計・調査と確認は完了している。";
 mocks.heavyReply=minutesReply(summary);
 for (const statement of [
  "未集計ではなく、分からない項目もありません。",
  "未調査ではなく、不明な項目もありません。",
  "未集計ではありませんし、分からない項目もありません。",
  "未調査じゃないので、不明な項目もありません。",
 ]) {
  const result=await pipeline.generateMeetingMinutes(`顧客：${statement}`,ctx);
  assert.equal(result.json.summary,summary,statement);
  assert.equal(result.sourceCaveats,undefined,statement);
  assert.equal(result.generatedSummary,undefined,statement);
  assert.doesNotMatch(result.markdown,/顧客発言（原文）/);
 }
});

function reasoningFixture() {
 return {
  structured:{speaker_turns:[],key_facts:[],decisions:[],open_questions:["応募数不足の有無は未集計のため不明"]},
  analysis:{issues:["未確認: 応募数不足の有無は未集計のため不明"],hidden_needs:["未確認"],risks:["未確認"],bant:{budget:"未確認",authority:"未確認",need:"未確認",timeline:"未確認"}},
  topSales:{real_intent:"未確認: 導入自体が未決定",decision_structure:"未確認",risks:["未確認: 失注の兆候を断定できない"],winning_scenario:"仮説: 課題が確認できた場合に、対応候補を顧客と確認する"},
  strategy:{strategy:"顧客からの連絡後に応募数の集計状況を確認する",differentiation:"未確認",closing_plan:"日程は未定のため、顧客に希望を確認する"},
 };
}

function recommendedAction(action) {
 return {action,priority:"medium",impact:"medium",reason:"原文の条件を確認するため",expected_outcome:"確認できた事実と未確認事項を分けて記録する"};
}

const lowScores={scores:{actionability:2,specificity:3,impact:3}};

test("STEP2 receives the source and disallows unsupported low-motivation risk hypotheses",async()=>{
 const {pipeline,mocks}=await setup();
 const f=reasoningFixture();
 const structured={...f.structured,key_facts:["仮説: 導入未決定なので顧客の導入意欲は低い"]};
 mocks.reply={...f.analysis,risks:["仮説: 未確認のまま提案を進めた場合、条件が合わない可能性がある"]};
 const analysis=await pipeline.step2Analyze(noProposalTranscript,structured,ctx);
 assert.equal(mocks.prompts.length,1);
 const prompt=mocks.prompts[0];
 assert.ok(includesTranscript(prompt.user,noProposalTranscript));
 assert.ok(prompt.user.includes(structured.key_facts[0]),"even when earlier AI introduces a hypothesis, the source must take precedence");
 assert.match(prompt.system,/前段のAI分析や過去の編集、見本は顧客の発言の証拠ではない/);
 assert.match(prompt.system,/reason、expected_outcome、risks、winning_scenario にも同じ根拠制約/);
 assert.match(prompt.system,/確認できない顧客の心理・認識・関心・意欲を、推奨の理由やリスクの原因にしない/);
 assert.match(prompt.system,/「仮説」と付けるだけで未確認の課題を存在する前提にすることも不可/);
 assert.match(prompt.system,/未確認の事実と条件付きの懸念を分ける/);
 assert.match(prompt.system,/未確認なのはその数値と不足の有無/);
 assert.match(prompt.system,/顧客ニーズへ昇格させない/);
 assert.equal(analysis.risks[0],mocks.reply.risks[0],"an evidence-qualified conditional risk remains valid model output");
 assert.match(analysis.bant.need,/未確定|未確認/);
});

test("reasoning stages distinguish a customer follow-up plan from mutual agreement without banning outreach",async()=>{
 const {pipeline,mocks}=await setup();
 const f=reasoningFixture();
 const actions={next_actions:[recommendedAction("営業担当が確認事項を準備し、必要なら追加連絡の可否を確認する（期限未確認）")]};
 mocks.reply=f.analysis;
 await pipeline.step2Analyze(noProposalTranscript,f.structured,ctx);
 mocks.reply=f.topSales;
 await pipeline.step3TopSales(noProposalTranscript,f.structured,f.analysis,ctx);
 mocks.reply=f.strategy;
 await pipeline.step4Strategy(f.topSales,f.analysis,ctx,noProposalTranscript);
 mocks.reply=actions;
 const generated=await pipeline.step5NextActions(f.topSales,f.strategy,f.analysis,ctx,noProposalTranscript);
 const rewritten=await pipeline.step7SelfImprove(actions,lowScores,f.topSales,f.strategy,f.analysis,ctx,noProposalTranscript);
 assert.equal(mocks.prompts.length,5);
 for (const [index,prompt] of mocks.prompts.entries()) {
  const step=[2,3,4,5,7][index];
  assert.ok(includesTranscript(prompt.user,noProposalTranscript),`STEP${step} must retain the customer's unilateral plan in the source`);
  assert.match(prompt.system,/顧客の対応予定は原文に明示された行動だけ/,`STEP${step}`);
  assert.match(prompt.system,/片方の予定を双方の合意へ変えない/,`STEP${step}`);
  assert.match(prompt.system,/営業からの連絡を望まないことを推定しない/,`STEP${step}`);
  assert.match(prompt.system,/連絡の制限は明示された場合だけ/,`STEP${step}`);
 }
 assert.equal(generated.next_actions[0].action,actions.next_actions[0].action);
 assert.equal(rewritten.next_actions[0].action,actions.next_actions[0].action);
});

test("reasoning and scoring do not treat an unapproved budget as an offer price for registered products",async()=>{
 const {pipeline,mocks}=await setup();
 const f=reasoningFixture();
 const transcript="顧客：予算は80万円を目安に検討しています。正式承認は未了です。";
 const budgetContext={...ctx,products:["採用動画","SNS運用代行（6ヶ月）"]};
 const structured={speaker_turns:[],key_facts:["予算は80万円が目安。正式承認は未了"],decisions:[],open_questions:["正式承認の状況"]};
 const modelAnalysis={...f.analysis,issues:["未確認: 予算の正式承認"],bant:{...f.analysis.bant,budget:"80万円を目安に検討。正式承認は未了"}};
 const actions={next_actions:[recommendedAction("営業担当が採用動画とSNS運用代行（6ヶ月）の提供範囲と見積を社内確認し、目安80万円（正式承認未了）に収まる場合に顧客へ説明する")]};
 mocks.reply=modelAnalysis;
 const analysis=await pipeline.step2Analyze(transcript,structured,budgetContext);
 mocks.reply=f.topSales;
 await pipeline.step3TopSales(transcript,structured,analysis,budgetContext);
 mocks.reply=f.strategy;
 await pipeline.step4Strategy(f.topSales,analysis,budgetContext,transcript);
 mocks.reply=actions;
 const generated=await pipeline.step5NextActions(f.topSales,f.strategy,analysis,budgetContext,transcript);
 mocks.reply=lowScores;
 await pipeline.step6Score(generated,transcript);
 mocks.reply=actions;
 const rewritten=await pipeline.step7SelfImprove(generated,lowScores,f.topSales,f.strategy,analysis,budgetContext,transcript);
 assert.equal(mocks.prompts.length,6);
 for (const [index,prompt] of mocks.prompts.entries()) {
  const step=`STEP${index+2}`;
  assert.ok(includesTranscript(prompt.user,transcript),`${step} must retain the amount and its unapproved status`);
  for (const product of budgetContext.products) assert.ok(prompt.user.includes(product),`${step} must exercise the named products`);
  assert.match(prompt.system,/顧客の予算・目安額は、当社の価格・見積や提供可否の証拠ではない/,step);
  assert.match(prompt.system,/登録商材名だけでは単価・期間・範囲・組み合わせの総額は分からない/,step);
  assert.match(prompt.system,/提供範囲と見積を社内確認し、顧客の目安予算に収まる場合に説明する/,step);
  assert.match(prompt.system,/reason・expected_outcome・strategy・winning_scenarioにも適用/,step);
  assert.match(prompt.system,/顧客の予算額と未承認という条件はそのまま保持/,step);
 }
 assert.match(mocks.prompts[4].system,/確認していない価格や提供可否を追加していればspecificityを低く評価する/);
 assert.match(mocks.prompts[4].system,/impact:.*顧客の判断や次の確認に必要な情報を得られる/);
 assert.equal(analysis.bant.budget,modelAnalysis.bant.budget);
 assert.equal(generated.next_actions[0].action,actions.next_actions[0].action);
 assert.equal(rewritten.next_actions[0].action,actions.next_actions[0].action);
});

test("every reasoning stage preserves unspecified customer checks and verifies reference resources before using them",async()=>{
 const {pipeline,mocks}=await setup();
 const f=reasoningFixture();
 const analysis={...f.analysis,hidden_needs:["集計支援を希望するか確認が必要"]};
 const topSales={...f.topSales,real_intent:"未確認: 社内確認の内容は原文に明示されていない"};
 const strategy={...f.strategy,strategy:"利用できる事例資料・情報源の有無と内容を社内で確認する。事例が確認でき、顧客の状況に合う場合に資料準備を提案する"};
 const actions={next_actions:[recommendedAction("営業担当が利用できる事例資料・情報源の有無と内容を社内で確認する（期限未確認）")]};
 mocks.heavyReply=minutesReply("応募数は未集計で不足の有無は未確認。顧客は社内確認後に連絡すると述べたが、確認内容と次回日程は未確認。");
 mocks.replies=[f.structured,analysis,topSales,strategy,actions,lowScores,actions];
 const result=await pipeline.runPipeline(noProposalTranscript,ctx);
 assert.equal(mocks.replies.length,0);
 assert.equal(mocks.prompts.length,8);
 for (const [index,prompt] of mocks.prompts.slice(2).entries()) {
  const step=`STEP${index+2}`;
  assert.ok(includesTranscript(prompt.user,noProposalTranscript),`${step} must distinguish separate uncollected data and unspecified internal checks`);
  assert.match(prompt.system,/確認内容は原文に明示がなければ不明/,step);
  assert.match(prompt.system,/別の発言の未集計・未決定を、その確認の対象・予定と結びつけない/,step);
  assert.match(prompt.system,/real_intent・winning_scenario・strategyでも原文の広さを保つ/,step);
  assert.match(prompt.system,/未確認のhidden_needsは支援ニーズがあるという仮説の断定文にせず/,step);
  assert.match(prompt.system,/集計支援を希望するか確認が必要/,step);
  assert.match(prompt.system,/まず「利用できる事例資料・情報源の有無と内容を社内で確認する」/,step);
  assert.match(prompt.system,/事例が確認でき、顧客の状況に合う場合にだけ資料準備や提供/,step);
  assert.match(prompt.system,/社内準備という将来の行動でも、未確認の資料・設備・成果を存在する前提にしない/,step);
 }
 assert.equal(result.trace.find(item=>item.step==="step2_analysis").output.hidden_needs[0],analysis.hidden_needs[0]);
 assert.equal(result.trace.find(item=>item.step==="step3_top_sales").output.real_intent,topSales.real_intent);
 assert.equal(result.trace.find(item=>item.step==="step4_strategy").output.strategy,strategy.strategy);
 assert.equal(result.trace.find(item=>item.step==="step7_self_improved").output.next_actions[0].action,actions.next_actions[0].action);
});

test("strategy, recommendations, scoring and low-score rewrite each receive the original transcript",async()=>{
 const {pipeline,mocks}=await setup();
 const f=reasoningFixture();
 const actions={next_actions:[recommendedAction("営業担当が、顧客の連絡後に応募数の集計状況を確認する（期限未確認）")]};
 mocks.reply=f.strategy;
 await pipeline.step4Strategy(f.topSales,f.analysis,ctx,noProposalTranscript);
 mocks.reply=actions;
 await pipeline.step5NextActions(f.topSales,f.strategy,f.analysis,ctx,noProposalTranscript);
 mocks.reply=lowScores;
 await pipeline.step6Score(actions,noProposalTranscript);
 mocks.reply=actions;
 await pipeline.step7SelfImprove(actions,lowScores,f.topSales,f.strategy,f.analysis,ctx,noProposalTranscript);
 assert.equal(mocks.prompts.length,4);
 for (const prompt of mocks.prompts) {
  assert.ok(includesTranscript(prompt.user,noProposalTranscript),"every stage must see the source, including its unanswered questions and unset schedule");
 }
 assert.doesNotMatch(mocks.prompts[0].system,/フェーズ・週次タイムライン/);
 assert.doesNotMatch(mocks.prompts[2].system,/5=「誰が・いつまでに・何を」が明確/);
});

test("sales reasoning prompts do not inherit factual psychology claims or mandatory example deadlines",async()=>{
 const {pipeline,mocks}=await setup();
 const f=reasoningFixture();
 const actions={next_actions:[recommendedAction("営業担当が応募数の集計状況を確認する（期限未確認）")]};
 mocks.reply=f.topSales;
 const topSales=await pipeline.step3TopSales(noProposalTranscript,f.structured,f.analysis,ctx);
 mocks.reply=actions;
 await pipeline.step5NextActions(topSales,f.strategy,f.analysis,ctx,noProposalTranscript);
 await pipeline.step7SelfImprove(actions,lowScores,topSales,f.strategy,f.analysis,ctx,noProposalTranscript);
 assert.equal(topSales.winning_scenario,f.topSales.winning_scenario);
 assert.match(topSales.winning_scenario,/仮説.*場合/);
 for (const prompt of mocks.prompts) {
  assert.doesNotMatch(prompt.system,/必ず「誰が」「いつまでに」「何を」/);
  assert.doesNotMatch(prompt.system,/を(?:24|48)時間以内に送付|送付後24時間以内のフォローメールを必ず予約/);
  assert.doesNotMatch(prompt.system,/- 決裁者を巻き込めていない|- 興味は薄い／その場で意思決定は取れない/);
  assert.match(prompt.system,/未確認/);
  assert.match(prompt.system,/仮説/);
 }
});

test("recommendation normalization preserves a deadline explicitly stated in the source",async()=>{
 const {pipeline,mocks}=await setup();
 const f=reasoningFixture();
 for (const deadline of ["9月30日までに","48時間以内に"]) {
  const transcript=`営業：${deadline}資料を送付します。\n顧客：承知しました。`;
  const action=recommendedAction(`営業担当が${deadline}資料を送付する`);
  mocks.reply={next_actions:[action]};
  const first=await pipeline.step5NextActions(f.topSales,f.strategy,f.analysis,ctx,transcript);
  const improved=await pipeline.step7SelfImprove(first,lowScores,f.topSales,f.strategy,f.analysis,ctx,transcript);
  assert.equal(first.next_actions[0].action,action.action);
  assert.equal(improved.next_actions[0].action,action.action);
  for (const prompt of mocks.prompts.slice(-2)) assert.ok(includesTranscript(prompt.user,transcript));
 }
});

test("recommendation generation and rewrite preserve an explicitly empty action list",async()=>{
 const {pipeline,mocks}=await setup();
 const f=reasoningFixture();
 mocks.reply={next_actions:[]};
 const generated=await pipeline.step5NextActions(f.topSales,f.strategy,f.analysis,ctx,noProposalTranscript);
 assert.deepEqual(Array.from(generated.next_actions),[]);
 const previous={next_actions:[recommendedAction("営業担当が24時間以内に資料を送付する")]};
 const rewritten=await pipeline.step7SelfImprove(previous,lowScores,f.topSales,f.strategy,f.analysis,ctx,noProposalTranscript);
 assert.ok(rewritten,"an explicitly empty successful rewrite must replace the earlier actions");
 assert.deepEqual(Array.from(rewritten.next_actions),[]);
 assert.equal(mocks.prompts.length,2);
});

test("the pipeline passes the original source through a low-score rewrite and versions each reasoning trace",async()=>{
 const {pipeline,mocks}=await setup();
 const f=reasoningFixture();
 const initialActions={next_actions:[recommendedAction("営業担当が応募数の集計状況を確認する（期限未確認）")]};
 const rewrittenActions={next_actions:[recommendedAction("営業担当が、顧客から連絡を受けた際に集計の実施状況と不足の有無を確認する（期限未確認）")]};
 mocks.heavyReply=minutesReply("応募数不足の有無は未確認で、次回日程は未定です。");
 mocks.replies=[f.structured,f.analysis,f.topSales,f.strategy,initialActions,lowScores,rewrittenActions];
 const result=await pipeline.runPipeline(noProposalTranscript,ctx);
 assert.equal(mocks.replies.length,0);
 assert.equal(mocks.prompts.length,8);
 assert.equal(result.improved,true);
 assert.equal(result.trace.find(item=>item.step==="step7_self_improved").output.next_actions[0].action,rewrittenActions.next_actions[0].action);
 assert.ok(includesTranscript(mocks.prompts.at(-1).user,noProposalTranscript));
 assert.doesNotMatch(JSON.stringify(result.nextActions),/24時間|48時間|今週中/);
 assert.equal(pipeline.SALES_REASONING_PROMPT_VERSION,"20261001-evidence-first-v22");
 // T18 C4・C6（2026-10-01）: 推量を「予定」に強めない、撤回・未定から「再検討」を前提にしない。
 assert.ok(mocks.prompts.some(p=>/「予定」「〜を経て決定される」「進めている」と強めない/.test(p.system)&&/再検討状況を質問する/.test(p.system)));
 for (const step of ["step2_analysis","step3_top_sales","step4_strategy","step5_next_actions","step6_scores","step7_self_improved"]) {
  const trace=result.trace.find(item=>item.step===step);
  assert.ok(trace,step);
  assert.equal(trace.input.promptVersion,pipeline.SALES_REASONING_PROMPT_VERSION,step);
 }
 assert.equal(result.meetingMinutes.promptVersion,pipeline.MEETING_MINUTES_PROMPT_VERSION);
});

test("the display guard replaces unsupported unknown-Need drafts while retaining BANT and conservative scores",async()=>{
 const {pipeline}=await setup();
 const f=reasoningFixture();
 const unsupported="応募数を24時間以内に集計し、成功事例DBから抽出して80万円で両商材を提供する";
 const topSales={real_intent:unsupported,decision_structure:unsupported,risks:[unsupported],winning_scenario:unsupported};
 const strategy={strategy:unsupported,differentiation:unsupported,closing_plan:unsupported};
 const actions={next_actions:[{...recommendedAction(unsupported),reason:unsupported,expected_outcome:unsupported}]};
 const highScores={scores:{actionability:5,specificity:5,impact:5}};
 for (const need of [
  "未確認: 応募数不足の有無は未集計のため不明",
  "応募数が不足しているかは未集計のため分かりません。",
  "仮説: 応募数の集計支援が必要な可能性がある",
  "推測：応募数の集計支援が必要",
  "推定 集計支援が必要",
  "情報交換段階",
 ]) {
  const analysis={...f.analysis,issues:[unsupported],hidden_needs:[unsupported],risks:[unsupported],bant:{
   budget:"80万円を目安に検討。正式承認は未了",authority:"決裁者は山田部長",need,timeline:"2027年3月を希望。未確定",
  }};
  const before=JSON.stringify({analysis,topSales,strategy,actions,highScores});
  const result=pipeline.constrainUnconfirmedNeedRecommendations(analysis,topSales,strategy,actions,highScores);
  assert.equal(result.applied,true,need);
  assert.equal(JSON.stringify({analysis,topSales,strategy,actions,highScores}),before,"AI drafts must remain unchanged for trace evidence");
  for (const key of ["budget","authority","timeline"]) assert.equal(result.analysis.bant[key],analysis.bant[key],`${need}: ${key}`);
  if (need==="情報交換段階") assert.match(result.analysis.bant.need,/^未確定:.*ニーズ課題/);
  else assert.equal(result.analysis.bant.need,need);
  assert.deepEqual(Array.from(result.analysis.hidden_needs),[]);
  const displayed=JSON.stringify({issues:result.analysis.issues,hidden_needs:result.analysis.hidden_needs,risks:result.analysis.risks,topSales:result.topSales,strategy:result.strategy,nextActions:result.nextActions});
  assert.doesNotMatch(displayed,/24時間|成功事例DB|80万円で両商材/);
  assert.match(result.analysis.issues[0],/課題.*未確認/);
  assert.match(result.analysis.risks[0],/確認しないまま提案すると/);
  assert.match(result.topSales.winning_scenario,/対応可能かを確認できた場合/);
  assert.ok(result.nextActions.next_actions.some(item=>/質問を作成/.test(item.action)));
  assert.ok(result.nextActions.next_actions.some(item=>/情報源の有無と内容、商材の価格・提供範囲を社内で確認/.test(item.action)));
  assert.deepEqual(JSON.parse(JSON.stringify(result.scores)),{scores:{actionability:3,specificity:3,impact:2}});
 }
});

test("unknown-Need pipeline keeps raw AI drafts in trace and records the guarded final output without changing minutes or budget conditions",async()=>{
 const {pipeline,mocks}=await setup();
 const f=reasoningFixture();
 const transcript=`顧客：予算は80万円を目安に検討しています。正式承認は未了です。\n顧客：${uncollectedCustomerQuote}今回は情報交換です。\n顧客：決裁者と導入時期は未確認です。導入は決めていません。\n顧客：社内で確認してから連絡します。今日は日程を決められません。`;
 const analysis={...f.analysis,hidden_needs:["応募数を集計する支援が必要"],bant:{...f.analysis.bant,budget:"80万円を目安に検討。正式承認は未了",need:"情報収集"}};
 const topSales={...f.topSales,real_intent:"顧客は応募数を集計して導入判断を終える予定"};
 const strategy={...f.strategy,strategy:"成功事例を社内DBから抽出する"};
 const initial={next_actions:[recommendedAction("営業担当が24時間以内に資料を送付する")]};
 const rewritten={next_actions:[recommendedAction("営業担当が80万円で採用動画とSNS運用代行を提供できると説明する")]};
 const summary="応募数不足の有無は未確認で、顧客からの社内確認後の連絡予定がある。";
 mocks.heavyReply=minutesReply(summary);
 mocks.replies=[f.structured,analysis,topSales,strategy,initial,lowScores,rewritten];
 const result=await pipeline.runPipeline(transcript,contextWithOfferings);
 assert.equal(mocks.replies.length,0);
 assert.equal(result.recommendationGuard,"unconfirmed-need");
 assert.equal(result.structured,f.structured);
 assert.equal(result.meetingMinutes.generatedSummary,summary);
 assert.deepEqual(Array.from(result.meetingMinutes.sourceCaveats),[uncollectedCustomerQuote]);
 assert.equal(result.trace.find(item=>item.step==="t05_meeting_minutes").output.json,result.meetingMinutes.json);
 assert.equal(result.analysis.bant.budget,analysis.bant.budget);
 assert.equal(result.analysis.bant.authority,analysis.bant.authority);
 assert.match(result.analysis.bant.timeline,/未確認|未確定/);
 assert.equal(result.trace.find(item=>item.step==="step2_analysis_draft").output.bant.timeline,analysis.bant.timeline);
 assert.match(result.analysis.bant.need,/^未確定:.*ニーズ課題/);
 assert.equal(analysis.bant.need,"情報収集","normalizing Need must not mutate the provider reply");
 assert.deepEqual(JSON.parse(JSON.stringify(result.trace.find(item=>item.step==="step3_top_sales").output)),topSales);
 assert.deepEqual(JSON.parse(JSON.stringify(result.trace.find(item=>item.step==="step4_strategy").output)),strategy);
 assert.equal(result.trace.find(item=>item.step==="step5_next_actions").output.next_actions[0].action,initial.next_actions[0].action);
 assert.deepEqual(JSON.parse(JSON.stringify(result.trace.find(item=>item.step==="step6_scores").output)),lowScores);
 assert.equal(result.trace.find(item=>item.step==="step7_self_improved").output.next_actions[0].action,rewritten.next_actions[0].action);
 const guard=result.trace.at(-1);
 assert.equal(guard.step,"evidence_guard_unconfirmed_need");
 assert.equal(guard.input.promptVersion,"20261001-evidence-first-v22");
 assert.equal(guard.input.bant.budget,analysis.bant.budget);
 assert.equal(guard.output.applied,true);
 for (const key of ["analysis","topSales","strategy","nextActions","scores"]) assert.equal(guard.output[key],result[key],key);
 assert.deepEqual(JSON.parse(JSON.stringify(result.scores)),{scores:{actionability:3,specificity:3,impact:2}});
 assert.doesNotMatch(JSON.stringify(result.nextActions),/24時間|80万円で採用動画|成功事例を社内DB/);
});

test("a concrete customer Need retains the original recommendations, explicit deadline and scores",async()=>{
 const {pipeline,mocks}=await setup();
 const f=reasoningFixture();
 const transcript="顧客：面接前辞退が35％あることが課題です。改善したいです。\n営業：9月30日までに見積を送付します。\n顧客：お願いします。";
 const analysis={...f.analysis,need_source_ids:[1],bant:{...f.analysis.bant,need:"面接前辞退35％が課題で、改善したい"}};
 const actions={next_actions:[recommendedAction("営業担当が9月30日までに見積を送付する")]};
 const scores={scores:{actionability:5,specificity:5,impact:4}};
 for (const need of [analysis.bant.need,"情報漏洩の可能性を下げたい","仮説検証に必要な顧客ヒアリングの時間を減らしたい"]) {
  const concreteAnalysis={...analysis,bant:{...analysis.bant,need}};
  const constrained=pipeline.constrainUnconfirmedNeedRecommendations(concreteAnalysis,f.topSales,f.strategy,actions,scores);
  assert.equal(constrained.applied,false,need);
  for (const [key,value] of Object.entries({analysis:concreteAnalysis,topSales:f.topSales,strategy:f.strategy,nextActions:actions,scores})) assert.equal(constrained[key],value,`${need}: ${key}`);
 }
 mocks.heavyReply=minutesReply("面接前辞退35％の改善が課題で、9月30日までに見積を送る。");
 mocks.replies=[f.structured,analysis,f.topSales,f.strategy,actions,scores];
 const result=await pipeline.runPipeline(transcript,ctx);
 assert.equal(mocks.replies.length,0);
 assert.equal(result.recommendationGuard,undefined);
 assert.equal(result.trace.some(item=>item.step==="evidence_guard_unconfirmed_need"),false);
 assert.ok(result.analysis.bant.need.includes(transcript.split("\n")[0]));
 assert.deepEqual(JSON.parse(JSON.stringify(result.topSales)),f.topSales);
 assert.deepEqual(JSON.parse(JSON.stringify(result.strategy)),f.strategy);
 assert.equal(result.nextActions.next_actions[0].action,actions.next_actions[0].action);
 assert.deepEqual(JSON.parse(JSON.stringify(result.scores)),scores);
});

test("explicitly unagreed deadlines are removed from final recommendations while provider trace stays intact",async()=>{
 const {pipeline,mocks}=await setup();
 const f=reasoningFixture();
 const transcript="顧客：面接前辞退が35％あることが課題です。\n顧客：次回面談の日程も、資料の提出期限も未合意です。";
 const analysis={...f.analysis,need_source_ids:[1],bant:{...f.analysis.bant,need:"面接前辞退が35％あることが課題です。"}};
 const strategy={...f.strategy,closing_plan:"次回面談までに、改善案を検討する。"};
 const actions={next_actions:[recommendedAction("営業が次回商談の前に改善案を整理する")]};
 const scores={scores:{actionability:4,specificity:4,impact:4}};
 mocks.heavyReply=minutesReply("面接前辞退が課題。提出期限は未合意。");
 mocks.replies=[f.structured,analysis,f.topSales,strategy,actions,scores];
 const result=await pipeline.runPipeline(transcript,ctx);
 assert.equal(result.strategy.closing_plan,"期限を確認したうえで、改善案を検討する。");
 assert.equal(result.nextActions.next_actions[0].action,"営業が期限を確認したうえで、改善案を整理する");
 assert.equal(result.trace.find(t=>t.step==="step4_strategy").output.closing_plan,strategy.closing_plan);
 assert.equal(result.trace.find(t=>t.step==="step5_next_actions").output.next_actions[0].action,actions.next_actions[0].action);
 assert.equal(result.trace.find(t=>t.step==="evidence_guard_unagreed_deadline").output.applied,true);
 assert.equal(strategy.closing_plan,"次回面談までに、改善案を検討する。");
});

test("Timeline inference is replaced before later reasoning, with the raw draft retained for audit",async()=>{
 const {pipeline,mocks}=await setup();
 const f=reasoningFixture();
 const transcript="顧客：制作費は80万円を目安に検討しています。正式な社内承認はまだ取れていません。\n営業：導入することは決まりましたか？\n顧客：導入はまだ決めていません。今日は情報交換です。";
 const unsupported="未確認: 導入時期は未定。今回は情報交換のため、具体的な導入時期の検討段階ではない。";
 const draft={...f.analysis,timeline_source_ids:[3],bant:{...f.analysis.bant,budget:"80万円が目安・正式承認未了",timeline:unsupported}};
 const original=JSON.stringify(draft);
 mocks.heavyReply=minutesReply("制作費は80万円目安で正式承認未了。導入可否は未決定。");
 mocks.replies=[f.structured,draft,f.topSales,f.strategy,{next_actions:[]},{scores:{actionability:5,specificity:5,impact:5}}];
 const result=await pipeline.runPipeline(transcript,ctx);
 assert.equal(result.analysis.bant.timeline,"未確定: 導入時期を確認する必要あり");
 assert.equal(result.analysis.bant.budget,draft.bant.budget);
 assert.equal(JSON.stringify(draft),original,"grounding must not overwrite the provider response");
 const raw=result.trace.find(t=>t.step==="step2_analysis_draft");
 const guard=result.trace.find(t=>t.step==="evidence_guard_timeline");
 assert.equal(raw.output,draft);
 assert.equal(guard.input.rawTimeline,unsupported);
 assert.equal(guard.output.value,result.analysis.bant.timeline);
 assert.equal(result.trace.find(t=>t.step==="step2_analysis").output.bant.timeline,guard.output.value);
 assert.equal(result.trace.find(t=>t.step==="step3_top_sales").input.analysis.bant.timeline,guard.output.value);
 assert.doesNotMatch(mocks.prompts.find(p=>p.system.includes("顧客が明示した意図")).user,/具体的な導入時期の検討段階ではない/);
 assert.deepEqual(Array.from(guard.output.sourceQuotes),[]);
 assert.equal(mocks.replies.length,0,"grounding must not add another AI request");
});

test("STEP2 uses original conditional timing instead of a stronger generated date or an earlier AI claim",async()=>{
 const {pipeline,mocks}=await setup();
 const f=reasoningFixture();
 const quote="顧客：導入はまだ決めていませんが、導入するなら2027年4月を希望します。正式な時期は未確定です。";
 const transcript=`営業：導入時期について教えてください。\n${quote}`;
 const structured={...f.structured,key_facts:["2027年4月の導入が決定した"]};
 const draft={...f.analysis,timeline_source_ids:[2],bant:{...f.analysis.bant,timeline:"2027年4月導入で確定"}};
 mocks.reply=draft;
 const trace=[];
 const result=await pipeline.step2Analyze(transcript,structured,ctx,trace);
 assert.ok(result.bant.timeline.includes(quote));
 assert.doesNotMatch(result.bant.timeline,/導入で確定|導入が決定した/);
 assert.equal(trace.find(t=>t.step==="step2_analysis_draft").output,draft);
 assert.deepEqual(Array.from(trace.find(t=>t.step==="evidence_guard_timeline").output.sourceQuotes),[quote]);
 assert.equal(mocks.prompts.length,1);
});


test("STEP2 removes generated source suffixes before downstream use while retaining the complete raw audit",async()=>{
 const {pipeline,mocks}=await setup();
 const f=reasoningFixture();
 const transcript="営業：予算は？\n顧客：未確認です。\n営業：応募数は？\n顧客：未集計なので不足の有無は分かりません。";
 const draft={...f.analysis,need_source_ids:[4],issues:["未確認 (id: 2, 4)"],hidden_needs:["仮説: 条件の確認 (ids: 2, 4)"],risks:["未確認 (id: 4)"],timeline_source_ids:[],bant:{budget:"未確認 (id: 2)",authority:"未確認 (id: 2)",need:"未確認: 応募数は未集計のため不足の有無が不明 (id: 4)",timeline:"未確認 (id: 2)"}};
 const original=JSON.stringify(draft);
 mocks.reply=draft;
 const trace=[];
 const result=await pipeline.step2Analyze(transcript,f.structured,ctx,trace);
 assert.equal(result.bant.budget,"未確認");
 assert.equal(result.bant.authority,"未確認");
 assert.match(result.bant.need,/未確認|未確定/);
 assert.ok(JSON.stringify(trace.find(t=>t.step==="evidence_guard_need").output).includes("未集計"));
 assert.doesNotMatch(JSON.stringify(result),/\(ids?:/);
 assert.equal(trace.find(t=>t.step==="evidence_guard_source_references").output.cleanedFields,4);
 assert.equal(trace.find(t=>t.step==="step2_analysis_draft").output,draft);
 assert.equal(JSON.stringify(draft),original);
 assert.equal(mocks.prompts.length,1);
});


test("source annotation cleanup does not add failures for nonarray model fields",async()=>{
 const {pipeline,mocks}=await setup();
 const f=reasoningFixture();
 mocks.reply={...f.analysis,issues:"不正な配列形式",hidden_needs:null,risks:42,bant:{...f.analysis.bant,need:123},timeline_source_ids:[]};
 const result=await pipeline.step2Analyze("顧客：未確認です。",f.structured,ctx);
 assert.deepEqual(Array.from(result.issues),[],"Unverified generated issues never pass through");
 assert.equal(result.hidden_needs,null);
 assert.equal(result.risks,42);
 assert.match(result.bant.need,/未確定|未確認/);
});

test("explicit withdrawal removes former amounts and dates from current STEP2 values without losing a concrete Need",async()=>{
 const {pipeline,mocks}=await setup();
 const f=reasoningFixture();
 const transcript="顧客：前回の80万円という予算と2027年4月の導入希望は撤回します。現在、予算と導入時期は未定です。新卒採用の応募数不足という課題は引き続きあります。";
 const draft={...f.analysis,need_source_ids:[1],timeline_source_ids:[1],bant:{...f.analysis.bant,budget:"80万円目安",timeline:"2027年4月希望",need:"新卒採用の応募数不足"}};
 const before=JSON.stringify(draft);
 mocks.reply=draft;
 const trace=[];
 const result=await pipeline.step2Analyze(transcript,f.structured,ctx,trace);
 for(const key of ["budget","timeline"]){
  assert.match(result.bant[key],/未確定/);
  assert.doesNotMatch(result.bant[key],/80万円|2027年4月/);
  assert.equal(trace.find(t=>t.step==="evidence_guard_withdrawal").output[key].quote,transcript);
 }
 assert.match(result.bant.need,/新卒採用の応募数不足という課題は引き続きあります/);
 assert.equal(JSON.stringify(draft),before);
 assert.equal(trace.find(t=>t.step==="step2_analysis_draft").output,draft);
 assert.equal(mocks.prompts.length,1);
 const fallback=pipeline.buildEvidenceSafeFallback(transcript);
 for(const key of ["budget","timeline"]) assert.doesNotMatch(fallback.analysis.bant[key],/80万円|2027年4月/);
});

test("conditional adoption stays literal in minutes and final intent while preserving raw provider intent",async()=>{
 const {pipeline,mocks}=await setup();
 const f=reasoningFixture();
 const quote="導入するなら2027年6月を希望します。";
 const turn=`顧客：予算は120万円を目安に考えています。正式な社内承認はまだ取れていません。${quote}正式な導入時期は未確定です。新卒採用の応募数不足という課題は引き続きあります。`;
 const transcript=`営業：現在の条件を教えてください。\n${turn}`;
 const draft={...f.analysis,need_source_ids:[2],timeline_source_ids:[2],bant:{...f.analysis.bant,need:"新卒採用の応募数不足",budget:"120万円目安・社内承認は未了",timeline:"2027年6月導入希望・未確定"}};
 const topSales={...f.topSales,real_intent:"顧客は2027年6月の導入を検討している。"};
 mocks.heavyReply=minutesReply("予算120万円を目安に2027年6月導入を希望。社内承認と正式時期は未確定。");
 mocks.replies=[f.structured,draft,topSales,f.strategy,{next_actions:[]},{scores:{actionability:5,specificity:5,impact:5}}];
 const result=await pipeline.runPipeline(transcript,ctx);
 assert.ok(result.meetingMinutes.json.summary.includes(quote));
 assert.ok(result.topSales.real_intent.includes(turn));
 assert.doesNotMatch(result.topSales.real_intent,/導入を検討している/);
 assert.equal(result.trace.find(t=>t.step==="step3_top_sales").output.real_intent,topSales.real_intent);
 const guard=result.trace.find(t=>t.step==="evidence_guard_conditional_adoption");
 assert.equal(guard.output.topSales,result.topSales);
 assert.equal(result.analysis.bant.budget,draft.bant.budget);
 assert.match(result.analysis.bant.need,/新卒採用の応募数不足という課題は引き続きあります/);
 assert.equal(mocks.replies.length,0);
});

test("a concrete Need and customer budget cannot establish supplier pricing in final recommendations",async()=>{
 const {pipeline,mocks}=await setup();
 const f=reasoningFixture();
 const transcript="顧客：予算は120万円を目安に考えています。正式な社内承認はまだ取れていません。新卒採用の応募数不足という課題は引き続きあります。";
 const draft={...f.analysis,need_source_ids:[1],bant:{...f.analysis.bant,need:"新卒採用の応募数不足",budget:"120万円目安・正式社内承認は未了",timeline:"未確認"}};
 const unsafe="120万円の目安予算内で提供可能な採用動画やSNS運用代行サービスの内容を提案する。";
 const topSales={...f.topSales,winning_scenario:`課題の詳細を確認する。${unsafe}`};
 const strategy={...f.strategy,closing_plan:unsafe};
 mocks.heavyReply=minutesReply("顧客は新卒採用の応募数不足を課題として述べた。予算は120万円目安で正式社内承認は未取得。");
 mocks.replies=[f.structured,draft,topSales,strategy,{next_actions:[]},{scores:{actionability:5,specificity:5,impact:5}}];
 const result=await pipeline.runPipeline(transcript,contextWithOfferings);
 assert.equal(result.trace.find(t=>t.step==="step3_top_sales").output.winning_scenario,topSales.winning_scenario);
 assert.equal(result.trace.find(t=>t.step==="step4_strategy").output.closing_plan,unsafe);
 assert.match(result.topSales.winning_scenario,/^課題の詳細を確認する。/);
 for(const value of [result.topSales.winning_scenario,result.strategy.closing_plan]) {
  assert.doesNotMatch(value,/120万円の目安予算内で提供可能/);
  assert.match(value,/提供範囲と見積を社内で確認/);
  assert.match(value,/予算に収まる場合/);
 }
 assert.equal(result.analysis.bant.budget,draft.bant.budget);
 assert.match(result.analysis.bant.need,/新卒採用の応募数不足という課題は引き続きあります/);
 const guard=result.trace.find(t=>t.step==="evidence_guard_unverified_offer");
 assert.equal(guard.output.value.topSales,result.topSales);
 assert.equal(guard.output.value.strategy,result.strategy);
 assert.equal(mocks.replies.length,0);
});

test("final literal intent is untouched by recommendation rewriting and earlier guard audits stay immutable",async()=>{
 const {pipeline,mocks}=await setup();
 const f=reasoningFixture();
 const turn="顧客：予算は120万円です。導入するなら2027年6月を希望します。120万円で採用動画を提供できます。課題は未確認です。";
 const draft={...f.analysis,timeline_source_ids:[1],bant:{...f.analysis.bant,need:"未確認",budget:"120万円",timeline:"2027年6月希望"}};
 mocks.heavyReply=minutesReply("導入時期は条件付き希望で、課題は未確認。");
 mocks.replies=[f.structured,draft,f.topSales,f.strategy,{next_actions:[]},{scores:{actionability:5,specificity:5,impact:5}}];
 const result=await pipeline.runPipeline(turn,contextWithOfferings);
 assert.equal(result.topSales.real_intent,`顧客が明示した内容（原文）: ${turn}`);
 const needGuard=result.trace.find(t=>t.step==="evidence_guard_unconfirmed_need");
 assert.match(needGuard.output.topSales.real_intent,/^具体的な顧客課題は未確認/);
 assert.notEqual(needGuard.output.topSales,result.topSales);
 assert.equal(result.trace.find(t=>t.step==="evidence_guard_conditional_adoption").output.topSales,result.topSales);
});

test("already quoted customer intent is restored literally after offer checks with a concrete Need",async()=>{
 const {pipeline,mocks}=await setup();
 const f=reasoningFixture();
 const turn="顧客：予算は120万円です。導入するなら2027年6月を希望します。120万円で採用動画を提供できます。応募数不足が課題です。";
 const intent=`顧客が明示した内容（原文）: ${turn}`;
 const draft={...f.analysis,need_source_ids:[1],timeline_source_ids:[1],bant:{...f.analysis.bant,need:"応募数不足",budget:"120万円",timeline:"2027年6月希望"}};
 mocks.heavyReply=minutesReply("導入時期は条件付き希望で、応募数不足が課題。");
 mocks.replies=[f.structured,draft,{...f.topSales,real_intent:intent},f.strategy,{next_actions:[]},{scores:{actionability:5,specificity:5,impact:5}}];
 const result=await pipeline.runPipeline(turn,contextWithOfferings);
 assert.equal(result.topSales.real_intent,intent);
 assert.equal(result.trace.find(t=>t.step==="step3_top_sales").output.real_intent,intent);
 assert.equal(result.trace.find(t=>t.step==="evidence_guard_unconfirmed_need"),undefined);
 const offer=result.trace.find(t=>t.step==="evidence_guard_unverified_offer");
 assert.ok(offer.output.changedPaths.includes("topSales.real_intent"));
 assert.notEqual(offer.output.value.topSales.real_intent,intent);
 assert.equal(result.trace.find(t=>t.step==="evidence_guard_conditional_adoption").output.topSales.real_intent,intent);
});


test("issue source projection preserves media scope and the actor in both minutes and reasoning",async()=>{
 const {pipeline,mocks}=await setup();
 const transcript="営業：採用サイトも説明不足ですか？\n顧客：サイトと案内メールがあります。メールには仕事内容の説明が少ないです。\n顧客：学生に会社をよく見せることだけではありません。普通の働き方も伝えたいです。";
 const f=reasoningFixture();
 const draft={...f.analysis,issues:["採用サイトとメールの説明が不足"],issue_source_ids:[1,2,3,99],timeline_source_ids:[]};
 mocks.reply=draft;
 const trace=[];
 const analysis=await pipeline.step2Analyze(transcript,f.structured,ctx,trace);
 assert.equal(analysis.issues.length,2);
 // 公開する課題の文は発言の本文（話者ラベル・内部の前置きなし）。原文全体は監査の sourceText に残る。
 assert.equal(analysis.issues[0],transcript.split("\n")[1].replace(/^顧客：/u,""));
 assert.equal(analysis.issues[1],transcript.split("\n")[2].replace(/^顧客：/u,""));
 assert.doesNotMatch(JSON.stringify(analysis.issues),/採用サイトとメールの説明が不足|学生が/);
 const audit=trace.find(t=>t.step==="evidence_guard_issues").output.audit;
 assert.deepEqual(Array.from(audit.accepted,x=>x.sourceId),[2,3]);
 assert.equal(audit.rejected.length,2);
 assert.equal(trace.find(t=>t.step==="step2_analysis_draft").output,draft);
 mocks.heavyReply=minutesReply("説明の対象と目的を確認した。");
 mocks.heavyReply.parsed.customer_issues=["学生が会社をよく見せる"];
 mocks.heavyReply.parsed.issue_source_ids=[2,3];
 const minutes=await pipeline.generateMeetingMinutes(transcript,ctx);
 assert.equal(JSON.stringify(minutes.json.customer_issues),JSON.stringify(analysis.issues));
 assert.equal(minutes.issueAudit.accepted.length,2);
 assert.doesNotMatch(minutes.markdown,/issue_source_ids|sourceId|学生が/);
 assert.equal(mocks.prompts[0].maxTokens,2500);
 assert.equal(mocks.prompts[1].maxTokens,3000);
});

test("missing source references cannot publish generated issue paraphrases",async()=>{
 const {pipeline,mocks}=await setup();
 const f=reasoningFixture();
 mocks.reply={...f.analysis,issues:["原文にない課題"]};
 const analysis=await pipeline.step2Analyze("顧客：情報交換です。",f.structured,ctx);
 assert.deepEqual(Array.from(analysis.issues),[]);
 mocks.heavyReply=minutesReply("情報交換です。");
 mocks.heavyReply.parsed.customer_issues=["原文にない課題"];
 const minutes=await pipeline.generateMeetingMinutes("顧客：情報交換です。",ctx);
 assert.ok(!minutes.json.customer_issues.includes("原文にない課題"));
 assert.doesNotMatch(minutes.markdown,/原文にない課題/);
});


test("BANT Need uses a primary passage before downstream reasoning and keeps the unsafe draft only in audit",async()=>{
 const {pipeline,mocks}=await setup();
 const f=reasoningFixture();
 const source="顧客：学生に会社をよく見せることだけではありません。普通の働き方も伝えたいです。導入するかは未定です。";
 const unsafe="学生が会社をよく見せることが課題です。(id: 1)";
 const draft={...f.analysis,need_source_ids:[1],issue_source_ids:[1],bant:{...f.analysis.bant,need:unsafe}};
 const trace=[];mocks.reply=draft;
 const analysis=await pipeline.step2Analyze(source,f.structured,ctx,trace);
 assert.equal(analysis.bant.need,`文字起こし記載: ${source}`);
 assert.equal(trace.find(t=>t.step==="step2_analysis_draft").output,draft);
 assert.equal(draft.bant.need,unsafe);
 assert.equal(trace.find(t=>t.step==="evidence_guard_need").output.value,analysis.bant.need);
 mocks.reply=f.topSales;
 await pipeline.step3TopSales(source,f.structured,analysis,ctx);
 assert.doesNotMatch(mocks.prompts[1].user,/学生が会社を|\(id: 1\)/);
 assert.ok(includesTranscript(mocks.prompts[1].user,source));
 assert.equal(mocks.prompts.length,2);
});


test("final action reasons keep source speakers and scope through low-score rewriting",async()=>{
 const {pipeline,mocks}=await setup();const f=reasoningFixture();
 const facts="顧客：直近の数字は確認しました。以前との厳密な比較まではできていません。";
 const option="営業：採用サイトで説明できている部分と、職種別に補った方がよい部分を見比べられるとよさそうです。";
 const need="顧客：仕事内容が伝わりにくいことが課題です。";
 const transcript=[facts,option,need].join("\n");
 const actions={next_actions:[
  {...recommendedAction("過去のデータがあるか確認する"),reason:"顧客は直近のデータしか確認していない。",reason_source_ids:[1]},
  {...recommendedAction("サイトの内容を確認する"),reason:"顧客は採用サイトを見比べたいと発言した。",reason_source_ids:[2]},
 ]};
 mocks.heavyReply=minutesReply("仕事内容の伝わりにくさが課題。");
 mocks.replies=[f.structured,{...f.analysis,need_source_ids:[3]},f.topSales,f.strategy,actions,lowScores,actions];
 const result=await pipeline.runPipeline(transcript,ctx);
 assert.ok(result.nextActions.next_actions[0].reason.includes(facts));
 assert.ok(result.nextActions.next_actions[1].reason.includes(option));
 assert.doesNotMatch(JSON.stringify(result.nextActions),/直近のデータしか|顧客は採用サイトを見比べたい|reason_source_ids/);
 assert.equal(result.trace.find(t=>t.step==="step5_next_actions").output.next_actions[0].reason,actions.next_actions[0].reason);
 assert.equal(result.trace.find(t=>t.step==="step7_self_improved").output.next_actions[1].reason,actions.next_actions[1].reason);
 assert.ok(result.trace.find(t=>t.step==="evidence_guard_action_reasons"));
 assert.equal(result.nextActions.next_actions[0].action,actions.next_actions[0].action);
 for(const prompt of mocks.prompts.filter(p=>p.system.includes("reason_source_ids")))assert.ok(includesTranscript(prompt.user,transcript));
 assert.equal(mocks.replies.length,0);
});


test("UI quoted topics cannot shield a deadline or expose an internal action citation",async()=>{
 const {pipeline,mocks}=await setup();const f=reasoningFixture();
 const transcript=readFileSync(new URL("./fixtures/uat/t18-long-transcript.txt",import.meta.url),"utf8").trim();
 const deadline="顧客が社内確認を進める上で必要となる、「現場の撮影可否」「出演者の調整」「最終決裁者と承認経路の特定」について、確認すべき事項を整理した質問案を作成し、次回の面談までに顧客へ共有する。";
 const internal="顧客が「採用実務の中で続けられる形」を重視している点（id: 39）を踏まえ、提案する解決策の運用負担や更新頻度について、具体的な説明ができるよう準備する。";
 const actions={next_actions:[{...recommendedAction(deadline),reason_source_ids:[25,37]},{...recommendedAction(internal),reason_source_ids:[39]}]};
 const before=JSON.stringify(actions);
 mocks.heavyReply=minutesReply("予算150万円の目安で承認は未取得。導入するなら2027年9月希望。");
 mocks.replies=[f.structured,{...f.analysis,need_source_ids:[4]},f.topSales,f.strategy,actions,lowScores,actions];
 const result=await pipeline.runPipeline(transcript,ctx);
 assert.equal(result.nextActions.next_actions[0].action,deadline.replace("次回の面談までに","期限を確認したうえで、"));
 assert.equal(result.nextActions.next_actions[1].action,internal.replace("（id: 39）",""));
 assert.ok(result.nextActions.next_actions[0].reason.includes("現場を撮影できるかは未確認"));
 assert.ok(result.nextActions.next_actions[1].reason.includes("必要な更新頻度は未定"));
 assert.equal(JSON.stringify(actions),before);
 assert.equal(result.trace.find(t=>t.step==="step7_self_improved").output.next_actions[0].action,deadline);
 assert.ok(result.trace.find(t=>t.step==="evidence_guard_recommendation_references"));
 assert.doesNotMatch(JSON.stringify(result.nextActions),/\(id:|（id:|reason_source_ids|次回の面談までに/);
 assert.equal(mocks.replies.length,0);
});


test("winning scenario keeps causes unverified and cannot turn its meeting candidate into a deadline",async()=>{
 const {pipeline,mocks}=await setup();const f=reasoningFixture();
 const transcript=readFileSync(new URL("./fixtures/uat/t18-long-transcript.txt",import.meta.url),"utf8").trim();
 const opening="まず、顧客の課題である「説明会後に一次面接に進む学生が少ない」「仕事内容の説明が伝わりにくい」という点に焦点を当て、その原因となっている「学生が配属後の仕事内容を想像できない」「担当者によって説明内容が異なる」「実際の仕事の様子が伝わっていない」といった点を解決するための具体的な情報収集と提案を行う。";
 const deadline="次回の面談設定: 顧客の社内調整状況を確認しつつ、次回の面談候補日である2026年10月15日を確定させ、その面談までに顧客が社内で確認できる事項を整理し、必要な情報提供を行う。";
 const topSales={...f.topSales,winning_scenario:opening+"\n"+deadline};
 const actions={next_actions:[{...recommendedAction("辞退理由の集計状況を確認する。"),reason_source_ids:[6]}]};
 const before=JSON.stringify({topSales,actions});
 mocks.heavyReply=minutesReply("条件を確認した。");
 mocks.replies=[f.structured,{...f.analysis,need_source_ids:[4]},topSales,f.strategy,actions,lowScores,actions];
 const result=await pipeline.runPipeline(transcript,ctx);
 assert.doesNotMatch(result.topSales.winning_scenario,/その原因となっている|その面談までに/);
 assert.match(result.topSales.winning_scenario,/2026年10月15日/);
 assert.match(result.topSales.winning_scenario,/期限を確認したうえで/);
 assert.match(result.nextActions.next_actions[0].reason,/学生が辞退した理由の集計まではまだできていません/);
 assert.equal(JSON.stringify({topSales,actions}),before);
 assert.equal(result.trace.find(t=>t.step==="step3_top_sales").output.winning_scenario,topSales.winning_scenario);
 assert.ok(result.trace.find(t=>t.step==="evidence_guard_unverified_cause"));
 assert.equal(mocks.replies.length,0);
});


test("v14 public variants preserve evidence while qualifying delivery, scope and candidate contact",async()=>{
 const {pipeline,mocks}=await setup();const f=reasoningFixture();
 const transcript=readFileSync(new URL("./fixtures/uat/t18-long-transcript.txt",import.meta.url),"utf8").trim();
 const rows=[{"action": "\u9867\u5ba2\u304c\u300c\u63a1\u7528\u30b5\u30a4\u30c8\u3068\u3001\u8aac\u660e\u4f1a\u5f8c\u306b\u9001\u308b\u6848\u5185\u30e1\u30fc\u30eb\u306f\u3042\u308a\u307e\u3059\u3002\u30e1\u30fc\u30eb\u306b\u306f\u5fdc\u52df\u624b\u7d9a\u304d\u306e\u6848\u5185\u3092\u8f09\u305b\u3066\u3044\u307e\u3059\u304c\u3001\u4ed5\u4e8b\u5185\u5bb9\u3092\u8a73\u3057\u304f\u8aac\u660e\u3059\u308b\u6587\u7ae0\u306f\u3042\u307e\u308a\u5165\u3063\u3066\u3044\u307e\u305b\u3093\u300d(15)\u3068\u8ff0\u3079\u305f\u65e2\u5b58\u306e\u60c5\u5831\u7d4c\u8def\u306b\u3064\u3044\u3066\u3001\u73fe\u5728\u306e\u63a1\u7528\u30b5\u30a4\u30c8\u3068\u6848\u5185\u30e1\u30fc\u30eb\u306eURL\u3092\u9867\u5ba2\u306b\u78ba\u8a8d\u3057\u3001\u4ed5\u4e8b\u5185\u5bb9\u306e\u8aac\u660e\u306b\u95a2\u3059\u308b\u8a18\u8f09\u72b6\u6cc1\u3092\u8abf\u67fb\u3059\u308b", "expected_outcome": "\u5b66\u751f\u304c\u8aac\u660e\u4f1a\u5f8c\u306b\u4ed5\u4e8b\u5185\u5bb9\u3092\u78ba\u8a8d\u3067\u304d\u308b\u65e2\u5b58\u306e\u60c5\u5831\u6e90\uff08\u63a1\u7528\u30b5\u30a4\u30c8\u3001\u6848\u5185\u30e1\u30fc\u30eb\uff09\u306e\u73fe\u72b6\u3068\u4e0d\u8db3\u3057\u3066\u3044\u308b\u70b9\u3092\u628a\u63e1\u3057\u3001\u6539\u5584\u63d0\u6848\u306e\u57fa\u790e\u60c5\u5831\u3068\u3067\u304d\u308b\u3002", "reason_source_ids": [15]}, {"action": "\u9867\u5ba2\u304c\u300c\u73fe\u5834\u3092\u64ae\u5f71\u3067\u304d\u308b\u304b\u306f\u672a\u78ba\u8a8d\u3067\u3059\u3057\u3001\u8ab0\u306b\u51fa\u6f14\u3057\u3066\u3082\u3089\u3048\u308b\u304b\u3082\u6c7a\u307e\u3063\u3066\u3044\u307e\u305b\u3093\u300d(25)\u3068\u8ff0\u3079\u305f\u3001\u73fe\u5834\u64ae\u5f71\u306e\u53ef\u5426\u3068\u51fa\u6f14\u8005\u306e\u8abf\u6574\u306b\u3064\u3044\u3066\u3001\u9867\u5ba2\u304c\u793e\u5185\u3067\u78ba\u8a8d\u3092\u9032\u3081\u308b\u305f\u3081\u306b\u5fc5\u8981\u306a\u60c5\u5831\uff08\u64ae\u5f71\u5185\u5bb9\u306e\u5177\u4f53\u4f8b\u3001\u8abf\u6574\u306e\u9032\u3081\u65b9\u3001\u60f3\u5b9a\u3055\u308c\u308b\u64ae\u5f71\u671f\u9593\u306a\u3069\uff09\u3092\u6574\u7406\u3057\u3001\u6b21\u56de\u9762\u8ac7\u6642\u306b\u63d0\u793a\u3067\u304d\u308b\u3088\u3046\u8cc7\u6599\u3092\u6e96\u5099\u3059\u308b", "expected_outcome": "\u9867\u5ba2\u304c\u793e\u5185\u3067\u73fe\u5834\u306e\u64ae\u5f71\u53ef\u5426\u3084\u51fa\u6f14\u8005\u306b\u3064\u3044\u3066\u78ba\u8a8d\u3092\u9032\u3081\u308b\u305f\u3081\u306e\u5177\u4f53\u7684\u306a\u60c5\u5831\u3092\u63d0\u4f9b\u3067\u304d\u3001\u63d0\u6848\u5185\u5bb9\u306e\u5b9f\u73fe\u53ef\u80fd\u6027\u3092\u9ad8\u3081\u308b\u305f\u3081\u306e\u30b9\u30c6\u30c3\u30d7\u3092\u660e\u78ba\u306b\u3067\u304d\u308b\u3002", "reason_source_ids": [25]}, {"action": "\u9867\u5ba2\u304c\u300c\u8cbb\u7528\u306b\u3069\u3053\u307e\u3067\u542b\u3081\u308b\u304b\u306f\u3001\u307e\u3060\u7d30\u304b\u304f\u6574\u7406\u3067\u304d\u3066\u3044\u307e\u305b\u3093\u3002\u516c\u958b\u5f8c\u306b\u4ed5\u4e8b\u5185\u5bb9\u304c\u5909\u308f\u3063\u305f\u3068\u304d\u3001\u5c11\u3057\u76f4\u3057\u305f\u3044\u3060\u3051\u306a\u306e\u306b\u5927\u304d\u306a\u8cbb\u7528\u304c\u304b\u304b\u308b\u3068\u56f0\u308a\u307e\u3059\u3002\u7a0e\u3084\u4ea4\u901a\u8cbb\u306a\u3069\u3082\u542b\u3081\u3001\u898b\u7a4d\u3092\u691c\u8a0e\u3059\u308b\u969b\u306b\u306f\u5185\u8a33\u3092\u77e5\u308a\u305f\u3044\u3067\u3059\u300d(35)\u3068\u8ff0\u3079\u305f\u8cbb\u7528\u5185\u8a33\u306b\u95a2\u3059\u308b\u61f8\u5ff5\u306b\u5bfe\u3057\u3001\u4e00\u822c\u7684\u306a\u898b\u7a4d\u3082\u308a\u9805\u76ee\uff08\u4f01\u753b\u8cbb\u3001\u5236\u4f5c\u8cbb\u3001\u4fee\u6b63\u8cbb\u3001\u4ea4\u901a\u8cbb\u3001\u7a0e\u91d1\u306a\u3069\uff09\u3068\u3001\u305d\u308c\u3089\u304c\u76ee\u5b89\u4e88\u7b97150\u4e07\u5186\u5185\u3067\u3069\u306e\u3088\u3046\u306b\u5909\u52d5\u3059\u308b\u304b\u3092\u8aac\u660e\u3067\u304d\u308b\u3088\u3046\u3001\u898b\u7a4d\u3082\u308a\u9805\u76ee\u3068\u8cbb\u7528\u306e\u76ee\u5b89\u306b\u95a2\u3059\u308b\u8cc7\u6599\u3092\u6e96\u5099\u3059\u308b", "expected_outcome": "\u9867\u5ba2\u304c\u8cbb\u7528\u5185\u8a33\u306b\u3064\u3044\u3066\u62b1\u3048\u308b\u61f8\u5ff5\u3092\u89e3\u6d88\u3057\u3001\u76ee\u5b89\u4e88\u7b97150\u4e07\u5186\u5185\u3067\u3069\u306e\u3088\u3046\u306a\u30b5\u30fc\u30d3\u30b9\u304c\u63d0\u4f9b\u53ef\u80fd\u304b\u3001\u5177\u4f53\u7684\u306a\u30a4\u30e1\u30fc\u30b8\u3092\u6301\u3063\u3066\u3082\u3089\u3046\u3053\u3068\u304c\u3067\u304d\u308b\u3002", "reason_source_ids": [35]}, {"action": "\u9867\u5ba2\u304c\u300c\u79c1\u306f\u63a1\u7528\u5b9f\u52d9\u306e\u62c5\u5f53\u3067\u3001\u4eca\u56de\u306e\u8cbb\u7528\u3092\u6700\u7d42\u6c7a\u88c1\u3059\u308b\u4eba\u306f\u307e\u3060\u78ba\u8a8d\u3067\u304d\u3066\u3044\u307e\u305b\u3093\u3002\u8ab0\u304c\u6700\u7d42\u6c7a\u88c1\u8005\u304b\u3001\u6b63\u5f0f\u306a\u627f\u8a8d\u7d4c\u8def\u306f\u672a\u78ba\u8a8d\u3067\u3059\u300d(37)\u3068\u8ff0\u3079\u305f\u6700\u7d42\u6c7a\u88c1\u8005\u3068\u627f\u8a8d\u7d4c\u8def\u306b\u3064\u3044\u3066\u3001\u9867\u5ba2\u304c\u793e\u5185\u3067\u78ba\u8a8d\u3092\u9032\u3081\u308b\u305f\u3081\u306e\u8cea\u554f\u9805\u76ee\uff08\u78ba\u8a8d\u3059\u3079\u304d\u90e8\u7f72\u3001\u5f79\u8077\u3001\u627f\u8a8d\u306b\u5fc5\u8981\u306a\u60c5\u5831\u306a\u3069\uff09\u3092\u4f5c\u6210\u3057\u3001\u6b21\u56de\u9762\u8ac7\u6642\u306b\u63d0\u793a\u3067\u304d\u308b\u3088\u3046\u6e96\u5099\u3059\u308b", "expected_outcome": "\u9867\u5ba2\u304c\u6700\u7d42\u6c7a\u88c1\u8005\u3068\u627f\u8a8d\u7d4c\u8def\u3092\u793e\u5185\u3067\u78ba\u8a8d\u3059\u308b\u305f\u3081\u306e\u5177\u4f53\u7684\u306a\u30b9\u30c6\u30c3\u30d7\u3092\u63d0\u793a\u3067\u304d\u3001\u4eca\u5f8c\u306e\u5546\u8ac7\u3092\u5186\u6ed1\u306b\u9032\u3081\u308b\u305f\u3081\u306e\u91cd\u8981\u306a\u60c5\u5831\u3092\u5f97\u3089\u308c\u308b\u3002", "reason_source_ids": [37]}, {"action": "\u9867\u5ba2\u304c\u300c\u6b21\u306b\u304a\u8a71\u3057\u3059\u308b\u9762\u8ac7\u306f\u30012026\u5e7410\u670815\u65e5\u3092\u5019\u88dc\u3068\u3057\u3066\u8003\u3048\u3066\u3044\u307e\u3059\u3002\u305f\u3060\u3057\u3001\u793e\u5185\u306e\u4e88\u5b9a\u3092\u78ba\u8a8d\u3059\u308b\u524d\u306a\u306e\u3067\u3001\u307e\u3060\u78ba\u5b9a\u3057\u3066\u3044\u307e\u305b\u3093\u300d(43)\u3068\u8ff0\u3079\u305f\u6b21\u56de\u9762\u8ac7\u306e\u5019\u88dc\u65e5\u3067\u3042\u308b2026\u5e7410\u670815\u65e5\u306b\u3064\u3044\u3066\u3001\u793e\u5185\u30b9\u30b1\u30b8\u30e5\u30fc\u30eb\u3092\u78ba\u8a8d\u3057\u3001\u9867\u5ba2\u3078\u78ba\u5b9a\u306e\u9023\u7d61\u3092\u884c\u3046", "expected_outcome": "\u6b21\u56de\u9762\u8ac7\u306e\u65e5\u7a0b\u3092\u78ba\u5b9a\u3055\u305b\u3001\u7d99\u7d9a\u7684\u306a\u5546\u8ac7\u306e\u6a5f\u4f1a\u3092\u78ba\u4fdd\u3067\u304d\u308b\u3002", "reason_source_ids": [43]}];
 const actions={next_actions:rows.map(row=>({...recommendedAction(row.action),...row}))};
 const topSales={...f.topSales,winning_scenario:"2. \u4e88\u7b97150\u4e07\u5186\uff08\u76ee\u5b89\uff09\u306e\u7bc4\u56f2\u5185\u3067\u3001\u3069\u306e\u3088\u3046\u306a\u89e3\u6c7a\u7b56\u304c\u5b9f\u73fe\u53ef\u80fd\u304b\u3001\u8907\u6570\u306e\u9078\u629e\u80a2\uff08\u52d5\u753b\u5236\u4f5c\u3001\u8cc7\u6599\u4f5c\u6210\u3001\u8aac\u660e\u4f1a\u69cb\u6210\u306e\u898b\u76f4\u3057\u306a\u3069\uff09\u3092\u63d0\u793a\u3057\u3001\u305d\u308c\u305e\u308c\u306e\u8cbb\u7528\u5185\u8a33\u3068\u671f\u5f85\u3055\u308c\u308b\u52b9\u679c\u3092\u8aac\u660e\u3059\u308b\u3002"};
 const strategy={...f.strategy,closing_plan:"3. \u4e88\u7b97\u76ee\u5b89150\u4e07\u5186\u306e\u7bc4\u56f2\u5185\u3067\u3001\u8ab2\u984c\u89e3\u6c7a\u306b\u8cc7\u3059\u308b\u5177\u4f53\u7684\u306a\u9078\u629e\u80a2\uff08\u6620\u50cf\u5236\u4f5c\u3001\u8cc7\u6599\u4f5c\u6210\u3001\u8aac\u660e\u4f1a\u69cb\u6210\u898b\u76f4\u3057\u3001SNS\u904b\u7528\u4ee3\u884c\u306a\u3069\uff09\u3092\u8907\u6570\u63d0\u793a\u3057\u3001\u305d\u308c\u305e\u308c\u306e\u8cbb\u7528\u5185\u8a33\u3068\u671f\u5f85\u3055\u308c\u308b\u52b9\u679c\u3092\u8aac\u660e\u3059\u308b\u3002"};
 const before=JSON.stringify({actions,topSales,strategy});
 mocks.heavyReply=minutesReply("Source-based summary");
 mocks.replies=[f.structured,{...f.analysis,need_source_ids:[4]},topSales,strategy,actions,lowScores,actions];
 const result=await pipeline.runPipeline(transcript,ctx);
 const publicText=JSON.stringify({topSales:result.topSales,strategy:result.strategy,nextActions:result.nextActions});
 assert.doesNotMatch(publicText,/[\u300d\u300f]\s*[\uff08(]\s*[0-9]+\s*[\uff09)]/u);
 assert.doesNotMatch(publicText,/\u6b21\u56de\u9762\u8ac7\u6642\u306b\u63d0\u793a/u);
 assert.doesNotMatch(result.nextActions.next_actions[4].action,/\u78ba\u5b9a\u306e\u9023\u7d61/u);
 assert.match(result.nextActions.next_actions[4].action,/2026\u5e7410\u670815\u65e5/u);
 assert.ok(result.trace.find(t=>t.step==="evidence_guard_recommendation_references"));
 assert.ok(result.trace.find(t=>t.step==="evidence_guard_unagreed_deadline"));
 assert.ok(result.trace.find(t=>t.step==="evidence_guard_unverified_offer"));
 assert.equal(JSON.stringify({actions,topSales,strategy}),before);
 for(let i=0;i<rows.length;i++){
   const quote=rows[i].action.match(/\u300c([^]*?)\u300d/u)?.[1];
   if(quote)assert.ok(result.nextActions.next_actions[i].action.includes(quote),"source quotation stays literal");
   assert.match(result.nextActions.next_actions[i].reason,/^\u539f\u6587/u);
 }
 assert.equal(mocks.replies.length,0);
});


test("parenthesized customer budget cannot establish a feasible offer in the final pipeline",async()=>{
 const {pipeline,mocks}=await setup();const f=reasoningFixture();
 const transcript=readFileSync(new URL("./fixtures/uat/t18-long-transcript.txt",import.meta.url),"utf8").trim();
 const topSales={...f.topSales,winning_scenario:"\u9867\u5ba2\u306e\u8ab2\u984c\u3067\u3042\u308b\u300c\u8aac\u660e\u4f1a\u5f8c\u306b\u4e00\u6b21\u9762\u63a5\u3078\u9032\u3080\u5b66\u751f\u304c\u5c11\u306a\u304f\u3001\u4ed5\u4e8b\u5185\u5bb9\u306e\u8aac\u660e\u304c\u4f1d\u308f\u308a\u306b\u304f\u3044\u300d\u70b9\u306b\u5bfe\u3057\u3001\u5b66\u751f\u304c\u4ed5\u4e8b\u5185\u5bb9\u3092\u7406\u89e3\u3057\u3001\u9078\u8003\u306b\u9032\u3080\u304b\u5224\u65ad\u3067\u304d\u308b\u72b6\u614b\u3092\u76ee\u6307\u3059\u305f\u3081\u306e\u5177\u4f53\u7684\u306a\u60c5\u5831\u6574\u7406\u3068\u3001\u305d\u306e\u89e3\u6c7a\u7b56\u3092\u63d0\u6848\u3059\u308b\u3002\u307e\u305a\u3001\u9867\u5ba2\u304c\u73fe\u5728\u62b1\u3048\u3066\u3044\u308b\u300c\u4ed5\u4e8b\u5185\u5bb9\u306e\u8aac\u660e\u304c\u4f1d\u308f\u308a\u306b\u304f\u3044\u300d\u5177\u4f53\u7684\u306a\u5834\u9762\uff08\u4f8b\uff1a\u691c\u67fb\u5de5\u7a0b\u306e\u8aac\u660e\u3001\u82e5\u624b\u793e\u54e1\u306e\u8aac\u660e\u5185\u5bb9\u306e\u3070\u3089\u3064\u304d\uff09\u3092\u6df1\u6398\u308a\u3057\u3001\u5b66\u751f\u304c\u77e5\u308a\u305f\u3044\u60c5\u5831\u3068\u73fe\u72b6\u306e\u30ae\u30e3\u30c3\u30d7\u3092\u660e\u78ba\u306b\u3059\u308b\u3002\u305d\u306e\u4e0a\u3067\u3001\u73fe\u5834\u306e\u64ae\u5f71\u53ef\u5426\u3084\u51fa\u6f14\u8005\u306e\u8abf\u6574\u3001\u627f\u8a8d\u7d4c\u8def\u306e\u78ba\u8a8d\u3092\u9867\u5ba2\u306b\u4fc3\u3057\u3001\u305d\u308c\u3089\u306e\u60c5\u5831\u304c\u5f97\u3089\u308c\u305f\u6bb5\u968e\u3067\u3001\u4e88\u7b97\uff08150\u4e07\u5186\uff09\u5185\u3067\u5b9f\u73fe\u53ef\u80fd\u306a\u5177\u4f53\u7684\u306a\u63d0\u6848\uff08\u4f8b\uff1a\u63a1\u7528\u52d5\u753b\u3001\u3088\u304f\u3042\u308b\u8cea\u554f\u306e\u6587\u7ae0\u5316\u3001\u8aac\u660e\u4f1a\u306e\u69cb\u6210\u5909\u66f4\u306a\u3069\u3001\u52d5\u753b\u4ee5\u5916\u306e\u9078\u629e\u80a2\u3082\u542b\u3080\uff09\u3092\u8907\u6570\u63d0\u793a\u3059\u308b\u3002\u63d0\u6848\u306f\u3001\u5236\u4f5c\u3060\u3051\u3067\u306a\u304f\u3001\u516c\u958b\u5f8c\u306e\u66f4\u65b0\u3084\u904b\u7528\u306b\u3064\u3044\u3066\u3082\u8003\u616e\u3057\u305f\u5185\u5bb9\u3068\u3057\u3001\u9867\u5ba2\u306e\u904b\u7528\u8ca0\u62c5\u3092\u8efd\u6e1b\u3067\u304d\u308b\u3088\u3046\u306a\u9032\u3081\u65b9\u3092\u691c\u8a0e\u3059\u308b\u3002\u671f\u9650\u3092\u78ba\u8a8d\u3057\u305f\u3046\u3048\u3067\u3001\u5f53\u793e\u3067\u63d0\u4f9b\u3067\u304d\u308b\u4e8b\u4f8b\u3084\u8cc7\u6599\u306e\u6709\u7121\u3092\u78ba\u8a8d\u3057\u3001\u9867\u5ba2\u306e\u72b6\u6cc1\u306b\u5408\u308f\u305b\u305f\u60c5\u5831\u63d0\u4f9b\u304c\u3067\u304d\u308b\u3088\u3046\u6e96\u5099\u3059\u308b\u3002"};
 const strategy={...f.strategy,closing_plan:"1. \u9867\u5ba2\u306e\u8ab2\u984c\u300c\u4ed5\u4e8b\u5185\u5bb9\u306e\u8aac\u660e\u304c\u4f1d\u308f\u308a\u306b\u304f\u3044\u300d\u5177\u4f53\u7684\u306a\u5834\u9762\uff08\u4f8b\uff1a\u691c\u67fb\u5de5\u7a0b\u3001\u82e5\u624b\u793e\u54e1\u306e\u8aac\u660e\u5185\u5bb9\u306e\u3070\u3089\u3064\u304d\uff09\u306b\u3064\u3044\u3066\u3001\u5b66\u751f\u304c\u77e5\u308a\u305f\u3044\u60c5\u5831\u3068\u73fe\u72b6\u306e\u30ae\u30e3\u30c3\u30d7\u3092\u3055\u3089\u306b\u6df1\u6398\u308a\u3059\u308b\u8cea\u554f\u3092\u6e96\u5099\u3059\u308b\u3002\n2. \u9867\u5ba2\u304c\u793e\u5185\u3067\u78ba\u8a8d\u3059\u3079\u304d\u4e8b\u9805\uff08\u73fe\u5834\u306e\u64ae\u5f71\u53ef\u5426\u3001\u51fa\u6f14\u8005\u306e\u8abf\u6574\u3001\u6700\u7d42\u6c7a\u88c1\u8005\u3068\u627f\u8a8d\u7d4c\u8def\uff09\u306b\u3064\u3044\u3066\u3001\u78ba\u8a8d\u306e\u9032\u6357\u72b6\u6cc1\u3092\u30d2\u30a2\u30ea\u30f3\u30b0\u3059\u308b\u3002\n3. \u5f53\u793e\u3067\u63d0\u4f9b\u53ef\u80fd\u306a\u4e8b\u4f8b\u8cc7\u6599\u3084\u3001\u9867\u5ba2\u306e\u8ab2\u984c\u89e3\u6c7a\u306b\u5f79\u7acb\u3064\u60c5\u5831\u63d0\u4f9b\u624b\u6bb5\uff08\u52d5\u753b\u3001\u6587\u7ae0\u3001\u8aac\u660e\u4f1a\u69cb\u6210\u6539\u5584\u306a\u3069\uff09\u306e\u5177\u4f53\u7684\u306a\u6848\u3092\u8907\u6570\u691c\u8a0e\u3057\u3001\u305d\u308c\u305e\u308c\u306e\u30e1\u30ea\u30c3\u30c8\u30fb\u30c7\u30e1\u30ea\u30c3\u30c8\u3001\u6982\u7b97\u8cbb\u7528\u3001\u904b\u7528\u65b9\u6cd5\u3092\u6574\u7406\u3059\u308b\u3002\n4. \u6b21\u56de\u9762\u8ac7\uff082026\u5e7410\u670815\u65e5\u5019\u88dc\uff09\u306b\u3066\u3001\u4e0a\u8a181,2\u306e\u30d2\u30a2\u30ea\u30f3\u30b0\u7d50\u679c\u3092\u8e0f\u307e\u3048\u30013\u3067\u6e96\u5099\u3057\u305f\u5177\u4f53\u7684\u306a\u6848\u3092\u63d0\u793a\u3057\u3001\u9867\u5ba2\u306e\u4e88\u7b97\uff08150\u4e07\u5186\uff09\u5185\u3067\u5b9f\u73fe\u53ef\u80fd\u306a\u7bc4\u56f2\u3068\u3001\u5c0e\u5165\u5f8c\u306e\u904b\u7528\u8ca0\u62c5\u8efd\u6e1b\u7b56\u306b\u3064\u3044\u3066\u8b70\u8ad6\u3059\u308b\u3002\n5. \u9867\u5ba2\u304c\u793e\u5185\u691c\u8a0e\u3092\u9032\u3081\u308b\u4e0a\u3067\u5fc5\u8981\u306a\u60c5\u5831\uff08\u8cbb\u7528\u5185\u8a33\u3001\u5c0e\u5165\u30b9\u30b1\u30b8\u30e5\u30fc\u30eb\u6848\u306a\u3069\uff09\u3092\u30d2\u30a2\u30ea\u30f3\u30b0\u3057\u3001\u63d0\u4f9b\u3067\u304d\u308b\u3088\u3046\u6e96\u5099\u3059\u308b\u3002"};
 const actions={next_actions:[{...recommendedAction("\u6b21\u56de\u9762\u8ac7\uff082026\u5e7410\u670815\u65e5\u5019\u88dc\uff09\u306b\u3066\u3001\u9867\u5ba2\u306e\u793e\u5185\u78ba\u8a8d\u72b6\u6cc1\u3068\u3001\u5b66\u751f\u304b\u3089\u306e\u8cea\u554f\u5185\u5bb9\u306e\u8a73\u7d30\u3092\u30d2\u30a2\u30ea\u30f3\u30b0\u3059\u308b\u3002\u305d\u306e\u5f8c\u3001\u6e96\u5099\u3057\u305f\u5177\u4f53\u7684\u306a\u63d0\u6848\u6848\u3092\u63d0\u793a\u3057\u3001\u9867\u5ba2\u306e\u4e88\u7b97\uff08150\u4e07\u5186\uff09\u5185\u3067\u5b9f\u73fe\u53ef\u80fd\u306a\u7bc4\u56f2\u3068\u3001\u5c0e\u5165\u5f8c\u306e\u904b\u7528\u8ca0\u62c5\u8efd\u6e1b\u7b56\u306b\u3064\u3044\u3066\u8b70\u8ad6\u3059\u308b\u3002"),reason_source_ids:[39,43]}]};
 const before=JSON.stringify({topSales,strategy,actions});
 mocks.heavyReply=minutesReply("Source-based summary");
 mocks.replies=[f.structured,{...f.analysis,need_source_ids:[4]},topSales,strategy,actions,lowScores,actions];
 const result=await pipeline.runPipeline(transcript,ctx);
 for(const text of [result.topSales.winning_scenario,result.strategy.closing_plan,result.nextActions.next_actions[0].action]){
   assert.doesNotMatch(text,/\u4e88\u7b97[\uff08(]150\u4e07\u5186[\uff09)]\u5185\u3067\u5b9f\u73fe\u53ef\u80fd/u);
   assert.match(text,/\u63d0\u4f9b\u7bc4\u56f2.*\u898b\u7a4d.*\u793e\u5185/u);
 }
 assert.equal(JSON.stringify({topSales,strategy,actions}),before);
 assert.match(result.nextActions.next_actions[0].reason,/2026\u5e7410\u670815\u65e5/u);
 assert.ok(result.trace.find(t=>t.step==="evidence_guard_unverified_offer"));
 assert.equal(mocks.replies.length,0);
});
