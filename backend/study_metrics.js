// Derived measures use server state-transition timestamps, not unsynchronized device clocks.
const phaseKeys={capture:'captureAdjustmentMs',guidance:'guidanceReviewMs',analyzing:'analysisCommunicationMs',photoEvaluation:'evaluationMs',trialQuestionnaire:'questionnaireMs'};
const timingKeys=Object.values(phaseKeys);
function phaseTimes(events){
 const result=Object.fromEntries(timingKeys.map(k=>[k,null]));
 const transitions=events.filter(e=>e.eventType==='state_transition').map(e=>e.payload);
 const start=transitions.findIndex(e=>e.to==='capture'&&e.from==='referenceViewing');
 if(start<0)return {...result,humanOperationMs:null,timingComplete:false};
 const sums=Object.fromEntries(timingKeys.map(k=>[k,0]));let previous=transitions[start];
 for(const next of transitions.slice(start+1)){
  if(!Number.isFinite(previous.timestamp)||!Number.isFinite(next.timestamp)||next.timestamp<previous.timestamp||next.from!==previous.to)return {...result,humanOperationMs:null,timingComplete:false};
  const key=phaseKeys[previous.to];if(key)sums[key]+=next.timestamp-previous.timestamp;
  if(next.to==='trialCompleted')return {...sums,humanOperationMs:sums.captureAdjustmentMs+sums.guidanceReviewMs,timingComplete:true};
  previous=next;
 }
 return {...result,humanOperationMs:null,timingComplete:false};
}
const number=v=>typeof v==='number'&&Number.isFinite(v);
const difference=(a,b)=>number(a)&&number(b)?a-b:null;
function agreement(c){
 const p=c?.photographerEvaluation,s=c?.subjectEvaluation;
 return typeof p?.wantsRetake==='boolean'&&typeof s?.wantsRetake==='boolean'?!p.wantsRetake&&!s.wantsRetake:null;
}
function elapsed(start,end){const a=Date.parse(start),b=Date.parse(end);return Number.isFinite(a)&&Number.isFinite(b)&&b>=a?b-a:null;}
function trialMetrics(entries,final,t,events){
 const sorted=[...entries].sort((a,b)=>a.c.captureSequence-b.c.captureSequence),first=sorted[0]?.row;
 const mutualFinish=agreement(final?.c);
 const limitReached=typeof final?.c.decision?.limitReached==='boolean'?final.c.decision.limitReached:t.completionReason==='maximum_capture_count'?true:Number.isInteger(t.maximumCaptureCount)?entries.length>=t.maximumCaptureCount:null;
 return {finalCenterError:final?.row.centerError,finalScaleError:final?.row.scaleError,
  centerImprovement:difference(first?.centerError,final?.row.centerError),scaleImprovement:difference(first?.scaleError,final?.row.scaleError),poseImprovement:difference(first?.poseError,final?.row.poseError),
  mutualFinish,limitReached,capturesToMutualFinish:mutualFinish===true?entries.length:null,
  mutualFinishCensored:mutualFinish==null?null:mutualFinish?false:limitReached===true?true:null,
  trialDurationMs:elapsed(t.startTime,t.captureEndTime),...phaseTimes(events)};
}
module.exports={phaseTimes,trialMetrics,agreement};
