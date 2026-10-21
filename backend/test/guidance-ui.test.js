// Exercise the shipped selection/rendering and stale-result guards with a tiny DOM.
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, {hidden:true, style:{}, dataset:{}, children:[], value:"0.5", clientWidth:300, clientHeight:400,
    classList:{toggle(){},add(){},remove(){}},addEventListener(){},setAttribute(){},appendChild(c){this.children.push(c);}});
  return elements.get(id);
}
const context = vm.createContext({console,URL,URLSearchParams, setTimeout:()=>0,clearTimeout(){},
  window:{addEventListener(){},location:{href:"http://localhost/",origin:"http://localhost",search:""}},
  document:{getElementById:element,querySelector:element,querySelectorAll:()=>[element("toggleGuideBtn")],createElement:()=>element(Math.random()),addEventListener(){}},
  localStorage:{getItem(){return null;},setItem(){}}, WebSocket:{OPEN:1}, location:{origin:"http://localhost"}});
let source=fs.readFileSync(path.resolve(__dirname,"../../photographer/script.js"),"utf8");
source=source.slice(0,source.lastIndexOf("\nupdatePhotoCount();"));
vm.runInContext(source,context);
function run(code){return vm.runInContext(code,context);}
run(`applyExperimentState({guidanceProtocolVersion:"progressive-v1",conditionId:"A",currentTrial:{trialId:"t",state:"running",guideId:"g",guideUrl:"/g.png",referenceImageUrl:"/ref.jpg"}})`);
assert.equal(run("photographerGuidanceEnabled()"),false);
assert.equal(element("toggleGuideBtn").hidden,false);
assert.equal(run("activeGuideId"),"g");
run(`photos=[{captureSequence:2,trialId:"t",guideId:"g",deleted:false}];`);
assert.equal(run(`shouldDisplayAnalysisPayload({captureSequence:1,guideId:"g"},photos[0])`),false);
assert.equal(run(`shouldDisplayAnalysisPayload({captureSequence:2,guideId:"other"},photos[0])`),false);
assert.equal(run(`displayCompletedAnalysis(photos[0],{captureSequence:2,guideId:"g",guidanceSuppressed:true})`),false);
run(`applyExperimentState({guidanceProtocolVersion:"progressive-v1",conditionId:"B",currentTrial:{trialId:"t2",state:"running",guideId:"g2",guideUrl:"/g2.png"}})`);
assert.equal(run("photographerGuidanceEnabled()"),true);
assert.equal(run("latestDisplayedCaptureSequence"),null);
run(`renderRoleGuidance({photographerGuidance:[],ready:{framingReady:true}})`);
assert.equal(element("roleGuidancePanel").hidden,false);
assert.equal(element("photographerGuidanceList").children.at(-1).textContent,"構図はOKです");
console.log("guidance UI passed: A visual guide/no automation, stale guard, condition reset, resolved message");

assert.equal(element("referenceThumbnail").src, "/api/guides/g2/reference?sessionId=");
run('setReferenceThumbnail("/cropped-reference.jpg")');
assert.equal(element("referenceThumbnail").hidden, true);
element("referenceThumbnail").onload();
assert.equal(element("referenceThumbnail").hidden, false);
run('setReferenceThumbnail("/next-reference.jpg")');
assert.equal(element("referenceThumbnail").hidden, true);
element("referenceThumbnail").onerror();
assert.equal(element("referenceThumbnail").hidden, true);
run('setReferenceThumbnail(null)');
assert.equal(element("referenceThumbnail").hidden, true);
console.log("reference thumbnail passed: guide switch, loading, failure, clear");
