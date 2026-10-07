// Researcher-only generation; actual references are validated before installation.
const fs=require('node:fs'),path=require('node:path');
const {inspectPlan,loadPlans,referenceForPlan,configIssues}=require('./experiment_validation');
const ORDERS=['ABC','ACB','BAC','BCA','CAB','CBA'];
const validId=v=>typeof v==='string'&&/^[A-Za-z0-9_-]+$/.test(v);
function buildPlans(spec){
 if(!validId(spec.studyId))throw Error('studyIdには英数字・ハイフン・アンダースコアを指定してください');
 if(!Array.isArray(spec.pairIds)||!spec.pairIds.length||spec.pairIds.some(p=>!validId(p))||new Set(spec.pairIds.map(p=>p.toLowerCase())).size!==spec.pairIds.length)throw Error('pairIdsには重複しないペア番号を指定してください');
 const refs=[spec.practice,...(spec.references||[])];
 if(refs.length!==7||refs.some(r=>!validId(r?.sourceSessionId)||!validId(r?.referenceImageId)))throw Error('練習1枚と本番6枚の参照セッションID・写真IDが必要です');
 if(new Set(refs.map(r=>r.sourceSessionId+':'+r.referenceImageId)).size!==7)throw Error('練習と本番の参照写真は重複できません');
 const maximum=spec.maximumCaptureCount??5,start=spec.startSlot??0;
 if(!Number.isInteger(maximum)||maximum<1||maximum>50)throw Error('maximumCaptureCountは1〜50の整数です');
 if(!Number.isSafeInteger(start)||start<0)throw Error('startSlotは0以上の整数です');
 return spec.pairIds.map((pairId,i)=>{
  const slot=start+i,orderIndex=slot%6,cycle=Math.floor(slot/6),assignment=(orderIndex+cycle)%3;
  const reverse=(orderIndex+Math.floor(cycle/3))%2===1,order=ORDERS[orderIndex];
  const trials=[...order].flatMap((condition,blockIndex)=>{
   const set=('ABC'.indexOf(condition)+assignment)%3,photos=spec.references.slice(set*2,set*2+2);
   if(reverse)photos.reverse();
   return photos.map((ref,withinBlockIndex)=>({sourceSessionId:ref.sourceSessionId,referenceImageId:ref.referenceImageId,condition,blockIndex:blockIndex+1,withinBlockIndex:withinBlockIndex+1}));
  });
  return {planId:`${spec.studyId}_${pairId}`,pairId,title:`撮影実験 ${pairId}`,designVersion:'role-aware-study-v1',studyId:spec.studyId,orderId:`O${orderIndex+1}`,assignmentId:`M${assignment+1}`,allocationSlot:slot,referenceOrderReversed:reverse,maximumCaptureCount:maximum,practice:{sourceSessionId:spec.practice.sourceSessionId,referenceImageId:spec.practice.referenceImageId,condition:'C'},trials};
 });
}
function generatePlans({spec,out,root,config,guidance}){
 const issues=configIssues(config,guidance);if(issues.length)throw Error(`実験設定が不正: ${JSON.stringify(issues)}`);
 const plans=buildPlans(spec),existing=loadPlans(out);
 for(const p of plans){
  if(existing.some(e=>e.planId===p.planId||e.pairId?.toLowerCase()===p.pairId.toLowerCase()))throw Error(`既存の計画またはペア番号と重複: ${p.pairId}`);
  if(existing.some(e=>e.studyId===p.studyId&&e.allocationSlot===p.allocationSlot))throw Error(`割当枠が登録済み: ${p.allocationSlot}。startSlotを変更してください`);
  const report=inspectPlan(p,[...existing,...plans],{config,prepareReference:item=>referenceForPlan(root,item,guidance)});
  if(!report.available)throw Error(`${p.pairId}: ${JSON.stringify(report.issues)}`);
 }
 const manifestName=`${spec.studyId}-assignment-${plans[0].allocationSlot}-${plans[plans.length-1].allocationSlot}.csv`;
 const files=[...plans.map(p=>({name:`${p.planId}.json`,data:JSON.stringify(p,null,2)+'\n'})),{name:manifestName,data:'pairId,planId,orderId,assignmentId,trialIndex,condition,sourceSessionId,referenceImageId\n'+plans.flatMap(p=>p.trials.map((t,i)=>[p.pairId,p.planId,p.orderId,p.assignmentId,i+1,t.condition,t.sourceSessionId,t.referenceImageId].join(','))).join('\n')+'\n'}];
 for(const f of files)if(fs.existsSync(path.join(out,f.name)))throw Error(`上書きしません: ${f.name}`);
 fs.mkdirSync(out,{recursive:true});const written=[];
 try{for(const f of files){const file=path.join(out,f.name);fs.writeFileSync(file,f.data,{flag:'wx',mode:0o600});written.push(file);}}
 catch(e){for(const file of written)fs.unlinkSync(file);throw e;}
 return {plans:plans.length,output:out,assignment:path.join(out,manifestName),warnings:plans.length%18?['18枠未満または端数の割当です。条件順・写真割当の偏りを確認してください。']:[]};
}
module.exports={ORDERS,buildPlans,generatePlans};
