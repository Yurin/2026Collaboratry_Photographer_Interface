const fs=require('node:fs'),path=require('node:path');
const {referenceFromPose}=require('./research_guidance');
const validId=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]+$/.test(v);
const maximum=v=>Number.isInteger(v)&&v>=1&&v<=50;
function loadPlans(root){if(!fs.existsSync(root))return [];return fs.readdirSync(root).sort().filter(n=>n.endsWith('.json')&&!n.endsWith('.example.json')).map(file=>{try{return {...JSON.parse(fs.readFileSync(path.join(root,file),'utf8')),_file:file};}catch{return {_file:file,_error:'unreadable_plan_json'};}});}
function configIssues(flow,guidance){
 const issues=[];const add=code=>issues.push({severity:'error',code});
 if(flow?.version!=="participant-flow-v1")add('invalid_flow_protocol');
 if(!flow||!maximum(flow.maximumCaptureCount))add('invalid_flow_maximum');
 if(flow?.showReadyToParticipants!=null&&typeof flow.showReadyToParticipants!=='boolean')add('invalid_ready_setting');
 if(!Array.isArray(flow?.questions)||!flow.questions.length)add('missing_questions');
 else{const ids=new Set();for(const q of flow.questions){if(!validId(q.id)||ids.has(q.id)||!q.text||(q.conditions!=null&&(!Array.isArray(q.conditions)||q.conditions.some(c=>!['A','B','C'].includes(c)))))add('invalid_question');ids.add(q.id);}}
 if(guidance){if(guidance.version!=='progressive-v1')add('invalid_guidance_protocol');for(const k of ['center','scale','pose'])if(!(Number.isFinite(guidance.thresholds?.[k])&&guidance.thresholds[k]>0))add('invalid_guidance_threshold');
 for(const key of ['composition_position','composition_scale','pose'])if(!(Number.isFinite(guidance.categoryWeights?.[key])&&guidance.categoryWeights[key]>0))add('invalid_guidance_weights');
 if(!(guidance.imageAspectRatio>0))add('invalid_image_aspect_ratio');
 if(!Array.isArray(guidance.poseTargets)||!guidance.poseTargets.length||!Number.isFinite(guidance.minConfidence)||!Number.isFinite(guidance.minTorsoLength)||guidance.minTorsoLength<=0)add('invalid_guidance_config');}
 return issues;
}
function inspectPlan(plan,plans,{config,prepareReference}){
 const issues=[];const add=(code,trialIndex=null,severity='error',detail)=>issues.push({code,trialIndex,severity,...(detail?{detail}:{})});
 if(plan?._error)add(plan._error);
 if(!validId(plan?.planId))add('invalid_plan_id');if(!validId(plan?.pairId))add('invalid_pair_id');
 if(plan?.planId&&plans.filter(p=>p.planId===plan.planId).length>1)add('duplicate_plan_id');
 if(!plan?.practice)add('missing_practice');
 if(!Array.isArray(plan?.trials)||!plan.trials.length)add('missing_trials');
 if(plan?.maximumCaptureCount!=null&&!maximum(plan.maximumCaptureCount))add('invalid_maximum_capture_count');
 if(plan?.guidanceProtocolVersion!=null&&plan.guidanceProtocolVersion!=='progressive-v1')add('invalid_guidance_protocol');
 for(const c of ['A','B','C'])if(!Array.isArray(plan?.trials)||!plan.trials.some(t=>t?.condition===c))add('missing_condition_'+c);
 const items=[{...plan?.practice,isPractice:true},...(Array.isArray(plan?.trials)?plan.trials:[]).map(t=>({...t,isPractice:false}))];
 const refs=new Set();
 items.forEach((item,index)=>{
  if(!['A','B','C'].includes(item.condition))add('invalid_condition',index);
  if(item.conditionId!=null&&item.conditionId!==item.condition)add('condition_mismatch',index);
  if(item.guidanceProtocolVersion!=null&&item.guidanceProtocolVersion!=='progressive-v1')add('invalid_guidance_protocol',index);
  item.maximumCaptureCount=item.maximumCaptureCount??plan?.maximumCaptureCount??config?.maximumCaptureCount;
  if(!maximum(item.maximumCaptureCount))add('invalid_maximum_capture_count',index);
  if(!validId(item.referenceImageId)||!validId(item.sourceSessionId)){add('invalid_reference_assignment',index);return;}
  if(index>0){if(refs.has(item.referenceImageId)&&plan.allowDuplicateReferences!==true)add('duplicate_reference',index,'warning');refs.add(item.referenceImageId);}
  try{prepareReference(item,null);}catch(e){add(e.code||'invalid_reference',index,'error',e.message);}
 });
 issues.push(...configIssues(config));
 return {planId:plan?.planId,pairId:plan?.pairId,file:plan?._file,available:!issues.some(i=>i.severity==='error'),totalTrials:Array.isArray(plan?.trials)?plan.trials.length:0,practiceCount:plan?.practice?1:0,issues,items};
}
function referenceForPlan(root,item,guidance){
 const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
 const dir=path.join(root,item.sourceSessionId),file=path.join(dir,'experiment/references',item.referenceImageId,'current.json');
 if(!fs.existsSync(dir))fail('missing_source_session','参照元sessionがありません');
 if(!fs.existsSync(file))fail('missing_pose','ReferencePose current.jsonがありません');
 let pose;try{pose=JSON.parse(fs.readFileSync(file,'utf8'));}catch{fail('unreadable_pose','ReferencePose current.jsonを読み込めません');}
 if(pose.personCount!==1&&pose.personCountApproved!==true)fail('unapproved_person_count','参照人物数の確認が必要です');
 let source;try{source=path.resolve(root,decodeURIComponent(new URL(pose.image.url,'http://local').pathname).replace(/^\/uploads\//,''));}catch{fail('missing_reference_image','参照画像URLが不正です');}
 if(!source.startsWith(path.resolve(dir)+path.sep)||!fs.existsSync(source)||!fs.statSync(source).isFile())fail('missing_reference_image','参照画像ファイルがありません');
 let reference;try{reference=referenceFromPose(pose,'preflight');}catch{fail('invalid_reference_guide','ReferenceGuideへ変換できません');}
 const points=new Map((reference.keypoints||[]).filter(p=>p.isEnabled!==false&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1&&p.confidence>=(guidance?.minConfidence??.3)).map(p=>[p.name,p]));
 if(!['leftShoulder','rightShoulder','leftHip','rightHip'].every(k=>points.has(k)))fail('missing_required_keypoints','左右の肩と腰の有効点が必要です');
 if(!(guidance?.poseTargets||[]).some(k=>points.has(k)))fail('missing_pose_targets','解析対象の有効keypointがありません');
 const mid=(a,b)=>({x:(points.get(a).x+points.get(b).x)/2,y:(points.get(a).y+points.get(b).y)/2}),shoulder=mid('leftShoulder','rightShoulder'),hip=mid('leftHip','rightHip');
 if(Math.hypot((shoulder.x-hip.x)*(guidance?.imageAspectRatio??.75),shoulder.y-hip.y)<(guidance?.minTorsoLength??.04))fail('invalid_torso','肩と腰の距離が解析に不足しています');
 return {pose,source,reference};
}
module.exports={loadPlans,inspectPlan,referenceForPlan,configIssues};
