const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {buildPlans,generatePlans}=require('../experiment_plan_builder');
const {phaseTimes,trialMetrics}=require('../study_metrics');
const config=require('../experiment_flow_config.json'),guidance=require('../guide_processor/guidance_config.json');
const ref=i=>({sourceSessionId:'source',referenceImageId:'R'+i});
const spec={studyId:'pilot',pairIds:Array.from({length:18},(_,i)=>'P'+String(i+1).padStart(2,'0')),practice:ref(0),references:Array.from({length:6},(_,i)=>ref(i+1))};
const plans=buildPlans(spec),counts=new Map();
assert.equal(new Set(plans.map(p=>p.orderId+':'+p.assignmentId)).size,18);
for(const p of plans){assert.equal(p.trials.length,6);assert.equal(new Set(p.trials.map(t=>t.referenceImageId)).size,6);assert.equal(p.practice.condition,'C');for(let i=0;i<6;i+=2)assert.equal(p.trials[i].condition,p.trials[i+1].condition);for(const t of p.trials){const key=t.referenceImageId+':'+t.condition;counts.set(key,(counts.get(key)||0)+1);}}
assert.ok([...counts.values()].every(n=>n===6));
assert.throws(()=>buildPlans({...spec,pairIds:['P01','p01']}),/重複/);
assert.throws(()=>buildPlans({...spec,practice:ref(1)}),/重複/);
assert.deepEqual(buildPlans({...spec,pairIds:['P07'],startSlot:6})[0],plans[6]);
assert.equal(config.questions.filter(q=>!q.conditions).length,4);assert.equal(config.questions.length,8);assert.ok(!config.questions.some(q=>q.id==='timing'));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'study-design-'));
try{
 const uploads=path.join(root,'uploads'),out=path.join(root,'plans'),args={spec,out,root:uploads,config,guidance};
 assert.throws(()=>generatePlans(args),/missing_source_session/);assert.ok(!fs.existsSync(out));
 for(let i=0;i<7;i++){
  const dir=path.join(uploads,'source','experiment','references','R'+i);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(uploads,'source','photo'+i+'.jpg'),'test fixture');
  const points=[['leftShoulder',.3,.3],['rightShoulder',.7,.3],['leftHip',.3,.7],['rightHip',.7,.7]];
  fs.writeFileSync(path.join(dir,'current.json'),JSON.stringify({personCount:1,source:'manual-corrected',versionId:'v1',referenceImageId:'R'+i,boundingBox:{x:.1,y:.1,width:.8,height:.8},image:{url:'/uploads/source/photo'+i+'.jpg'},keypoints:points.map(([name,x,y])=>({name,x,y,confidence:1,isEnabled:true}))}));
 }
 const result=generatePlans(args);assert.equal(result.plans,18);assert.ok(fs.existsSync(result.assignment));assert.equal(fs.readdirSync(out).filter(n=>n.endsWith('.json')).length,18);
 const before=fs.readFileSync(path.join(out,'pilot_P01.json'),'utf8');assert.throws(()=>generatePlans(args),/重複/);assert.equal(fs.readFileSync(path.join(out,'pilot_P01.json'),'utf8'),before);
 assert.throws(()=>generatePlans({...args,spec:{...spec,studyId:'other'}}),/重複/);
}finally{fs.rmSync(root,{recursive:true,force:true});}
const tr=(from,to,timestamp)=>({eventType:'state_transition',payload:{from,to,timestamp}});
const events=[tr('referenceViewing','capture',100),tr('capture','analyzing',200),tr('analyzing','photoEvaluation',250),tr('photoEvaluation','guidance',300),tr('guidance','capture',350),tr('capture','analyzing',450),tr('analyzing','photoEvaluation',500),tr('photoEvaluation','trialQuestionnaire',550),tr('trialQuestionnaire','trialCompleted',700)];
assert.deepEqual(phaseTimes(events),{captureAdjustmentMs:200,guidanceReviewMs:50,analysisCommunicationMs:100,evaluationMs:100,questionnaireMs:150,humanOperationMs:250,timingComplete:true});
assert.equal(phaseTimes(events.slice(0,-1)).timingComplete,false);assert.equal(phaseTimes(events.filter((_,i)=>i!==2)).humanOperationMs,null);assert.equal(phaseTimes([]).captureAdjustmentMs,null);
const ev=wantsRetake=>({wantsRetake}),entry=(seq,center,pose)=>({c:{captureSequence:seq,photographerEvaluation:ev(false),subjectEvaluation:ev(false)},row:{centerError:center,scaleError:.1,poseError:pose}});
const first=entry(1,.3,.7),last=entry(5,.1,.2);
let m=trialMetrics([first,last],last,{maximumCaptureCount:2,completionReason:'maximum_capture_count'},events);
assert.equal(m.mutualFinish,true);assert.equal(m.limitReached,true);assert.equal(m.mutualFinishCensored,false);assert.equal(m.capturesToMutualFinish,2);assert.ok(Math.abs(m.centerImprovement-.2)<1e-9);
last.c.subjectEvaluation=ev(true);m=trialMetrics([first,last],last,{completionReason:'maximum_capture_count'},[]);assert.equal(m.mutualFinishCensored,true);assert.equal(m.capturesToMutualFinish,null);
assert.equal(trialMetrics([{c:{captureSequence:1},row:{}}],null,{},[]).poseImprovement,null);
console.log('study design passed: crossed allocation, validated non-overwriting registration, questionnaire, state timing, censored and mutual-at-limit outcomes');
