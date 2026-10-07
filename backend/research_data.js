// Offline analysis export. Missing/corrupt records are reported, never imputed.
const fs=require('node:fs'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto');
const {trialMetrics,agreement}=require('./study_metrics');
const ROLES=['photographer','subject'];
const captureColumns=`participantPairId sessionId trialId trialIndex isPractice conditionId guidanceProtocolVersion flowProtocolVersion referenceImageId captureSequence photoId analysisId captureTimestamp analysisStatus analysisFailureReason compositionError centerError scaleError poseError totalError framingReady poseReady captureReady photographerSimilarity subjectSimilarity similarityGap photographerSatisfaction subjectSatisfaction satisfactionGap photographerWantsRetake subjectWantsRetake nextAction completionReason photographerGuidanceCount subjectGuidanceCount guidanceToNextCaptureMsPhotographer guidanceToNextCaptureMsSubject mutualFinish limitReached questionnaireVersion`.split(' ');
const trialColumns=`participantPairId sessionId trialId trialIndex isPractice conditionId referenceImageId trialStartTimestamp captureEndTimestamp trialEndTimestamp captureCount retakeCount guidanceDisplayCount completionReason finalPhotoId finalCaptureSequence finalCompositionError finalPoseError finalTotalError finalPhotographerSimilarity finalSubjectSimilarity finalSimilarityGap finalPhotographerSatisfaction finalSubjectSatisfaction finalSatisfactionGap analysisFailureCount missingEvaluationCount finalCenterError finalScaleError centerImprovement scaleImprovement poseImprovement mutualFinish limitReached capturesToMutualFinish mutualFinishCensored trialDurationMs captureAdjustmentMs guidanceReviewMs analysisCommunicationMs evaluationMs questionnaireMs humanOperationMs timingComplete questionnaireVersion studyId orderId assignmentId`.split(' ');
const questionnaireColumns=`participantPairId sessionId trialId conditionId role questionId response submittedAt questionnaireVersion`.split(' ');
function atomic(p,value){fs.mkdirSync(path.dirname(p),{recursive:true});const temp=p+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(temp,p);}
function names(dir){return fs.existsSync(dir)?fs.readdirSync(dir).sort():[];}
function retained(dir){return fs.existsSync(path.join(dir,'experiment','flow.json'))||fs.existsSync(path.join(dir,'experiment','retention.json'))||(()=>{try{return !!JSON.parse(fs.readFileSync(path.join(dir,'experiment/session.json'))).flowProtocolVersion;}catch{return false;}})();}
function shouldExpire(dir,now,ttl){return !retained(dir)&&now-fs.statSync(dir).mtimeMs>=ttl;}
function status(v){return v==='completed'?'success':v??null;}
function inspectSession(dir){
 const issues=[],captures=[],trials=[],questionnaires=[],progress=[];const sid=path.basename(dir);
 function issue(code,details={},severity='error'){issues.push({code,severity,sessionId:sid,...details});}
 function read(file,optional=false){try{return JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'));}catch(e){if(!optional||e.code!=='ENOENT')issue(e.code==='ENOENT'?'missing_file':'unreadable_json',{file});return null;}}
 const f=read('experiment/flow.json')||{},session=read('experiment/session.json')||{},plan=read('experiment/experiment-plan.json')||{};
 const pair=f.pairId??session.participantPairId??plan.pairId;
 const folders=names(path.join(dir,'experiment/trials')).filter(n=>fs.statSync(path.join(dir,'experiment/trials',n)).isDirectory());
 const expected=f.trialIds||plan.trialIds||[];
 const seenTrials=new Set(),seenCaptures=new Set(),seenPhotos=new Set();let duplicateSubmissions=0,missingQuestionnaires=0,missingFinalAnalysis=0;
 for(const tid of expected)if(!folders.includes(tid))issue('missing_trial',{trialId:tid});
 for(const tid of new Set(expected)){if(expected.filter(t=>t===tid).length>1)issue('duplicate_trial',{trialId:tid});}
 for(const folder of folders){
  const prefix=`experiment/trials/${folder}`,t=read(`${prefix}/trial.json`);if(!t)continue;
  const tid=t.trialId??folder,ctx={trialId:tid};
  if(seenTrials.has(tid))issue('duplicate_trial',ctx);seenTrials.add(tid);
  if(tid!==folder)issue('trial_id_mismatch',ctx);
  const planItem=plan.items?.[expected.indexOf(tid)] ?? (t.isPractice?plan.practice:plan.trials?.[t.trialIndex-1]);
  if(planItem&&planItem.condition!==t.conditionId)issue('condition_mismatch',{...ctx,source:'plan'});
  const common={participantPairId:pair,sessionId:sid,trialId:tid,trialIndex:t.trialIndex,isPractice:t.isPractice,conditionId:t.conditionId,referenceImageId:t.referenceImageId,guidanceProtocolVersion:t.guidanceProtocolVersion,flowProtocolVersion:t.flowProtocolVersion??f.flowProtocolVersion,questionnaireVersion:f.config?.questionnaireVersion||'legacy-trial-v1',studyId:plan.studyId,orderId:plan.orderId,assignmentId:plan.assignmentId};
  const auditPath=path.join(dir,prefix,'events.jsonl'),auditRecords=[],eventIds=new Set();
  if(fs.existsSync(auditPath))for(const [i,line] of fs.readFileSync(auditPath,'utf8').split('\n').entries()){
   if(!line.trim())continue;try{const ev=JSON.parse(line);auditRecords.push(ev);if(ev.eventId&&eventIds.has(ev.eventId))issue('duplicate_event',{...ctx,line:i+1},'warning');eventIds.add(ev.eventId);if(ev.eventType==='duplicate_submission')duplicateSubmissions++;}catch{issue('unreadable_event',{...ctx,line:i+1});}
  }
  const entries=[];
  for(const file of names(path.join(dir,prefix,'evaluations')).filter(n=>n.endsWith('.json'))){
   const c=read(`${prefix}/evaluations/${file}`);if(!c)continue;
   if(!c.photoId){issue('unuploaded_capture',{...ctx,captureSequence:c.captureSequence},'warning');continue;}
   const cctx={...ctx,captureSequence:c.captureSequence};
   if(seenCaptures.has(c.captureSequence)||seenPhotos.has(c.photoId))issue('duplicate_capture',cctx);
   seenCaptures.add(c.captureSequence);seenPhotos.add(c.photoId);
   let a=null;if(c.analysisId&&/^[\w.-]+$/.test(c.analysisId))a=read(`analysis/history/${c.analysisId}.json`);
   else issue('missing_analysis_id',cctx,'warning');
   if(c.analysisId&&!a)issue('missing_analysis',cctx);
   if(a&&((a.trialId!=null&&a.trialId!==tid)||(a.photoId!=null&&a.photoId!==c.photoId)||(a.captureSequence!=null&&a.captureSequence!==c.captureSequence)||(a.analysisId!=null&&a.analysisId!==c.analysisId))){issue('analysis_join_mismatch',cctx);a=null;}
   if(a?.conditionId!=null&&a.conditionId!==t.conditionId){issue('condition_mismatch',{...cctx,source:'analysis'});a=null;}
   if(c.conditionId!=null&&c.conditionId!==t.conditionId)issue('condition_mismatch',{...cctx,source:'evaluation'});
   const analysisStatus=status(c.analysisStatus??a?.analysisStatus);
   if(analysisStatus==='failed')issue('analysis_failure',cctx,'warning');
   if(analysisStatus==='not_available')issue('analysis_not_available',cctx,'warning');
   if(!['success','failed','not_available'].includes(analysisStatus))issue('analysis_unfinished',cctx);
   for(const role of ROLES)if(!c[role+'Evaluation'])issue('missing_evaluation',{...cctx,role});
   const e=analysisStatus==='success'?(a?.alignmentError||{}):{},p=c.photographerEvaluation||{},s=c.subjectEvaluation||{};
   // compositionError has no aggregate definition in progressive-v1: leave blank unless explicitly stored.
   const row={...common,captureSequence:c.captureSequence,photoId:c.photoId,analysisId:c.analysisId,captureTimestamp:c.captureTimestamp,analysisStatus,analysisFailureReason:c.analysisFailureReason??c.errorReason??a?.errorReason,
    mutualFinish:agreement(c),limitReached:c.decision?.limitReached??(c.decision?.completionReason==='maximum_capture_count'?true:null),compositionError:e.compositionError,centerError:e.centerError,scaleError:e.scaleError,poseError:e.poseError,totalError:e.totalError,
    framingReady:a?.ready?.framingReady,poseReady:a?.ready?.poseReady,captureReady:a?.ready?.captureReady,
    photographerSimilarity:p.similarityRating,subjectSimilarity:s.similarityRating,similarityGap:c.agreement?.similarityGap,
    photographerSatisfaction:p.satisfactionRating,subjectSatisfaction:s.satisfactionRating,satisfactionGap:c.agreement?.satisfactionGap,
    photographerWantsRetake:p.wantsRetake,subjectWantsRetake:s.wantsRetake,nextAction:c.decision?.nextAction,completionReason:c.decision?.completionReason,
    photographerGuidanceCount:Array.isArray(a?.photographerGuidance)?a.photographerGuidance.length:null,subjectGuidanceCount:Array.isArray(a?.subjectGuidance)?a.subjectGuidance.length:null};
   entries.push({c,row,a});captures.push(row);
   for(const change of a?.guidanceProgress||[])progress.push({...common,analysisId:c.analysisId,...change});
  }
  // A lost evaluation file must not silently remove a known capture from the CSV.
  for(const ev of auditRecords.filter(ev=>ev.eventType==='photo_captured')){
   const c=ev.payload||{};if(!c.photoId||entries.some(v=>v.c.photoId===c.photoId))continue;
   issue('missing_capture_evaluation',{...ctx,captureSequence:c.captureSequence});
   for(const role of ROLES)issue('missing_evaluation',{...ctx,captureSequence:c.captureSequence,role});
   const row={...common,captureSequence:c.captureSequence,photoId:c.photoId,analysisId:c.analysisId,captureTimestamp:c.captureTimestamp};
   entries.push({c,row,a:null,missingRecord:true});captures.push(row);
  }
  for(const {c,row} of entries){const next=entries.find(v=>v.c.previousCaptureSequence===c.captureSequence);row.guidanceToNextCaptureMsPhotographer=next?.c.guidanceToCaptureMs?.photographer;row.guidanceToNextCaptureMsSubject=next?.c.guidanceToCaptureMs?.subject;}
  const final=entries.find(v=>v.c.captureSequence===t.finalCaptureSequence);
  if(t.finalCaptureSequence==null)issue('missing_final_capture_sequence',ctx);
  else if(!final||final.missingRecord)issue('missing_final_evaluation',ctx);
  if(t.finalPhotoId&&final&&t.finalPhotoId!==final.c.photoId)issue('final_photo_mismatch',ctx);
  if(t.finalCaptureSequence!=null&&!final?.a){missingFinalAnalysis++;issue('missing_final_analysis',ctx);}
  if(t.finalPhotoId&&!fs.existsSync(path.join(dir,'photos',path.basename(t.finalPhotoId))))issue('missing_final_photo',ctx);
  const q=read(`${prefix}/questionnaire.json`,true);
  for(const role of ROLES){const response=q?.responses?.[role];const required=(f.config?.questions||[]).filter(q=>!q.conditions||q.conditions.includes(t.conditionId));
   if(!response||required.some(q=>response.answers?.[q.id]==null)){missingQuestionnaires++;issue('missing_questionnaire',{...ctx,role});}
   if(response){for(const [questionId,value] of Object.entries(response.answers||{}))questionnaires.push({...common,role,questionId,response:value,submittedAt:response.submittedAt});
    if(response.comment!=null)questionnaires.push({...common,role,questionId:'freeText',response:response.comment,submittedAt:response.submittedAt});}
  }
  const r=final?.row||{};
  trials.push({...common,...trialMetrics(entries,final,t,auditRecords),trialStartTimestamp:t.startTime,captureEndTimestamp:t.captureEndTime,trialEndTimestamp:t.endTime,captureCount:entries.length,retakeCount:entries.filter(v=>v.c.decision?.nextAction==='retake').length,guidanceDisplayCount:entries.reduce((n,v)=>n+Object.keys(v.c.guidanceDisplays||{}).length,0),completionReason:t.completionReason,finalPhotoId:t.finalPhotoId,finalCaptureSequence:t.finalCaptureSequence,finalCompositionError:r.compositionError,finalPoseError:r.poseError,finalTotalError:r.totalError,finalPhotographerSimilarity:r.photographerSimilarity,finalSubjectSimilarity:r.subjectSimilarity,finalSimilarityGap:r.similarityGap,finalPhotographerSatisfaction:r.photographerSatisfaction,finalSubjectSatisfaction:r.subjectSatisfaction,finalSatisfactionGap:r.satisfactionGap,analysisFailureCount:entries.filter(v=>v.row.analysisStatus==='failed').length,missingEvaluationCount:entries.reduce((n,v)=>n+ROLES.filter(r=>!v.c[r+'Evaluation']).length,0),state:t.state});
 }
 const main=trials.filter(t=>t.isPractice===false),expectedMain=f.totalTrials??plan.trials?.length??null;
 const declared=f.experimentStatus??session.experimentStatus??f.experimentPhase;
 const terminal=declared==='completed'||declared==='experimentCompleted';
 let resultStatus=declared==='withdrawn'?'withdrawn':declared==='technical_failure'?'technical_failure':!terminal||issues.some(i=>i.severity==='error')||expectedMain!==main.filter(t=>t.state==='completed').length?'incomplete':issues.length?'complete_with_warnings':'complete';
 const report={schemaVersion:'research-export-v1',generatedAt:new Date().toISOString(),participantPairId:pair,sessionId:sid,status:resultStatus,experimentStatus:declared,
  trialsExpected:expectedMain,trialsCompleted:main.filter(t=>t.state==='completed').length,practice:trials.find(t=>t.isPractice)?.state??null,
  conditionCounts:Object.fromEntries(['A','B','C'].map(c=>[c,main.filter(t=>t.conditionId===c).length])),captures:captures.length,retakes:trials.reduce((n,t)=>n+t.retakeCount,0),missingEvaluations:trials.reduce((n,t)=>n+t.missingEvaluationCount,0),missingQuestionnaires,analysisFailures:captures.filter(c=>c.analysisStatus==='failed').length,missingFinalAnalysis,duplicateSubmissions,issues};
 return {captures,trials,questionnaires,progress,report};
}
const progressColumns='participantPairId sessionId trialId conditionId referenceImageId analysisId previousAnalysisId previousCaptureSequence captureSequence candidateId targetRole guidanceCategory wasSelected beforeError afterError improvement improved resolved newlyResolved regressed status captureIntervalMs'.split(' ');
function csv(columns,rows){const cell=v=>{if(v==null)return '';let s=String(v);if(typeof v==='string'&&/^[=+@\-\t\r]/.test(s))s="'"+s;return /[",\r\n]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;};return '\uFEFF'+[columns.join(','),...rows.map(r=>columns.map(k=>cell(r[k])).join(','))].join('\r\n')+'\r\n';}
function researchSessions(root){return names(root).filter(n=>fs.statSync(path.join(root,n)).isDirectory()&&retained(path.join(root,n)));}
function separateOutput(root,out){const relative=path.relative(path.resolve(root),path.resolve(out));if(!relative||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)))throw Error('Output must be outside the uploads/research source directory');}
function exportData(root,out){
 separateOutput(root,out);
 fs.mkdirSync(out,{recursive:true});const results=researchSessions(root).map(s=>inspectSession(path.join(root,s)));
 for(const [file,cols,key] of [['capture-level.csv',captureColumns,'captures'],['trial-level.csv',trialColumns,'trials'],['questionnaire-responses.csv',questionnaireColumns,'questionnaires'],['guidance-progress.csv',progressColumns,'progress']])fs.writeFileSync(path.join(out,file),csv(cols,results.flatMap(r=>r[key])),{mode:0o600});
 const respondents=new Map(),questionIds=new Set();
 for(const r of results.flatMap(r=>r.questionnaires)){const key=[r.sessionId,r.trialId,r.role].join(':');if(!respondents.has(key))respondents.set(key,{participantPairId:r.participantPairId,sessionId:r.sessionId,trialId:r.trialId,conditionId:r.conditionId,role:r.role,submittedAt:r.submittedAt,questionnaireVersion:r.questionnaireVersion,answers:{}});const row=respondents.get(key);row.answers[r.questionId]=r.response;row['answer:'+r.questionId]=r.response;questionIds.add(r.questionId);}
 const rows=[...respondents.values()].map(r=>({...r,questionId:JSON.stringify(Object.keys(r.answers)),response:JSON.stringify(r.answers)}));
 fs.writeFileSync(path.join(out,'questionnaire-level.csv'),csv([...questionnaireColumns,...[...questionIds].sort().map(q=>'answer:'+q)],rows),{mode:0o600});
 atomic(path.join(out,'data-quality-report.json'),{schemaVersion:'research-export-v1',sessions:results.map(r=>r.report)});return results.map(r=>r.report);
}
function backup(root,out){
 separateOutput(root,out);
 fs.mkdirSync(path.dirname(out),{recursive:true,mode:0o700});fs.mkdirSync(out,{recursive:false,mode:0o700});const manifest={schemaVersion:'research-backup-v1',createdAt:new Date().toISOString(),files:[]};
 function copy(src,dest,relative){for(const n of names(src)){const a=path.join(src,n),b=path.join(dest,n),rel=path.join(relative,n),stat=fs.lstatSync(a);if(stat.isSymbolicLink())throw Error('Backup does not follow symlinks: '+rel);if(stat.isDirectory()){fs.mkdirSync(b,{recursive:true,mode:0o700});copy(a,b,rel);}else if(stat.isFile()){const data=fs.readFileSync(a);fs.mkdirSync(path.dirname(b),{recursive:true,mode:0o700});fs.writeFileSync(b,data,{mode:0o600});manifest.files.push({path:rel,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});}}}
 const sessions=researchSessions(root);for(const s of sessions)copy(path.join(root,s),path.join(out,s),s);
 const sourceFiles=[];function scan(dir,relative){for(const n of names(dir)){const p=path.join(dir,n),rel=path.join(relative,n);if(fs.statSync(p).isDirectory())scan(p,rel);else sourceFiles.push(rel);}}
 for(const s of researchSessions(root))scan(path.join(root,s),s);
 if(JSON.stringify(sourceFiles.sort())!==JSON.stringify(manifest.files.map(f=>f.path).sort()))throw Error('Source files changed during backup; stop the backend and retry. Incomplete directory: '+out);
 for(const entry of manifest.files){const current=fs.readFileSync(path.join(root,entry.path));if(createHash('sha256').update(current).digest('hex')!==entry.sha256)throw Error('Source changed during backup; stop the backend and retry. Incomplete directory: '+out);}
 atomic(path.join(out,'manifest.json'),manifest);return manifest;
}
function writeQuality(dir){const result=inspectSession(dir);atomic(path.join(dir,'experiment/data-quality-report.json'),result.report);return result.report;}
module.exports={inspectSession,exportData,backup,writeQuality,retained,shouldExpire,researchSessions,captureColumns,trialColumns,questionnaireColumns,atomic};
