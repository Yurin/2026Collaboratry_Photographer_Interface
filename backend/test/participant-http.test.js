// Real HTTP/WS and Python scoring; neural inference alone uses a fixture.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process'),{randomUUID}=require('node:crypto'),{WebSocket}=require('ws');
const backend=path.resolve(__dirname,'..'),python=process.env.TEST_PYTHON||path.join(backend,'.venv/bin/python');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'participant-http-')),source='prepared-'+randomUUID(),startKey=randomUUID(),sid='flow-'+startKey;
 const sourceDir=path.join(backend,'uploads',source),dir=path.join(backend,'uploads',sid),fixture=path.join(temp,'observation.json'),wrapper=path.join(temp,'python-fixture');
 const write=(p,v)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(v));},read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
 fs.writeFileSync(wrapper,`#!${python}\nimport sys,os,shutil\nif os.path.basename(sys.argv[1]) == 'extract_live_features.py':\n    os.makedirs(os.path.dirname(sys.argv[sys.argv.index('--output')+1]),exist_ok=True)\n    shutil.copyfile(os.environ['OBSERVATION_FIXTURE'],sys.argv[sys.argv.index('--output')+1])\nelse:\n    os.execv(${JSON.stringify(python)},[${JSON.stringify(python)}]+sys.argv[1:])\n`);fs.chmodSync(wrapper,0o700);
 const points=[['leftShoulder',.4,.3],['rightShoulder',.6,.3],['leftHip',.43,.6],['rightHip',.57,.6],['leftWrist',.2,.5],['rightWrist',.8,.5]].map(([name,x,y])=>({name,x,y,confidence:1,isEnabled:true}));
 write(path.join(sourceDir,'experiment/references/ref/current.json'),{source:'manual',versionId:'verified-1',personCount:1,referenceImageId:'ref',boundingBox:{x:.2,y:.1,width:.6,height:.8},keypoints:points,image:{filename:'ref.jpg',url:`/uploads/${source}/references/ref.jpg`}});
 fs.mkdirSync(path.join(sourceDir,'references'),{recursive:true});fs.writeFileSync(path.join(sourceDir,'references/ref.jpg'),'test image');
 const item=condition=>({condition,sourceSessionId:source,referenceImageId:'ref'});
 write(path.join(temp,'plans/p.json'),{planId:'P01',pairId:'P01',maximumCaptureCount:2,practice:item('C'),trials:['A','B','C','B','C','A'].map(item)});
 const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const base=`http://127.0.0.1:${port}`;let child,ws,stderr='';const events=[],tokens={};let passed=false;
 async function launch(){child=spawn(process.execPath,['server.js'],{cwd:backend,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',EXPERIMENT_PLAN_DIR:path.join(temp,'plans'),PYTHON:wrapper,OBSERVATION_FIXTURE:fixture,RESEARCH_ADMIN_TOKEN:'test-admin-secret'},stdio:['ignore','ignore','pipe']});child.stderr.on('data',d=>stderr+=d);for(let i=0;i<60;i++){try{if((await fetch(base+'/health')).ok)return;}catch{}await delay(100);}throw Error('server did not start');}
 async function stop(){ws?.terminate();if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}}
 async function watch(){ws=new WebSocket(`ws://127.0.0.1:${port}/ws/session?sessionId=${sid}`);ws.on('message',d=>events.push(JSON.parse(d.toString())));await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});}
 async function req(route,body,role='subject',status=200){const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Experiment-Token':tokens[role]||''},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data;}
 const route=a=>`/api/participant-experiments/${sid}/${a}`,state=(r='subject')=>req(route('state'),undefined,r),body=s=>({trialId:s.trialId,captureSequence:s.currentCaptureSequence});
 async function ackBoth(){const s=await state();for(const r of ['subject','photographer'])await req(route('ack'),{...body(s),phase:s.experimentPhase},r);}
 async function evaluate(r,retake,status=200,extra={}){const s=await state(r);return req(route('evaluation'),{...body(s),similarityRating:r==='subject'?2:6,satisfactionRating:r==='subject'?3:7,wantsRetake:retake,...extra},r,status);}
 async function capture(){const s=await state();const reference=await req(`/api/guides/${s.guideId}/features?sessionId=${sid}`);const observation=structuredClone(reference.referenceGuide);observation.source='auto';observation.confidence=1;observation.bodyCenter.x+=.2;observation.personBox.width=.2;observation.keypoints[4].y+=.2;observation.keypoints[5].y+=.15;write(fixture,observation);
  const reservation={...body(s),requestId:randomUUID(),captureTimestamp:Date.now()},c=await req(route('capture'),reservation,'photographer');assert.deepEqual(await req(route('capture'),reservation,'photographer'),c);
  const form=new FormData();form.append('draft',new Blob([Buffer.from('photo')],{type:'image/jpeg'}),'photo.jpg');
  const upload=()=>fetch(`${base}/api/sessions/${sid}/draft-photos`,{method:'POST',headers:{'X-Experiment-Token':tokens.photographer,'X-Flow-Capture-Sequence':String(c.captureSequence)},body:form});
  const result=await upload();assert.equal(result.status,200,await result.text());let next;
  for(let i=0;i<80;i++){next=await state();if(next.experimentPhase==='photoEvaluation')break;await delay(100);}assert.equal(next.experimentPhase,'photoEvaluation');assert.equal(next.analysisStatus,'success');assert.equal(next.guidance.length,0);
  const count=next.captureCount;assert.equal((await upload()).status,200);assert.equal((await state()).captureCount,count);return next;
 }
 try{
  await launch();assert.equal((await req('/api/participant-experiments/plans')).plans[0].available,true);
  const start=await req('/api/participant-experiments/start',{planId:'P01',startKey});tokens.subject=start.token;tokens.photographer=new URL(start.state.photographerJoinPath,base).searchParams.get('flowToken');
  assert.equal((await req('/api/participant-experiments/start',{planId:'P01',startKey})).token,start.token);await watch();
  assert.equal((await fetch(base+`/uploads/${sid}/experiment/flow.json`)).status,403);await ackBoth();const trialIds=[];
  for(const [index,condition] of ['C','A','B','C','B','C','A'].entries()){
   await ackBoth();await ackBoth();const s=await capture();trialIds.push(s.trialId);
   await evaluate('subject',true,400,{similarityRating:8});await evaluate('subject',true);
   assert.equal((await state()).viewPhase,'waitingForPartnerEvaluation');const p=await state('photographer');assert.equal(p.viewPhase,'photoEvaluation');assert.ok(!JSON.stringify(p).includes('similarityRating'));assert.ok(!p.photographerJoinPath);
   if(index===0){await stop();await launch();await watch();assert.equal((await state()).viewPhase,'waitingForPartnerEvaluation');}
   await evaluate('subject',true);await evaluate('subject',false,409);await evaluate('photographer',false);
   const gs=await state(),gp=await state('photographer');assert.equal(gs.experimentPhase,'guidance');assert.equal(gs.guidance.length,condition==='A'?0:condition==='B'?2:1);assert.equal(gp.guidance.length,condition==='A'?0:condition==='B'?2:1);assert.equal(gs.ready,null);assert.equal(gs.showReadyToParticipants,false);
   const retry=await fetch(base+`/api/sessions/${sid}/draft-photos`,{method:'POST',headers:{'X-Experiment-Token':tokens.photographer,'X-Flow-Capture-Sequence':String(gs.currentCaptureSequence)}});assert.equal(retry.status,200);assert.ok(!JSON.stringify(await retry.json()).includes('Evaluation'));
   for(const r of ['subject','photographer'])await req(route('displayed'),{...body(gs),displayedAt:Date.now()},r);
   await ackBoth();assert.equal((await state()).isLastCapture,true);await capture();await evaluate('photographer',false);await evaluate('subject',index%2===0);
   const q=await state();assert.equal(q.experimentPhase,'trialQuestionnaire');assert.equal(q.completionReason,'maximum_capture_count');assert.equal(q.questions.length,condition==='A'?4:8);
   for(const r of ['subject','photographer']){const answers=Object.fromEntries(q.questions.map(q=>[q.id,5]));await req(route('questionnaire'),{...body(q),answers,comment:'test'},r);await req(route('questionnaire'),{...body(q),answers:Object.fromEntries(Object.entries(answers).reverse()),comment:'test'},r);}
   assert.equal((await state()).experimentPhase,'trialCompleted');const t=read(path.join(dir,'experiment/trials',q.trialId,'trial.json'));assert.equal(t.finalPhotoId,q.photoId);assert.equal(t.finalCaptureSequence,q.currentCaptureSequence);
   const ev=read(path.join(dir,'experiment/trials',q.trialId,'evaluations',`capture_${q.currentCaptureSequence}.json`));assert.equal(ev.agreement.similarityGap,4);assert.ok(ev.guidanceToCaptureMs.subject>=0);assert.ok(read(path.join(dir,'analysis/history',ev.analysisId+'.json')).guidanceCandidates.length);
   assert.equal((await fetch(base+q.photoUrl)).status,200);await req(`/api/experiments/trials/${q.trialId}/events?sessionId=${sid}`,undefined,'subject',403);await ackBoth();
  }
  assert.equal((await state()).experimentPhase,'experimentCompleted');assert.equal(events.filter(e=>['roleGuidanceUpdated','analysisStarted','analysisFailed'].includes(e.type)).length,0);assert.ok(!JSON.stringify(events).includes('similarityRating'));
  for(const tid of trialIds){const log=fs.readFileSync(path.join(dir,'experiment/trials',tid,'events.jsonl'),'utf8');for(const event of ['photo_evaluation_started','evaluations_completed','retake_decided','trial_finish_decided','trial_questionnaire_submitted','trial_completed'])assert.ok(log.includes(`"${event}"`),event);}
  const derived=require('../research_data').inspectSession(dir);
  for(const t of derived.trials){assert.equal(t.timingComplete,true);assert.ok(t.humanOperationMs>=0);assert.ok(Number.isFinite(t.finalCenterError));assert.equal(t.questionnaireVersion,'role-aware-trial-v2');assert.equal(t.limitReached,true);assert.equal(t.mutualFinish,t.trialIndex%2===1);assert.equal(t.mutualFinishCensored,!t.mutualFinish);}
  assert.ok(derived.progress.length>0);
  const quality=read(path.join(dir,'experiment/data-quality-report.json'));assert.equal(quality.status,'complete');assert.equal(quality.trialsCompleted,6);assert.equal(quality.missingEvaluations,0);
  const noAuth=await fetch(base+'/api/research/plans/validation');assert.equal(noAuth.status,403);
  const validation=await (await fetch(base+'/api/research/plans/validation',{headers:{'X-Research-Token':'test-admin-secret'}})).json();assert.equal(validation.plans[0].available,true);assert.ok(validation.plans[0].issues.some(i=>i.code==='duplicate_reference'));
  const summary=await (await fetch(base+`/api/research/sessions/${sid}/summary`,{headers:{'X-Research-Token':'test-admin-secret'}})).json();assert.equal(summary.status,'complete');
  // An upload retry after answers were saved must never reveal either role's answers.
  const finalState=await state();const duplicate=await (await fetch(base+`/api/sessions/${sid}/draft-photos`,{method:'POST',headers:{'X-Experiment-Token':tokens.photographer,'X-Flow-Capture-Sequence':String(finalState.currentCaptureSequence)}})).json();assert.ok(!JSON.stringify(duplicate).includes('Evaluation'));
  await req(route('reset'),{});assert.equal((await state('photographer')).participantReset,true);assert.equal(read(path.join(dir,'experiment/data-quality-report.json')).status,'complete');
  passed=true;console.log('participant HTTP/WS passed: practice + 6 ordered trials, A/B/C, independent/duplicate answers, restart while waiting, max, final photos, data joins and logs');
 }finally{await stop();for(const p of [temp,sourceDir,dir])fs.rmSync(p,{recursive:true,force:true});if(stderr&&!passed)process.stderr.write(stderr);}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
