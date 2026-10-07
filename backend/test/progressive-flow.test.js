// Real HTTP/WS + Python scoring/rendering, only image-model inference is replaced.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const {spawn} = require("node:child_process");
const {randomUUID} = require("node:crypto");
const {WebSocket} = require("ws");
const backend = path.resolve(__dirname, "..");
const python = process.env.TEST_PYTHON || path.join(backend, ".venv/bin/python");
async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "progressive-flow-"));
  const fixture = path.join(temp, "observation.json");
  const wrapper = path.join(temp, "python-fixture");
  fs.writeFileSync(wrapper, `#!${python}\nimport sys,os,json,shutil\nif os.path.basename(sys.argv[1]) == 'extract_live_features.py':\n    os.makedirs(os.path.dirname(sys.argv[sys.argv.index('--output')+1]),exist_ok=True)\n    shutil.copyfile(os.environ['OBSERVATION_FIXTURE'], sys.argv[sys.argv.index('--output')+1])\nelse:\n    os.execv(${JSON.stringify(python)}, [${JSON.stringify(python)}]+sys.argv[1:])\n`);
  fs.chmodSync(wrapper, 0o700);
  const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.on("error", reject); server.listen(0,"127.0.0.1",() => {const p=server.address().port;server.close(()=>resolve(p));}); });
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath,["server.js"],{cwd:backend,env:{...process.env,PORT:String(port),HOST:"127.0.0.1",PYTHON:wrapper,OBSERVATION_FIXTURE:fixture},stdio:["ignore","ignore","pipe"]});
  let stderr="";child.stderr.on("data", c=>stderr+=c);
  let ws;
  const sessionId=`progressive-${randomUUID()}`;
  const dir=path.join(backend,"uploads",sessionId);
  async function request(route,body,method="POST",expected=200) {
    const response=await fetch(base+route,{method,headers:{"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
    const value=await response.json(); assert.equal(response.status,expected,JSON.stringify(value));return value;
  }
  try {
    let ready=false;
    for(let i=0;i<50;i++){try{if((await fetch(base+"/health")).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
    assert.ok(ready,"server startup");
    await request("/api/experiments/sessions",{sessionId,participantId:"p",pairId:"pair",conditionId:"A",referenceImageId:"ref"},"POST",201);
    const points=[["leftShoulder",.4,.3],["rightShoulder",.6,.3],["leftHip",.43,.6],["rightHip",.57,.6],["leftWrist",.2,.5],["rightWrist",.8,.5]].map(([name,x,y])=>({name,x,y,confidence:0,isEnabled:true}));
    const pose={source:"auto",versionId:"auto-1",personCount:1,referenceImageId:"ref",boundingBox:{x:.2,y:.1,width:.6,height:.8},keypoints:points,image:{filename:"ref.jpg",url:`/uploads/${sessionId}/references/ref.jpg`}};
    const poseDir=path.join(dir,"experiment/references/ref");fs.mkdirSync(poseDir,{recursive:true});fs.writeFileSync(path.join(poseDir,"current.json"),JSON.stringify(pose));
    const saved=await request(`/api/experiments/sessions/${sessionId}/references/ref/pose`,{...pose,correctedBy:"experimenter"},"PUT");
    const events=[];ws=new WebSocket(`ws://127.0.0.1:${port}/ws/session?sessionId=${sessionId}`);
    ws.on("message",d=>events.push(JSON.parse(d.toString())));await new Promise((r,j)=>{ws.once("open",r);ws.once("error",j);});
    let sequence=0;
    for(const conditionId of ["A","B","C"]){
      await request(`/api/experiments/sessions/${sessionId}/condition`,{conditionId},"PATCH");
      const {trial}=await request(`/api/experiments/sessions/${sessionId}/trials`,{referenceImageId:"ref"},"POST",201);
      assert.equal(trial.referencePoseVersion,saved.pose.versionId);
      const reference=(await request(`/api/guides/${trial.guideId}/features?sessionId=${sessionId}`,undefined,"GET")).referenceGuide;
      assert.equal(reference.keypoints[0].confidence,1);
      assert.equal((await fetch(base+trial.guideUrl)).status,200);
      await request(`/api/experiments/trials/${trial.trialId}/start`,{sessionId});
      async function capture(observation, seq=++sequence) {
        fs.writeFileSync(fixture,JSON.stringify(observation));
        const form=new FormData();form.append("trialId",trial.trialId);form.append("clientId",`c${seq}`);form.append("captureSequence",seq);form.append("captureTimestamp",10000+seq*1000);form.append("guideId",trial.guideId);form.append("draft",new Blob([Buffer.from("photo")],{type:"image/jpeg"}),"photo.jpg");
        const draft=await (await fetch(`${base}/api/sessions/${sessionId}/draft-photos`,{method:"POST",body:form})).json();
        const result=await request(`/api/sessions/${sessionId}/photos/${draft.photo.photoId}/analyze`,{trialId:trial.trialId,guideId:trial.guideId,captureSequence:seq,captureTimestamp:10000+seq*1000,clientId:`c${seq}`});
        return {result,photoId:draft.photo.photoId,stored:JSON.parse(fs.readFileSync(path.join(dir,"analysis/role_guidance",draft.photo.photoId+".json")))};
      }
      const observation=structuredClone(reference);observation.source="auto";observation.confidence=1;observation.bodyCenter.x+=.2;observation.personBox.width=.2;observation.keypoints[4].y+=.2;observation.keypoints[5].y+=.15;
      const {result,stored,photoId}=await capture(observation);
      assert.equal(stored.guidanceCandidates.length,8);
      assert.ok(stored.guidanceConfig.thresholds.pose);
      if(conditionId==="A"){
        assert.equal(result.guidanceSuppressed,true);assert.equal(result.ready,undefined);
        assert.equal(stored.selectedGuidance.length,0);
        assert.equal(events.filter(e=>e.type==="roleGuidanceUpdated"&&e.trialId===trial.trialId).length,0);
      } else {
        assert.equal(result.photographerGuidance.length,conditionId==="B"?2:1);
        assert.equal(result.subjectGuidance.length,conditionId==="B"?2:1);
      }
      if(conditionId==="C"){
        // Later edits must not silently change the trial's ground truth.
        const changed=structuredClone(saved.pose);changed.keypoints[4].y=.9;
        await request(`/api/experiments/sessions/${sessionId}/references/ref/pose`,changed,"PUT");
        const next=await capture({...reference,source:"auto",confidence:1});
        assert.equal(next.result.ready.captureReady,true);
        assert.ok(next.result.guidanceProgress.some(p=>p.wasSelected&&p.newlyResolved));
        assert.equal(next.result.referenceGuide.keypoints[4].y,.5);
        const stale=await capture(observation,sequence-1);assert.equal(stale.result.isLatestAnalysis,false);
        const again=await capture(observation);assert.ok(again.result.guidanceProgress.some(p=>p.regressed));
        await request(`/api/sessions/${sessionId}/photos/${photoId}/analyze`,{trialId:trial.trialId,guideId:"wrong"},"POST",409);
      }
      const eventsPath=path.join(dir,"experiment/trials",trial.trialId,"events.jsonl");
      assert.ok(fs.readFileSync(eventsPath,"utf8").includes('"guidanceCandidates"'));
      await request(`/api/sessions/${sessionId}/photos/share`,{photoIds:[photoId]});
      await request(`/api/experiments/trials/${trial.trialId}/end`,{sessionId});
    }
    console.log("progressive flow passed: corrected/frozen reference, A/B/C, progress, regression, stale analysis, logs, photo share");
  } finally {
    ws?.close();
    try{await request(`/api/session/${sessionId}`,undefined,"DELETE");}catch{}
    child.kill("SIGTERM");await new Promise(r=>child.exitCode!==null?r():child.once("exit",r));
    fs.rmSync(temp,{recursive:true,force:true});
    if(stderr) process.stderr.write(stderr);
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
