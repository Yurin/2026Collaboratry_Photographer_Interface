const fs = require("node:fs");
const path = require("node:path");
const {randomUUID} = require("node:crypto");
const {loadPlans,inspectPlan}=require("./experiment_validation");
const ROLES = ["photographer", "subject"];
const both = (values) => ROLES.every(r => values?.[r]);
const assert = (condition, message, statusCode = 409) => { if (!condition) throw Object.assign(new Error(message), {statusCode}); };
const id = v => typeof v === "string" && /^[a-zA-Z0-9_-]+$/.test(v);
const rating = v => Number.isInteger(v) && v >= 1 && v <= 7;

class ExperimentFlow {
  constructor(d) { this.d = d; this.jobs = new Set(); }
  dir(s) { return path.join(this.d.sessionDir(s), "experiment"); }
  flowPath(s) { return path.join(this.dir(s), "flow.json"); }
  load(s) { return this.d.read(this.flowPath(s)); }
  save(f) { f.revision += 1; f.updatedAt = Date.now(); this.d.write(this.flowPath(f.sessionId), f); }
  trial(f) { return this.d.loadTrial(f.sessionId, f.trialIds[f.trialIndex]); }
  capturePath(f, seq = f.currentCaptureSequence) { return path.join(this.dir(f.sessionId), "trials", this.trial(f).trialId, "evaluations", `capture_${seq}.json`); }
  capture(f) { return f.currentCaptureSequence == null ? null : this.d.read(this.capturePath(f)); }
  writeCapture(f, c) { this.d.write(this.capturePath(f, c.captureSequence), c); }
  questionnairePath(f) { return path.join(this.dir(f.sessionId), "trials", this.trial(f).trialId, "questionnaire.json"); }
  role(f, token) { const role = ROLES.find(r => token && f.tokens[r] === token); assert(role, "参加用リンクを開き直してください", 403); return role; }
  event(f, type, role = "system", payload = {}, c = this.capture(f)) {
    const trial = this.trial(f);
    this.d.log(f.sessionId, trial.trialId, [{eventId: `${f.sessionId}_${f.revision}_${type}_${role}_${c?.captureSequence || 0}_${["client_operation","operation_failed","duplicate_submission"].includes(type)?randomUUID():""}`, role, eventType: type,
      payload: {participantPairId:f.pairId, experimentSessionId:f.sessionId, flowProtocolVersion:f.flowProtocolVersion,
        sessionId:f.sessionId,trialId:trial.trialId,conditionId:trial.conditionId,guidanceProtocolVersion:trial.guidanceProtocolVersion,
        captureSequence:c?.captureSequence ?? null, photoId:c?.photoId ?? null, analysisId:c?.analysisId ?? null, timestamp:Date.now(), ...payload}}]);
  }
  publish(f) { this.d.notify(f.sessionId, {type:"experiment-flow-updated", sessionId:f.sessionId, revision:f.revision}); }
  transition(f, phase) { const from=f.experimentPhase; f.experimentPhase = phase; f.acknowledgements = {}; this.event(f,"state_transition","system",{from,to:phase}); }
  terminal(f) { return ["experimentCompleted","withdrawn","technical_failure","researcher_terminated"].includes(f.experimentPhase); }
  quality(f) { try { this.d.quality?.(f.sessionId); } catch { this.event(f,"quality_report_failed","system",{outcome:"failed"}); } }
  diagnostic(s,token,b) {
    const f=this.load(s);assert(f,"実験が見つかりません",404);const role=this.role(f,token);
    assert(["experiment_resume","websocket_reconnect","evaluation_submit","questionnaire_submit"].includes(b.operation),"invalid operation",400);
    assert(["success","failed"].includes(b.outcome),"invalid outcome",400);
    this.event(f,"client_operation",role,{operation:b.operation,outcome:b.outcome});
  }
  reset(s,token) {
    const f=this.load(s);assert(f,"実験が見つかりません",404);const role=this.role(f,token);
    assert(this.terminal(f),"実験終了または中断後に切り替えてください");
    if(!f.participantReset){f.participantReset=true;this.save(f);this.event(f,"participant_reset",role);this.publish(f);}
  }
  withdraw(s,token,b) {
    const f=this.load(s);assert(f,"実験が見つかりません",404);const role=this.role(f,token);
    if(f.experimentPhase==="withdrawn")return;
    assert(!this.terminal(f),"実験は終了済みです");assert(b.confirm===true,"中断の確認が必要です",400);
    this.terminate(f,"withdrawn","participant_withdrawal",role);
  }
  terminate(f,status,reason,role="system") {
    assert(["withdrawn","technical_failure","researcher_terminated"].includes(status),"invalid termination",400);
    assert(!this.terminal(f),"実験は終了済みです");
    for(const tid of f.trialIds){const t=this.d.loadTrial(f.sessionId,tid);if(t.state!=="completed"){t.state="incomplete";t.trialStatus="incomplete";t.completionReason=reason;t.endTime=new Date().toISOString();this.d.saveTrial(f.sessionId,t);}}
    f.experimentStatus=status;f.completionReason=reason;f.endedAt=Date.now();this.transition(f,status);this.save(f);
    const session=this.d.loadSession(f.sessionId);session.status=status;session.experimentStatus=status;session.completionReason=reason;this.d.saveSession(session);
    this.event(f,"experiment_terminated",role,{status,completionReason:reason});this.publish(f);this.quality(f);
  }
  plans() { return loadPlans(this.d.planDir); }
  planReports() { const plans=this.plans();return plans.map(p=>({...inspectPlan(p,plans,this.d),title:p.title||"撮影実験"})); }
  validatePlan(plan) {
    const report=inspectPlan(plan,this.plans(),this.d);
    assert(report.available,"実験計画の準備に不足があります。担当者へお知らせください",400);
    return report.items;
  }
  start(planId, startKey) {
    assert(id(startKey) && startKey.length >= 20, "開始識別子が不正です",400);
    const s = `flow-${startKey}`;
    let f = this.load(s);
    if (f) { assert(f.planId===planId,"別の実験が開始済みです"); return f; }
    const plan = this.plans().find(p => p.planId === planId);
    const items = this.validatePlan(plan);
    const session = {schemaVersion:"1.0",sessionId:s,experimentSessionId:s,participantId:plan.pairId,pairId:plan.pairId,
      participantPairId:plan.pairId,guidanceProtocolVersion:"progressive-v1",flowProtocolVersion:"participant-flow-v1",conditionId:items[0].condition,
      supportLevel:2,status:"configured",createdAt:new Date().toISOString(),currentTrialId:null};
    this.d.write(path.join(this.dir(s),"retention.json"),{retain:true,reason:"participant_experiment",createdAt:Date.now()});
    this.d.saveSession(session);
    const trials = items.map((item,i) => this.d.createTrial(s, item, i, plan.trials.length));
    session.currentTrialId = trials[0].trialId; this.d.saveSession(session);
    f = {flowProtocolVersion:"participant-flow-v1",sessionId:s,planId,pairId:plan.pairId,revision:0,trialIds:trials.map(t=>t.trialId),trialIndex:0,
      totalTrials:plan.trials.length,experimentStatus:"in_progress",experimentPhase:"experimentIntroduction",currentCaptureSequence:null,lastCaptureSequence:0,captureCount:0,
      acknowledgements:{},receipts:[],tokens:{subject:randomUUID(),photographer:randomUUID()},config:this.d.config,createdAt:Date.now()};
    this.d.write(path.join(this.dir(s),"experiment-plan.json"),{...plan,items,trialIds:f.trialIds});
    this.save(f); this.event(f,"experiment_started"); return f;
  }
  questions(f) { return f.config.questions.filter(q => !q.conditions || q.conditions.includes(this.trial(f).conditionId)); }
  snapshot(s, token) {
    const f=this.load(s); assert(f,"実験が見つかりません",404); const role=this.role(f,token); const t=this.trial(f), c=this.capture(f);
    if (f.experimentPhase === "analyzing" && c?.photoId && c.analysisStatus === "pending") this.queue(s);
    const phase=f.experimentPhase;
    const submitted=Boolean(c?.[`${role}Evaluation`]);
    const q=this.d.read(this.questionnairePath(f));
    const viewPhase=phase === "photoEvaluation" && submitted ? "waitingForPartnerEvaluation" : phase;
    let guidance=[]; let ready=null;
    if (phase === "guidance" && t.conditionId !== "A" && c?.analysisId) {
      const analysis=this.d.analysis(s,c.analysisId);
      guidance=analysis?.[`${role}Guidance`] || []; ready=f.config.showReadyToParticipants===true ? analysis?.ready || null : null;
    }
    // Whitelist public fields. Never send either person's answers or full candidate lists.
    return {sessionId:s,experimentSessionId:s,participantPairId:f.pairId,trialId:t.trialId,
      guidanceProtocolVersion:t.guidanceProtocolVersion,flowProtocolVersion:f.flowProtocolVersion,revision:f.revision,
      participantReset:f.participantReset===true,experimentPhase:phase,experimentStatus:f.experimentStatus||phase,showReadyToParticipants:f.config.showReadyToParticipants===true,viewPhase,role,trialIndex:t.trialIndex,totalTrials:f.totalTrials,isPractice:t.isPractice,
      referenceImageId:t.referenceImageId,referenceImageUrl:t.referenceImageUrl,guideId:t.guideId,guideUrl:t.guideUrl,
      captureCount:f.captureCount,maximumCaptureCount:t.maximumCaptureCount,isLastCapture:f.captureCount>=t.maximumCaptureCount-1,
      currentCaptureSequence:f.currentCaptureSequence,nextCaptureSequence:f.lastCaptureSequence+1,
      photoId:c?.photoId || null,photoUrl:c?.photoId ? this.d.photoUrl(s,c.photoId) : null,analysisId:c?.analysisId || null,
      analysisStatus:c?.analysisStatus || null,uploadPending:phase==="analyzing"&&!c?.photoId,
      submittedEvaluation:submitted,acknowledged:Boolean(f.acknowledgements[role]),questionnaireSubmitted:Boolean(q?.responses?.[role]),
      nextAction:c?.decision?.nextAction || null,completionReason:f.completionReason || t.completionReason || null,
      guidance,ready,questions:this.questions(f).map(({id,text})=>({id,text})),freeTextQuestion:f.config.freeTextQuestion,
      // Tokens are returned only to their own role; subject needs photographer QR, never vice versa.
      ...(role==="subject"?{photographerJoinPath:`/?sessionId=${encodeURIComponent(s)}&flowToken=${encodeURIComponent(f.tokens.photographer)}`}:{})};
  }
  check(f,b) { assert(!this.terminal(f),"実験は終了済みです");assert(b.trialId===this.trial(f).trialId,"試行が切り替わりました。画面を更新してください"); }
  begin(s,token,b) {
    const f=this.load(s);assert(f,"実験が見つかりません",404);assert(this.role(f,token)==="photographer","撮影者だけが撮影できます",403);this.check(f,b);
    const previous=this.capture(f);
    if (f.experimentPhase==="analyzing" && previous?.requestId===b.requestId) return previous;
    assert(f.experimentPhase==="capture"&&f.captureCount<this.trial(f).maximumCaptureCount,"現在は撮影できません");assert(id(b.requestId),"撮影識別子が不正です",400);
    const c={captureSequence:++f.lastCaptureSequence,requestId:b.requestId,clientId:randomUUID(),photoId:null,analysisId:null,analysisStatus:"pending",
      captureTimestamp:Number.isFinite(b.captureTimestamp)?b.captureTimestamp:Date.now(),startedAt:Date.now(),
      previousCaptureSequence:previous?.photoId ? previous.captureSequence : null,
      guidanceToCaptureMs:previous?.guidanceDisplays ? Object.fromEntries(Object.entries(previous.guidanceDisplays).map(([role,display])=>[role,Date.now()-display.serverReceivedAt])) : null,photographerEvaluation:null,subjectEvaluation:null,decision:null};
    f.currentCaptureSequence=c.captureSequence;this.transition(f,"analyzing");this.writeCapture(f,c);this.save(f);
    this.event(f,f.captureCount?"recapture_started":"capture_started","photographer",{},c);this.publish(f);return c;
  }
  uploadGuard(req,res,next) {
    try {
      const f=this.load(req.params.sessionId);if(!f)return next();
      assert(this.role(f,req.get("X-Experiment-Token"))==="photographer","撮影者用リンクが必要です",403);
      assert(!this.terminal(f),"実験は終了済みです");
      const c=this.capture(f);assert(c&&String(c.captureSequence)===req.get("X-Flow-Capture-Sequence"),"古い撮影です");
      if(c.photoId) return res.json({success:true,photo:{photoId:c.photoId,clientId:c.clientId,captureSequence:c.captureSequence,status:"draft"}});
      assert(f.experimentPhase==="analyzing"&&c.analysisStatus==="pending","現在は写真を保存できません");
      req.flowCapture={...c,trialId:this.trial(f).trialId,guideId:this.trial(f).guideId};next();
    } catch(e){next(e);}
  }
  captured(s,photoId,meta) {
    const f=this.load(s);if(!f)return;
    const c=this.capture(f);assert(c&&c.captureSequence===meta.captureSequence&&c.clientId===meta.clientId&&f.experimentPhase==="analyzing"&&c.analysisStatus==="pending","古い写真は採用しません");
    if(c.photoId)return;
    c.photoId=photoId;f.captureCount++;this.writeCapture(f,c);this.save(f);this.event(f,"photo_captured","photographer",{captureTimestamp:c.captureTimestamp},c);this.publish(f);this.queue(s);
  }
  queue(s) {
    if(this.jobs.has(s))return;
    this.jobs.add(s);
    setImmediate(()=>{
      try {const f=this.load(s), c=f&&this.capture(f);if(f&&f.experimentPhase==="analyzing"&&c?.photoId&&c.analysisStatus==="pending"){c.analysisAttempts=(c.analysisAttempts||0)+1;this.writeCapture(f,c);this.event(f,c.analysisAttempts>1?"analysis_retry":"analysis_attempt","system",{attempt:c.analysisAttempts,outcome:"started"});this.d.runAnalysis(s,this.trial(f),c);}}
      catch(e){const f=this.load(s);if(f)this.analysisDone(s,{trialId:this.trial(f).trialId,captureSequence:f.currentCaptureSequence,analysisStatus:"failed",errorReason:e.message});}
      finally {this.jobs.delete(s);}
    });
  }
  analysisDone(s,result) {
    const f=this.load(s);if(!f)return;
    const c=this.capture(f);if(!c||result.trialId!==this.trial(f).trialId||result.captureSequence!==c.captureSequence||f.experimentPhase!=="analyzing")return;
    c.analysisId=result.analysisId||null;c.analysisStatus=["completed","success"].includes(result.analysisStatus)?"success":result.analysisStatus==="failed"?"failed":"not_available";c.analysisEndTimestamp=Date.now();c.errorReason=result.errorReason||null;c.analysisFailureReason=c.errorReason;
    if(c.analysisStatus==="success"&&result.alignmentError&&["centerError","scaleError","poseError"].every(k=>result.alignmentError[k]==null)){c.analysisStatus="not_available";c.analysisFailureReason="insufficient_observation";}
    this.writeCapture(f,c);this.event(f,"analysis_result","system",{outcome:c.analysisStatus,attempt:c.analysisAttempts||1},c);this.transition(f,"photoEvaluation");this.save(f);this.event(f,"photo_evaluation_started","system",{},c);this.publish(f);
  }
  evaluate(s,token,b) {
    const f=this.load(s);assert(f,"実験が見つかりません",404);const role=this.role(f,token);this.check(f,b);const c=this.capture(f);
    assert(c&&c.captureSequence===b.captureSequence,"古い写真への回答です");
    assert(rating(b.similarityRating)&&rating(b.satisfactionRating)&&typeof b.wantsRetake==="boolean","1〜7の評価と撮り直しの回答を選択してください",400);
    const key=`${role}Evaluation`;const value={similarityRating:b.similarityRating,satisfactionRating:b.satisfactionRating,wantsRetake:b.wantsRetake};
    if(c[key]) {this.event(f,"duplicate_submission",role,{operation:"evaluation"});assert(Object.keys(value).every(k=>c[key][k]===value[k]),"送信済みの回答は変更できません");return;}
    assert(f.experimentPhase==="photoEvaluation","現在は評価を送信できません");c[key]={...value,submittedAt:Date.now()};
    this.writeCapture(f,c);this.save(f);this.event(f,`${role}_evaluation_submitted`,role,{submittedAt:c[key].submittedAt},c);
    if(c.photographerEvaluation&&c.subjectEvaluation) {
      const max=f.captureCount>=this.trial(f).maximumCaptureCount;
      const mutual=!c.photographerEvaluation.wantsRetake&&!c.subjectEvaluation.wantsRetake;
      c.decision={nextAction:max||mutual?"finish":"retake",completionReason:max?"maximum_capture_count":mutual?"mutual_finish":null,mutualFinish:mutual,limitReached:max,decidedAt:Date.now()};
      c.agreement={similarityGap:Math.abs(c.photographerEvaluation.similarityRating-c.subjectEvaluation.similarityRating),satisfactionGap:Math.abs(c.photographerEvaluation.satisfactionRating-c.subjectEvaluation.satisfactionRating)};
      this.writeCapture(f,c);this.event(f,"evaluations_completed","system",{},c);
      if(c.decision.nextAction==="finish") {
        const t=this.trial(f);t.finalPhotoId=c.photoId;t.finalCaptureSequence=c.captureSequence;t.completionReason=c.decision.completionReason;t.captureEndTime=new Date().toISOString();this.d.saveTrial(s,t);
        this.d.sharePhoto(s,c.photoId);this.transition(f,"trialQuestionnaire");this.save(f);this.event(f,"trial_finish_decided","system",c.decision,c);this.event(f,"trial_questionnaire_started","system",{},c);
      } else {this.transition(f,"guidance");this.save(f);this.event(f,"retake_decided","system",c.decision,c);}
    }
    this.publish(f);
  }
  questionnaire(s,token,b) {
    const f=this.load(s);assert(f,"実験が見つかりません",404);const role=this.role(f,token);this.check(f,b);
    const q=this.d.read(this.questionnairePath(f))||{version:f.config.version,questionnaireVersion:f.config.questionnaireVersion||"legacy-trial-v1",responses:{}};
    const keys=this.questions(f).map(q=>q.id);
    assert(b.answers&&keys.every(k=>rating(b.answers[k]))&&Object.keys(b.answers).every(k=>keys.includes(k)),"すべての質問に1〜7で回答してください",400);
    assert(typeof (b.comment??"")==="string"&&(b.comment||"").length<=2000,"自由記述は2000文字以内にしてください",400);
    const value={answers:b.answers,comment:b.comment||""};
    if(q.responses[role]){this.event(f,"duplicate_submission",role,{operation:"questionnaire"});assert(keys.every(k=>q.responses[role].answers[k]===value.answers[k])&&q.responses[role].comment===value.comment,"送信済みの回答は変更できません");return;}
    assert(f.experimentPhase==="trialQuestionnaire","現在はアンケートを送信できません");q.responses[role]={...value,submittedAt:Date.now()};this.d.write(this.questionnairePath(f),q);this.save(f);this.event(f,"trial_questionnaire_submitted",role);
    if(both(q.responses)){const t=this.trial(f);t.state="completed";t.endTime=new Date().toISOString();this.d.saveTrial(s,t);this.transition(f,"trialCompleted");this.save(f);this.event(f,"trial_completed");}this.publish(f);
  }
  acknowledge(s,token,b) {
    const f=this.load(s);assert(f,"実験が見つかりません",404);const role=this.role(f,token);this.check(f,b);
    assert(b.captureSequence===f.currentCaptureSequence,"撮影が切り替わりました");
    const key=`${b.trialId}:${b.phase}:${b.captureSequence}:${role}`;
    if(f.receipts.includes(key))return;
    assert(b.phase===f.experimentPhase&&["experimentIntroduction","trialIntroduction","referenceViewing","guidance","trialCompleted"].includes(b.phase),"画面が切り替わりました。更新してください");
    f.receipts.push(key);f.acknowledgements[role]=true;this.save(f);
    if(b.phase==="guidance")this.event(f,"guidance_acknowledged",role);
    if(b.phase==="referenceViewing")this.event(f,"reference_viewed",role);
    if(both(f.acknowledgements)) {
      if(b.phase==="experimentIntroduction")this.transition(f,"trialIntroduction");
      if(b.phase==="trialIntroduction")this.transition(f,"referenceViewing");
      if(b.phase==="referenceViewing") {
        const t=this.trial(f);t.state="running";t.startTime=new Date().toISOString();this.d.saveTrial(s,t);this.transition(f,"capture");this.event(f,"trial_started");
      }
      if(b.phase==="guidance")this.transition(f,"capture");
      if(b.phase==="trialCompleted") {
        if(f.trialIndex+1===f.trialIds.length){f.experimentStatus="completed";f.endedAt=Date.now();this.transition(f,"experimentCompleted");this.event(f,"experiment_completed");}
        else {f.trialIndex++;f.currentCaptureSequence=null;f.captureCount=0;this.transition(f,"trialIntroduction");}
      }
      const session=this.d.loadSession(s),t=this.trial(f);session.currentTrialId=t.trialId;session.conditionId=t.conditionId;session.status=f.experimentPhase;this.d.saveSession(session);this.save(f);
    }this.publish(f);if(this.terminal(f))this.quality(f);
  }
  displayed(s,token,b) {
    const f=this.load(s);assert(f,"実験が見つかりません",404);const role=this.role(f,token);this.check(f,b);const c=this.capture(f);
    assert(f.experimentPhase==="guidance"&&c?.captureSequence===b.captureSequence,"現在は指示画面ではありません");
    c.guidanceDisplays=c.guidanceDisplays||{};if(c.guidanceDisplays[role])return;
    c.guidanceDisplays[role]={displayedAt:Number.isFinite(b.displayedAt)?b.displayedAt:null,serverReceivedAt:Date.now()};this.writeCapture(f,c);this.save(f);
    const snap=this.snapshot(s,token);this.event(f,"guidance_displayed",role,{...c.guidanceDisplays[role],selectedGuidance:snap.guidance,ready:snap.ready},c);
  }
  retryUpload(s,token,b) {
    const f=this.load(s);assert(f,"実験が見つかりません",404);assert(this.role(f,token)==="photographer","撮影者が再撮影してください",403);this.check(f,b);const c=this.capture(f);
    assert(f.experimentPhase==="analyzing"&&!c?.photoId&&c?.captureSequence===b.captureSequence,"再撮影できません");c.analysisStatus="not_available";c.analysisFailureReason="upload_abandoned";this.writeCapture(f,c);this.transition(f,"capture");this.save(f);this.event(f,"capture_upload_abandoned","photographer",{outcome:"success"});this.publish(f);
  }
  register(app) {
    app.get("/api/participant-experiments/plans",(req,res,next)=>{try{res.json({plans:this.planReports().map(({planId,pairId,title,available,totalTrials,practiceCount})=>({planId,pairId,title,available,totalTrials,practiceCount}))});}catch(e){next(e);}});
    app.post("/api/participant-experiments/start",(req,res,next)=>{try{const f=this.start(req.body.planId,req.body.startKey);res.json({sessionId:f.sessionId,token:f.tokens.subject,state:this.snapshot(f.sessionId,f.tokens.subject)});}catch(e){next(e);}});
    app.get("/api/participant-experiments/:sessionId/state",(req,res,next)=>{try{res.set("Cache-Control","no-store");res.json(this.snapshot(req.params.sessionId,req.get("X-Experiment-Token")));}catch(e){next(e);}});
    for(const [action,method] of Object.entries({ack:"acknowledge",evaluation:"evaluate",questionnaire:"questionnaire",displayed:"displayed",retryUpload:"retryUpload",withdraw:"withdraw",reset:"reset",diagnostic:"diagnostic"})) {
      app.post(`/api/participant-experiments/:sessionId/${action}`,(req,res,next)=>{try{this[method](req.params.sessionId,req.get("X-Experiment-Token"),req.body);res.json(this.snapshot(req.params.sessionId,req.get("X-Experiment-Token")));}catch(e){try{const f=this.load(req.params.sessionId);if(f)this.event(f,"operation_failed","system",{operation:action,statusCode:e.statusCode||500});}catch{}next(e);}});
    }
    app.post("/api/participant-experiments/:sessionId/capture",(req,res,next)=>{try{const c=this.begin(req.params.sessionId,req.get("X-Experiment-Token"),req.body);res.json({captureSequence:c.captureSequence,clientId:c.clientId,captureTimestamp:c.captureTimestamp});}catch(e){next(e);}});
  }
}
module.exports={ExperimentFlow};
