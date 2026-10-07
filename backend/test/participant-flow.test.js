const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const {ExperimentFlow}=require("../experiment_flow");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"participant-unit-"));
const read=p=>fs.existsSync(p)?JSON.parse(fs.readFileSync(p)):null;
const write=(p,v)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(v));};
const sessionDir=s=>path.join(root,s);
const trials=new Map(),sessions=new Map(),logs=[],notifications=[],analyses=new Map();
let trialN=0;
const config=require("../experiment_flow_config.json");
const d={sessionDir,read,write,config,planDir:path.join(root,"plans"),prepareReference(){},
  loadTrial:(s,t)=>trials.get(t),saveTrial:(s,t)=>trials.set(t.trialId,t),loadSession:s=>sessions.get(s),saveSession:s=>sessions.set(s.sessionId,s),
  notify:(s,e)=>notifications.push(e),log:(s,t,events)=>logs.push(...events),sharePhoto(){},photoUrl:(s,p)=>`/${p}`,analysis:(s,id)=>analyses.get(id),
  createTrial(s,item,index,totalTrials){const trial={trialId:`t${++trialN}`,sessionId:s,conditionId:item.condition,trialIndex:index,totalTrials,isPractice:item.isPractice,maximumCaptureCount:item.maximumCaptureCount,guideId:"g",guidanceProtocolVersion:"progressive-v1",state:"configured"};trials.set(trial.trialId,trial);return trial;},runAnalysis(){}};
