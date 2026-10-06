#!/usr/bin/env node
// Local researcher CLI: no public unauthenticated export endpoint.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const {exportData,backup,inspectSession,researchSessions}=require('./research_data');
const {loadPlans,inspectPlan,referenceForPlan,configIssues}=require('./experiment_validation');
function options(args){const o={};for(let i=0;i<args.length;i+=2){if(!args[i].startsWith('--')||!args[i+1])throw Error('Options require --name value');o[args[i].slice(2)]=args[i+1];}return o;}
function readiness({root,plansDir,flowPath,guidancePath,exportDir,backupDir,python}){
 const checks=[];const add=(status,check,details)=>checks.push({status,check,details});
 function read(p,label){try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch{add('FAIL',label,'JSONを読み込めません');return null;}}
 const flow=read(flowPath,'flow config'),guidance=read(guidancePath,'guidance config');
 for(const i of configIssues(flow,guidance))add('FAIL',i.code);
 if(flow&&guidance&&!configIssues(flow,guidance).length)add('PASS','configs');
 const plans=loadPlans(plansDir);if(!plans.length)add('FAIL','experiment plans','有効な計画ファイルがありません');
 const reports=plans.map(p=>inspectPlan(p,plans,{config:flow,prepareReference:item=>referenceForPlan(root,item,guidance)}));
 for(const r of reports){add(r.available?'PASS':'FAIL','plan '+(r.planId||r.file),r.issues);}
 for(const r of reports)for(const i of r.issues.filter(i=>i.severity==='warning'))add('WARNING','plan '+r.planId,i);
 for(const [label,dir] of [['research data directory',root],['export directory',exportDir],['backup directory',backupDir]]){try{fs.mkdirSync(dir,{recursive:true});const p=path.join(dir,'.write-check-'+process.pid);fs.writeFileSync(p,'',{flag:'wx',mode:0o600});fs.unlinkSync(p);add('PASS',label);}catch{add('FAIL',label,'書込みできません');}}
 const version=spawnSync(python,['-c','import PIL, numpy, cv2, ultralytics; print("ok")'],{timeout:30000,encoding:'utf8'});add(version.status===0?'PASS':'FAIL','Python dependencies',version.status===0?undefined:'PYTHONと依存パッケージを確認してください');
 // Load local weights without downloading; inference is checked in the physical pilot.
 for(const [name,fallback] of [['YOLO_DETECT_WEIGHTS','yolov8n.pt'],['YOLO_POSE_WEIGHTS','yolov8n-pose.pt'],['YOLO_SEG_WEIGHTS','yolo11s-seg.pt']]){const file=path.resolve(__dirname,process.env[name]||fallback);let valid=false;if(fs.existsSync(file)&&fs.statSync(file).size>0){const load=spawnSync(python,['-c','from ultralytics import YOLO; import sys; YOLO(sys.argv[1]); print("ok")',file],{cwd:__dirname,encoding:'utf8',timeout:30000});valid=load.status===0;}add(valid?'PASS':'FAIL',name,valid?'ローカル重み読込済み':'重みが無いか読み込めません（自動ダウンロードしません）');}
 // Verify actual renderability of each unique validated reference, not just its JSON shape.
 if(guidance&&version.status===0){const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'experiment-check-'));try{const seen=new Set();for(const r of reports.filter(r=>r.available))for(const item of r.items){const key=item.sourceSessionId+':'+item.referenceImageId;if(seen.has(key))continue;seen.add(key);const {reference}=referenceForPlan(root,item,guidance);const input=path.join(tmp,'reference.json'),output=path.join(tmp,'guide.png');fs.writeFileSync(input,JSON.stringify(reference));const result=spawnSync(python,[path.join(__dirname,'guide_processor/render_reference_guide.py'),input,output,guidancePath],{encoding:'utf8',timeout:30000});add(result.status===0?'PASS':'FAIL','ReferenceGuide render '+key);}}finally{fs.rmSync(tmp,{recursive:true,force:true});}}
 add('PASS','runtime defaults',{host:process.env.HOST||'127.0.0.1',port:process.env.PORT||3000,python});
 for(const name of ['PORT','SESSION_TTL_MS','CLEANUP_INTERVAL_MS'])if(process.env[name]&&!(Number(process.env[name])>0))add('FAIL',name,'正の数を指定してください');
 add(process.env.RESEARCH_ADMIN_TOKEN?'PASS':'WARNING','researcher API token',process.env.RESEARCH_ADMIN_TOKEN?'設定済み':'管理APIは無効です。CLIは使用できます');
 add('WARNING','physical pilot','実機2台・HTTPS/WSS・権限・再接続・無介助完走は別途確認が必要です');
 return {status:checks.some(c=>c.status==='FAIL')?'FAIL':checks.some(c=>c.status==='WARNING')?'WARNING':'PASS',checks,plans:reports};
}
if(require.main===module){try{const command=process.argv[2],o=options(process.argv.slice(3)),root=path.resolve(o.root||path.join(__dirname,'uploads')),base=path.resolve(o.out||(command==='backup'?(process.env.RESEARCH_BACKUP_DIR||path.join(__dirname,'research-backups')):(process.env.RESEARCH_EXPORT_DIR||path.join(__dirname,'research-exports')))),stamp=new Date().toISOString().replace(/[:.]/g,'-')+'-'+process.pid;
 if(command==='export'){const out=path.join(base,stamp),reports=exportData(root,out);console.log(JSON.stringify({output:out,sessions:reports.map(r=>({sessionId:r.sessionId,status:r.status}))},null,2));}
 else if(command==='backup'){const out=path.join(base,stamp),manifest=backup(root,out);console.log(JSON.stringify({output:out,files:manifest.files.length},null,2));}
 else if(command==='summary'){console.log(JSON.stringify(researchSessions(root).map(s=>inspectSession(path.join(root,s)).report),null,2));}
 else if(command==='check'){const report=readiness({root,plansDir:path.resolve(process.env.EXPERIMENT_PLAN_DIR||path.join(__dirname,'experiment_plans')),flowPath:path.resolve(process.env.EXPERIMENT_FLOW_CONFIG||path.join(__dirname,'experiment_flow_config.json')),guidancePath:path.resolve(process.env.GUIDANCE_CONFIG||path.join(__dirname,'guide_processor/guidance_config.json')),exportDir:path.resolve(process.env.RESEARCH_EXPORT_DIR||path.join(__dirname,'research-exports')),backupDir:path.resolve(process.env.RESEARCH_BACKUP_DIR||path.join(__dirname,'research-backups')),python:process.env.PYTHON||'python3'});console.log(JSON.stringify(report,null,2));if(report.status==='FAIL')process.exitCode=1;}
 else throw Error('Commands: export | backup | summary | check');
}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={readiness};
