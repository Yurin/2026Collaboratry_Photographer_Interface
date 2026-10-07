const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {atomic,inspectSession,exportData,backup,shouldExpire,captureColumns,trialColumns}=require('../research_data');
const {inspectPlan,loadPlans,referenceForPlan}=require('../experiment_validation');
const {spawnSync}=require('node:child_process');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'research-data-test-')),dir=path.join(root,'uploads/session1');
const write=(name,value)=>atomic(path.join(dir,name),value);
const flow={pairId:'P03',experimentStatus:'completed',totalTrials:1,trialIds:['practice','t1'],flowProtocolVersion:'participant-flow-v1',config:{questions:[{id:'ease'}]}};
function trial(tid,practice,seq){write(`experiment/trials/${tid}/trial.json`,{trialId:tid,trialIndex:practice?0:1,isPractice:practice,conditionId:'A',referenceImageId:'r1',state:'completed',guidanceProtocolVersion:'progressive-v1',finalPhotoId:`p${seq}.jpg`,finalCaptureSequence:seq,startTime:'2026-10-05T00:00:00Z',captureEndTime:'2026-10-05T00:01:00Z',endTime:'2026-10-05T00:02:00Z'});
 const ev={similarityRating:4,satisfactionRating:5,wantsRetake:false,submittedAt:100};
 write(`experiment/trials/${tid}/evaluations/capture_${seq}.json`,{captureSequence:seq,photoId:`p${seq}.jpg`,analysisId:'a'+seq,analysisStatus:'success',captureTimestamp:80,photographerEvaluation:ev,subjectEvaluation:{...ev,similarityRating:6},agreement:{similarityGap:2,satisfactionGap:0},decision:{nextAction:'finish',completionReason:'mutual_finish'}});
 write(`analysis/history/a${seq}.json`,{analysisId:'a'+seq,trialId:tid,photoId:`p${seq}.jpg`,captureSequence:seq,conditionId:'A',alignmentError:{centerError:.12,scaleError:.1,poseError:.4,totalError:.8},ready:{framingReady:false,poseReady:false,captureReady:false},photographerGuidance:[],subjectGuidance:[]});
 write(`experiment/trials/${tid}/questionnaire.json`,{responses:{photographer:{answers:{ease:4},comment:'カンマ,と"引用"\n改行',submittedAt:110},subject:{answers:{ease:5},comment:'=formula',submittedAt:120}}});
 fs.mkdirSync(path.join(dir,'photos'),{recursive:true});fs.writeFileSync(path.join(dir,'photos',`p${seq}.jpg`),'photo');
}
try{
 write('experiment/flow.json',flow);write('experiment/session.json',{participantPairId:'P03',flowProtocolVersion:'participant-flow-v1'});write('experiment/experiment-plan.json',{pairId:'P03',practice:{condition:'A'},trials:[{condition:'A'}]});trial('practice',true,1);trial('t1',false,2);
 let data=inspectSession(dir);assert.equal(data.report.status,'complete');assert.equal(data.captures[1].poseError,.4);assert.equal(data.captures[1].compositionError,undefined);assert.equal(data.trials[1].finalSubjectSimilarity,6);assert.equal(data.trials[1].finalCenterError,.12);assert.equal(data.trials[1].finalScaleError,.1);assert.equal(data.trials[1].centerImprovement,0);assert.equal(data.trials[1].mutualFinish,true);assert.equal(data.trials[1].questionnaireVersion,'legacy-trial-v1');assert.equal(data.trials[1].timingComplete,false);assert.equal(data.report.trialsCompleted,1);
 const out=path.join(root,'export');exportData(path.join(root,'uploads'),out);
 const csv=fs.readFileSync(path.join(out,'capture-level.csv'),'utf8');assert.ok(csv.includes('analysisFailureReason'));assert.ok(csv.includes('P03,session1,t1,1,false,A'));assert.equal(csv.trim().split('\r\n').length,3);assert.ok(fs.readFileSync(path.join(out,'trial-level.csv'),'utf8').includes('finalTotalError'));
 assert.ok(fs.readFileSync(path.join(out,'questionnaire-level.csv'),'utf8').includes('photographer'));assert.ok(fs.readFileSync(path.join(out,'questionnaire-responses.csv'),'utf8').includes('""引用""'));
 assert.ok(captureColumns.includes('guidanceToNextCaptureMsSubject'));assert.ok(trialColumns.includes('missingEvaluationCount'));
 // Backup contains every original file, including references/config and photos.
 write('references/reference.json',{test:true});write('experiment/trials/t1/guidance-config.json',{version:'progressive-v1'});
 const manifest=backup(path.join(root,'uploads'),path.join(root,'backup'));assert.ok(manifest.files.some(f=>f.path==='session1/photos/p2.jpg'));assert.ok(manifest.files.some(f=>f.path.endsWith('flow.json')));assert.ok(manifest.files.every(f=>f.sha256.length===64));
 for(const command of ['export','backup','summary']){const args=[path.resolve(__dirname,'../experiment_tools.js'),command,'--root',path.join(root,'uploads')];if(command!=='summary')args.push('--out',path.join(root,'cli-'+command));const result=spawnSync(process.execPath,args,{encoding:'utf8'});assert.equal(result.status,0,result.stderr);const output=JSON.parse(result.stdout);if(command==='export')assert.ok(fs.existsSync(path.join(output.output,'capture-level.csv')));if(command==='backup')assert.ok(fs.existsSync(path.join(output.output,'manifest.json')));}
 const old=Date.now()-100000;fs.utimesSync(dir,old/1000,old/1000);assert.equal(shouldExpire(dir,Date.now(),1000),false);
 const normal=path.join(root,'normal');fs.mkdirSync(normal);fs.utimesSync(normal,old/1000,old/1000);assert.equal(shouldExpire(normal,Date.now(),1000),true);
 // Missing and malformed records do not stop export.
 const evPath=path.join(dir,'experiment/trials/t1/evaluations/capture_2.json');const ev=JSON.parse(fs.readFileSync(evPath));delete ev.subjectEvaluation;ev.analysisStatus='failed';ev.analysisFailureReason='model_failed';atomic(evPath,ev);
 fs.unlinkSync(path.join(dir,'experiment/trials/t1/questionnaire.json'));fs.unlinkSync(path.join(dir,'analysis/history/a2.json'));
 data=inspectSession(dir);assert.equal(data.report.status,'incomplete');assert.equal(data.report.missingEvaluations,1);assert.equal(data.report.missingQuestionnaires,2);assert.equal(data.report.analysisFailures,1);assert.equal(data.report.missingFinalAnalysis,1);assert.equal(data.captures[1].poseError,undefined);exportData(path.join(root,'uploads'),path.join(root,'missing-export'));
 write('experiment/flow.json',{...flow,experimentStatus:'withdrawn'});assert.equal(inspectSession(dir).report.status,'withdrawn');
 write('experiment/flow.json',flow);trial('t1',false,2);const a=JSON.parse(fs.readFileSync(path.join(dir,'analysis/history/a2.json')));write('analysis/history/a2.json',{...a,trialId:'another-trial'});assert.ok(inspectSession(dir).report.issues.some(i=>i.code==='analysis_join_mismatch'));
 trial('t1',false,2);const v=JSON.parse(fs.readFileSync(evPath));atomic(evPath,{...v,analysisStatus:'failed',analysisFailureReason:'failed'});assert.equal(inspectSession(dir).report.status,'complete_with_warnings');
 fs.writeFileSync(path.join(dir,'experiment/trials/t1/evaluations/capture_broken.json'),'{');assert.doesNotThrow(()=>exportData(path.join(root,'uploads'),path.join(root,'broken-export')));
 // Whole missing capture files are recovered as sparse export rows from saved capture events.
 const eventsPath=path.join(dir,'experiment/trials/t1/events.jsonl');fs.writeFileSync(eventsPath,JSON.stringify({eventType:'photo_captured',payload:{photoId:'lost.jpg',captureSequence:3,captureTimestamp:130}})+'\n');
 const lost=inspectSession(dir);assert.ok(lost.report.issues.some(i=>i.code==='missing_capture_evaluation'));assert.equal(lost.captures.find(c=>c.photoId==='lost.jpg').captureTimestamp,130);fs.unlinkSync(eventsPath);
 // Plan validation accumulates per-trial errors and duplicate reference warnings.
 const config=require('../experiment_flow_config.json'),item=c=>({condition:c,referenceImageId:'ref',sourceSessionId:'source'}),plan={planId:'P03',pairId:'P03',practice:item('C'),trials:['A','B','C'].map(item)};
 const deps={config,prepareReference(){}};assert.equal(inspectPlan(plan,[plan],deps).available,true);assert.ok(inspectPlan(plan,[plan],deps).issues.some(i=>i.code==='duplicate_reference'));
 assert.ok(inspectPlan(plan,[plan,plan],deps).issues.some(i=>i.code==='duplicate_plan_id'));
 const bad={...plan,maximumCaptureCount:0,trials:[item('Z')]};const report=inspectPlan(bad,[bad],{...deps,prepareReference(){throw Object.assign(Error('missing'),{code:'missing_reference_image'});}});for(const code of ['invalid_condition','invalid_maximum_capture_count','missing_reference_image'])assert.ok(report.issues.some(i=>i.code===code));assert.equal(report.available,false);
 const referenceRoot=path.join(root,'refs');fs.mkdirSync(path.join(referenceRoot,'source'),{recursive:true});assert.throws(()=>referenceForPlan(referenceRoot,item('A'),require('../guide_processor/guidance_config.json')),e=>e.code==='missing_pose');
 atomic(path.join(referenceRoot,'source/experiment/references/ref/current.json'),{personCount:1,image:{url:'/uploads/source/references/missing.jpg'}});assert.throws(()=>referenceForPlan(referenceRoot,item('A'),require('../guide_processor/guidance_config.json')),e=>e.code==='missing_reference_image');
 trial('t1',false,2);fs.copyFileSync(evPath,path.join(dir,'experiment/trials/t1/evaluations/duplicate.json'));assert.ok(inspectSession(dir).report.issues.some(i=>i.code==='duplicate_capture'));
 write('experiment/trials/duplicate-trial/trial.json',{trialId:'t1',conditionId:'B'});assert.ok(inspectSession(dir).report.issues.some(i=>i.code==='duplicate_trial'));
 write('analysis/history/a2.json',{...a,conditionId:'C'});assert.ok(inspectSession(dir).report.issues.some(i=>i.code==='condition_mismatch'));
 assert.equal(inspectPlan({...plan,trials:{}},[plan],deps).available,false);
 const plans=path.join(root,'plans');fs.mkdirSync(plans);fs.writeFileSync(path.join(plans,'bad.json'),'{');assert.equal(loadPlans(plans)[0]._error,'unreadable_plan_json');
 console.log('research operations passed: CSV joins/nulls/quoting, quality statuses and missing data, backup hashes, TTL isolation, plan validation');
}finally{fs.rmSync(root,{recursive:true,force:true});}