const item=c=>({condition:c,sourceSessionId:"source",referenceImageId:`r${c}`});
write(path.join(d.planDir,"p.json"),{planId:"P01",pairId:"P01",maximumCaptureCount:2,practice:item("C"),trials:[item("A"),item("B"),item("C")]});
let flow=new ExperimentFlow(d);const f=flow.start("P01","unit_test_start_key_123456789");const sid=f.sessionId,tokens=f.tokens;
const state=r=>flow.snapshot(sid,tokens[r]);
function ack(role){const s=state(role);flow.acknowledge(sid,tokens[role],{trialId:s.trialId,captureSequence:s.currentCaptureSequence,phase:s.experimentPhase});}
function ackBoth(){ack("subject");ack("photographer");}
function capture(){const s=state("subject"),c=flow.begin(sid,tokens.photographer,{trialId:s.trialId,requestId:`request_${Date.now()}_${Math.random().toString().slice(2)}`,captureTimestamp:Date.now()});flow.captured(sid,`photo_${c.captureSequence}.jpg`,c);const result={trialId:s.trialId,captureSequence:c.captureSequence,analysisId:`a${c.captureSequence}`,analysisStatus:"completed",photographerGuidance:[{type:"p",message:"右へ"},{type:"p",message:"近づく"}],subjectGuidance:[{type:"s",message:"腕を上へ"}],ready:{captureReady:false}};analyses.set(result.analysisId,result);flow.analysisDone(sid,result);return state("subject");}
function evaluate(role,retake){const s=state(role);flow.evaluate(sid,tokens[role],{trialId:s.trialId,captureSequence:s.currentCaptureSequence,similarityRating:role==="subject"?2:6,satisfactionRating:role==="subject"?3:7,wantsRetake:retake});}
function questionnaire(role){const s=state(role);flow.questionnaire(sid,tokens[role],{trialId:s.trialId,answers:Object.fromEntries(s.questions.map(q=>[q.id,5])),comment:""});}
try {
  assert.equal(flow.start("P01","unit_test_start_key_123456789").sessionId,sid);
  ackBoth();assert.equal(state("subject").experimentPhase,"trialIntroduction");assert.equal(state("subject").isPractice,true);
  ackBoth();ackBoth();assert.equal(state("subject").experimentPhase,"capture");
  const before=state("subject");
  const pending=flow.begin(sid,tokens.photographer,{trialId:before.trialId,requestId:"upload_lost"});
  flow.retryUpload(sid,tokens.photographer,{trialId:before.trialId,captureSequence:pending.captureSequence});
  assert.equal(state("subject").captureCount,0);
  assert.throws(()=>flow.captured(sid,"late.jpg",pending),/古い写真/);
  const first=capture();evaluate("photographer",false);
  assert.equal(state("photographer").viewPhase,"waitingForPartnerEvaluation");
  assert.equal(state("subject").viewPhase,"photoEvaluation");
  assert.ok(!JSON.stringify(state("subject")).includes("similarityRating"));
  assert.equal(state("subject").guidance.length,0);
  const count=logs.filter(e=>e.eventType==="photographer_evaluation_submitted").length;
  evaluate("photographer",false);assert.equal(logs.filter(e=>e.eventType==="photographer_evaluation_submitted").length,count);
  evaluate("subject",true);assert.equal(state("subject").experimentPhase,"guidance");
  assert.ok(!JSON.stringify(notifications).includes("satisfactionRating"));
  assert.equal(state("subject").ready,null);
  const stored=flow.load(sid);stored.config.showReadyToParticipants=true;flow.save(stored);
  assert.equal(state("subject").ready.captureReady,false);
  stored.config.showReadyToParticipants=false;flow.save(stored);
  assert.equal(analyses.get(`a${first.currentCaptureSequence}`).ready.captureReady,false);
  // Recreate the controller to simulate process restart and recover the same persisted phase.
  flow=new ExperimentFlow(d);assert.equal(state("subject").experimentPhase,"guidance");
  flow.analysisDone(sid,{trialId:"wrong",captureSequence:first.currentCaptureSequence,analysisStatus:"failed"});assert.equal(state("subject").experimentPhase,"guidance");
  ackBoth();assert.equal(state("subject").experimentPhase,"capture");assert.equal(state("subject").isLastCapture,true);
  capture();evaluate("subject",true);evaluate("photographer",true);
  assert.equal(state("subject").completionReason,"maximum_capture_count");assert.equal(state("subject").experimentPhase,"trialQuestionnaire");
  questionnaire("subject");questionnaire("subject");assert.equal(state("subject").questionnaireSubmitted,true);questionnaire("photographer");
  assert.equal(state("subject").experimentPhase,"trialCompleted");ackBoth();assert.equal(state("subject").trialIndex,1);
  for(const condition of ["A","B","C"]) {
    ackBoth();ackBoth();capture();evaluate("subject",false);evaluate("photographer",false);
    assert.equal(state("subject").completionReason,"mutual_finish");
    assert.equal(state("subject").questions.length,condition==="A"?4:8);
    questionnaire("photographer");questionnaire("subject");ackBoth();
  }
  assert.equal(state("subject").experimentPhase,"experimentCompleted");
  assert.throws(()=>flow.snapshot(sid,"wrong"),/参加用/);
  const second=flow.start("P01","withdraw_test_start_key_12345"),s2=second.sessionId;
  for(let i=0;i<3;i++)for(const role of ["subject","photographer"]){const snap=flow.snapshot(s2,second.tokens[role]);flow.acknowledge(s2,second.tokens[role],{trialId:snap.trialId,captureSequence:snap.currentCaptureSequence,phase:snap.experimentPhase});}
  const st=flow.snapshot(s2,second.tokens.subject),c=flow.begin(s2,second.tokens.photographer,{trialId:st.trialId,requestId:"failed_analysis"});flow.captured(s2,"kept-photo.jpg",c);
  flow.analysisDone(s2,{trialId:st.trialId,captureSequence:c.captureSequence,analysisId:"failed-id",analysisStatus:"failed",errorReason:"model_failed"});
  assert.equal(flow.snapshot(s2,second.tokens.subject).viewPhase,"photoEvaluation");
  assert.equal(flow.capture(flow.load(s2)).analysisFailureReason,"model_failed");
  flow.evaluate(s2,second.tokens.subject,{trialId:st.trialId,captureSequence:c.captureSequence,similarityRating:4,satisfactionRating:5,wantsRetake:true});
  const beforeWithdraw=read(flow.capturePath(flow.load(s2)));
  assert.throws(()=>flow.withdraw(s2,second.tokens.subject,{confirm:false}),/確認/);
  flow.withdraw(s2,second.tokens.subject,{confirm:true});
  assert.deepEqual(read(flow.capturePath(flow.load(s2))),beforeWithdraw);
  assert.equal(flow.load(s2).experimentStatus,"withdrawn");assert.equal(flow.trial(flow.load(s2)).state,"incomplete");
  assert.throws(()=>flow.begin(s2,second.tokens.photographer,{trialId:st.trialId,requestId:"after_withdraw"}),/終了済み/);
  flow.reset(s2,second.tokens.subject);assert.equal(flow.snapshot(s2,second.tokens.photographer).participantReset,true);
  const third=flow.start("P01","new_pair_start_key_12345678");assert.notEqual(third.sessionId,s2);assert.equal(third.experimentPhase,"experimentIntroduction");
  console.log("participant flow unit passed: withdrawal preserves data, reset signals both roles, Ready policy, analysis failure; full practice + A/B/C, independent and duplicate evaluations, mutual/one-retake/max, questionnaires, restart, stale results");
}finally{fs.rmSync(root,{recursive:true,force:true});}
