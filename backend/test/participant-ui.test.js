const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const elements=new Map();
function node(key){if(!elements.has(key)){const n={children:[],classList:{add(){}},hidden:false,disabled:false,textContent:'',_html:'',prepend(c){this.children.unshift(c);},append(c){this.children.push(c);},insertAdjacentHTML(_,html){this._html+=html;},querySelectorAll(){return this.children.filter(c=>c.tag==='button');}};Object.defineProperty(n,'innerHTML',{get(){return this._html;},set(v){this._html=v;this.children=[];}});elements.set(key,n);}return elements.get(key);}
let state={revision:1,trialId:'t1',currentCaptureSequence:null,experimentPhase:'experimentIntroduction',viewPhase:'experimentIntroduction',isPractice:true,totalTrials:6,maximumCaptureCount:5,guidance:[],questions:[]};
const requests=[];let fail=false;let replaced=null;
function storage(){const data=new Map();return {get length(){return data.size;},key:i=>[...data.keys()][i],getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};}
const local=storage(),session=storage();
const context=vm.createContext({console,URLSearchParams,location:{search:'?sessionId=s&flowToken=token',replace:url=>replaced=url},sessionStorage:session,localStorage:local,window:{addEventListener(){}},document:{querySelector:node,getElementById:node,createElement(tag){const n=node(Math.random());n.tag=tag;return n;},addEventListener(){}},setInterval(){},setTimeout(){},Date,crypto:{randomUUID:()=> 'id'},
 fetch:async(url,options)=>{requests.push({url,body:options.body});if(fail)throw Error('offline');if(url.endsWith('/ack'))state={...state,revision:state.revision+1,experimentPhase:'referenceViewing',viewPhase:'referenceViewing'};return {ok:true,json:async()=>structuredClone(state)};},
 stopLiveShare(){},currentStream:null});
vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../../photographer/participant-flow.js'),'utf8'),context);
async function main(){const ui=context.window.participantFlowUI,panel=node('participantFlowPanel');
 // The created section is registered by ID in the real DOM; inspect its created object here.
 const actual=[...elements.values()].find(n=>n.id==='participantFlowPanel');
 fail=true;await ui.refresh();assert.equal(node('participantError').textContent,'offline');fail=false;await ui.refresh();
 assert.ok(actual.innerHTML.includes('ふたりで撮影'));await actual.children.find(n=>n.tag==='button').onclick();
 assert.ok(actual.innerHTML.includes('お手本写真'));assert.equal(actual.children.find(n=>n.tag==='button').disabled,false,'new screen must not retain submission lock');
 state={...state,revision:0,viewPhase:'experimentIntroduction'};await ui.refresh();assert.equal(ui.state.viewPhase,'referenceViewing','stale response ignored');
 state={...state,revision:3,experimentPhase:'guidance',viewPhase:'guidance',currentCaptureSequence:1,guidance:[],ready:null};await ui.refresh();assert.ok(actual.innerHTML.includes('もう一度撮影してください'));assert.ok(!actual.innerHTML.includes('構図はOK'));assert.equal(node('roleGuidancePanel').hidden,true);
 state={...state,revision:4,guidance:[{message:'少し近づいてください'},{message:'右へ移動してください'}]};await ui.refresh();assert.ok(actual.innerHTML.includes('少し近づいて'));assert.ok(actual.innerHTML.includes('右へ移動'));
 assert.equal(requests.filter(r=>r.url.endsWith('/displayed')).length,1,'display is idempotent per capture');
 state={...state,revision:5,guidance:[],showReadyToParticipants:false,ready:{framingReady:true}};await ui.refresh();assert.ok(!actual.innerHTML.includes('構図はOK'));
 local.setItem('evaluationDraft:s:t1:1:photoEvaluation','private');local.setItem('photoGuideCaptureSequence:s','1');local.setItem('unrelated','keep');session.setItem('participantToken:old','old-token');
 state={...state,revision:6,participantReset:true};await ui.refresh();assert.equal(ui.state,null);assert.equal(local.getItem('evaluationDraft:s:t1:1:photoEvaluation'),undefined);assert.equal(session.getItem('participantToken:s'),undefined);assert.equal(session.getItem('participantToken:old'),undefined);assert.equal(local.getItem('unrelated'),'keep');assert.equal(replaced,'/?participantReset=1');
 console.log('participant UI passed: complete participant reset, Ready hidden; offline feedback, transition buttons, stale snapshots, A generic only, B multiple, display deduplication');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
