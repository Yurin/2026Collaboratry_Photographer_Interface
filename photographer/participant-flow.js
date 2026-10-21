/* Participant screens deliberately never receive partner answer values. */
(() => {
  const params = new URLSearchParams(location.search);
  const sid = params.get("sessionId");
  const token = params.get("flowToken") || sessionStorage.getItem(`participantToken:${sid}`);
  if(params.get("participantReset")) {
    window.participantFlowUI={refresh:async()=>{},showError:()=>{}};
    document.getElementById("capturePanel").hidden=true;
    document.querySelector(".view-container").innerHTML='<section class="participant-flow"><h2>前の実験から退出しました</h2><p>次のペアの参加QRを読み取ってください。</p></section>';
    return;
  }
  if (!sid || !token) return;
  sessionStorage.setItem(`participantToken:${sid}`,token);
  const panel = document.createElement("section");
  panel.className="participant-flow"; panel.id="participantFlowPanel";
  panel.innerHTML='<p>実験を読み込んでいます…</p><p id="participantError" role="alert"></p>';
  document.querySelector(".view-container").prepend(panel);
  document.querySelector(".view-container").classList.add("participant-layout");
  document.getElementById("capturePanel").hidden=true;
  const ui = window.participantFlowUI = {state:null,inFlight:false,pending:false};
  let reading=false,renderKey="",displayed=new Set();
  const escape = v => String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const draftKey = () => `evaluationDraft:${sid}:${ui.state.trialId}:${ui.state.currentCaptureSequence}:${ui.state.viewPhase}`;
  const base=()=>({trialId:ui.state.trialId,captureSequence:ui.state.currentCaptureSequence});
  async function api(action,body) {
    const response=await fetch(`/api/participant-experiments/${encodeURIComponent(sid)}/${action}`,{method:body?"POST":"GET",headers:{"Content-Type":"application/json","X-Experiment-Token":token},body:body?JSON.stringify(body):undefined,cache:"no-store"});
    const data=await response.json();if(!response.ok)throw new Error(data.error||"通信できませんでした。もう一度お試しください。");return data;
  }
  function error(e){let node=document.getElementById("participantError");if(node)node.textContent=e.message;}
  ui.showError=message=>error(new Error(message));
  ui.clearParticipantState=()=>{
    ui.ended=true;ui.state=null;ui.inFlight=true;renderKey="";displayed.clear();
    for(const storage of [localStorage,sessionStorage]){
      for(let i=storage.length-1;i>=0;i--){const key=storage.key(i);if(key&&(key.startsWith("evaluationDraft:")||key.startsWith("participantToken:")||key.startsWith("photoGuideCaptureSequence:")||key.startsWith("photoGuideEvents:")))storage.removeItem(key);}
    }
    stopLiveShare();currentStream?.getTracks().forEach(t=>t.stop());
    location.replace("/?participantReset=1");
  };
  ui.diagnostic=(operation,outcome="success")=>api("diagnostic",{operation,outcome}).catch(()=>{});
  function accept(state){if(ui.ended)return;if(state.participantReset){ui.clearParticipantState();return;}if(ui.state&&state.revision<ui.state.revision)return;ui.state=state;ui.inFlight=state.experimentPhase!=="capture";render();}
  ui.refresh=async()=>{if(reading||ui.ended)return;reading=true;try{accept(await api("state"));}catch(e){error(e);}finally{reading=false;}};
  ui.beginCapture=async()=>{
    if(ui.inFlight||ui.state?.experimentPhase!=="capture")return null;
    ui.inFlight=true;
    try{return await api("capture",{...base(),requestId:crypto.randomUUID(),captureTimestamp:Date.now()});}
    catch(e){ui.inFlight=false;error(e);await ui.refresh();return null;}
  };
  ui.uploadHeaders=record=>({"X-Experiment-Token":token,"X-Flow-Capture-Sequence":String(record.captureSequence)});
  ui.uploadFinished=()=>ui.refresh();
  function button(text,action){const b=document.createElement("button");b.textContent=text;b.className="flow-button";b.disabled=ui.pending;b.onclick=async()=>{if(ui.pending)return;ui.pending=true;b.disabled=true;try{accept(await action());}catch(e){error(e);await ui.refresh();}finally{ui.pending=false;panel.querySelectorAll("button").forEach(node=>node.disabled=false);}};return b;}
  function acknowledge(text){panel.append(button(text,()=>api("ack",{...base(),phase:ui.state.experimentPhase})));}
  function select(id,text,options){return `<label>${escape(text)}<select name="${id}" required><option value="">選択してください</option>${options.map(([v,t])=>`<option value="${v}">${escape(t)}</option>`).join("")}</select></label>`;}
  const ratings=Array.from({length:7},(_,i)=>[i+1,String(i+1)]);
  function form(questionnaire) {
    const form=document.createElement("form");
    form.innerHTML=questionnaire ? ui.state.questions.map(q=>select(q.id,q.text,ratings)).join("")+`<label>${escape(ui.state.freeTextQuestion)}（任意）<textarea name="comment" maxlength="2000"></textarea></label>` :
      select("similarityRating","お手本写真にどれくらい近いと思いますか？（1＝全く近くない、7＝とても近い）",ratings)+
      select("satisfactionRating","この写真にどれくらい満足していますか？（1＝全く満足していない、7＝とても満足している）",ratings)+
      select("wantsRetake","この写真を撮り直したいですか？",[["yes","撮り直したい"],["no","この写真でよい"]]);
    let saved={};try{saved=JSON.parse(localStorage.getItem(draftKey())||"{}");}catch{}
    for(const field of form.elements) if(saved[field.name]!=null)field.value=saved[field.name];
    form.oninput=()=>localStorage.setItem(draftKey(),JSON.stringify(Object.fromEntries(new FormData(form))));
    const submit=document.createElement("button");submit.textContent="回答を送信";submit.className="flow-button";submit.type="submit";form.append(submit);
    form.onsubmit=async e=>{e.preventDefault();if(ui.pending||!form.reportValidity())return;ui.pending=true;submit.disabled=true;const values=Object.fromEntries(new FormData(form));const key=draftKey();try{
      const body=questionnaire ? {...base(),answers:Object.fromEntries(ui.state.questions.map(q=>[q.id,Number(values[q.id])])),comment:values.comment||""} : {...base(),similarityRating:Number(values.similarityRating),satisfactionRating:Number(values.satisfactionRating),wantsRetake:values.wantsRetake==="yes"};
      accept(await api(questionnaire?"questionnaire":"evaluation",body));localStorage.removeItem(key);
    }catch(e){void ui.diagnostic(questionnaire?"questionnaire_submit":"evaluation_submit","failed");error(e);await ui.refresh();}finally{ui.pending=false;panel.querySelectorAll("button").forEach(node=>node.disabled=false);}};
    panel.append(form);
  }
  function image(url,alt){if(url)panel.insertAdjacentHTML("beforeend",`<img class="flow-photo" src="${escape(url)}" alt="${escape(alt)}">`);}
  function logDisplay(s){
    const key=`${s.trialId}:${s.currentCaptureSequence}`;
    if(displayed.has(key))return;displayed.add(key);
    void api("displayed",{...base(),displayedAt:Date.now()}).catch(()=>displayed.delete(key));
  }
  function render(){
    const s=ui.state;if(!s)return;
    if(s.viewPhase==="guidance")logDisplay(s);
    const key=JSON.stringify(s);if(key===renderKey)return;renderKey=key;
    const capture=s.experimentPhase==="capture";
    document.getElementById("capturePanel").hidden=!capture;
    document.getElementById("galleryPanel").hidden=true;
    document.getElementById("roleGuidancePanel").hidden=true;
    document.querySelector("#capturePanel .controls").hidden=true;
    const banner=s.isPractice?"練習":`撮影 ${s.trialIndex} / ${s.totalTrials}`;
    panel.innerHTML=`<p class="flow-progress">${escape(banner)}</p><p id="participantError" role="alert"></p>`;
    const title=t=>panel.insertAdjacentHTML("beforeend",`<h2>${escape(t)}</h2>`);
    const text=t=>panel.insertAdjacentHTML("beforeend",`<p>${escape(t)}</p>`);
    if(s.viewPhase==="experimentIntroduction"){title("ふたりで撮影を進めましょう");text("お手本を確認して撮影し、それぞれ写真を評価します。評価の回答は相手に見えません。練習のあと、本番を順番に行います。");}
    if(s.viewPhase==="trialIntroduction"){title(s.isPractice?"まずは練習です":"次の撮影を始めます");text(`写真を撮り、ふたりが納得するまで最大${s.maximumCaptureCount}回撮影できます。`);}
    if(s.viewPhase==="referenceViewing"){title("お手本写真を確認してください");image(s.referenceImageUrl,"お手本写真");}
    if(["experimentIntroduction","trialIntroduction","referenceViewing"].includes(s.viewPhase)) {
      if(s.acknowledged)text("相手の準備を待っています");else acknowledge("確認しました・次へ");
    }
    if(capture){title("お手本に近い写真を撮ってください");text(`${s.captureCount+1}回目 / ${s.maximumCaptureCount}回${s.isLastCapture?" ― 最後の撮影です":""}`);
      activeGuideId=s.guideId;trialGuide={guideId:s.guideId,url:s.guideUrl,referenceImageUrl:s.referenceImageUrl};currentTrialId=s.trialId;currentTrialState="running";applySessionGuide(trialGuide);
      if(!currentStream)void startCamera().then(()=>{if(!shareActive&&currentStream)startLiveShare();});else if(!shareActive)startLiveShare();
      document.getElementById("captureBtn").disabled=false;
      panel.insertAdjacentHTML("beforeend",`<details><summary>お手本を確認</summary><img class="flow-photo" src="${escape(s.referenceImageUrl)}" alt="お手本"></details>`);
      panel.append(button("カメラを接続し直す",async()=>{stopLiveShare();currentStream?.getTracks().forEach(t=>t.stop());currentStream=null;await startCamera();if(currentStream)startLiveShare();return ui.state;}));
    }
    if(s.viewPhase==="analyzing"){title("写真を保存・確認しています");text("しばらくお待ちください。");if(s.uploadPending&&!ui.pending)panel.append(button("保存が進まないときは、もう一度撮影",()=>api("retryUpload",base())));}
    if(s.viewPhase==="photoEvaluation"){title("今撮った写真を評価してください");image(s.photoUrl,"今撮った写真");panel.insertAdjacentHTML("beforeend",`<details><summary>お手本を確認</summary><img class="flow-photo" src="${escape(s.referenceImageUrl)}" alt="お手本"></details>`);form(false);}
    if(s.viewPhase==="waitingForPartnerEvaluation"){title("相手の回答を待っています");text("あなたの回答は保存されました。");image(s.photoUrl,"今撮った写真");}
    if(s.viewPhase==="guidance") {
      title("次はここを直してみてください");
      if(s.guidance.length)s.guidance.forEach(g=>text(g.message));else text(s.showReadyToParticipants===true&&s.ready?.framingReady?"構図はOKです。もう一度撮影してください。":"もう一度撮影してください。");
      if(s.acknowledged)text("相手の準備を待っています");else acknowledge("調整できたら次の撮影へ");

    }
    if(s.viewPhase==="trialQuestionnaire"){title("この撮影について教えてください");text("1＝全くそう思わない、7＝とてもそう思う");if(s.questionnaireSubmitted)text("相手の回答を待っています");else form(true);}
    if(s.viewPhase==="trialCompleted"){title("この撮影は終了です");text(s.completionReason==="maximum_capture_count"?"撮影回数の上限に達しました。":"ふたりがこの写真を選びました。");image(s.photoUrl,"最終写真");if(s.acknowledged)text("相手の準備を待っています");else acknowledge("次へ");}
    if(["withdrawn","technical_failure","researcher_terminated"].includes(s.viewPhase)){title("実験を中断しました");text("ここまでの記録は保存されています。");stopLiveShare();currentStream?.getTracks().forEach(t=>t.stop());}
    if(s.viewPhase==="experimentCompleted"){title("実験はすべて終了です");text("ご協力ありがとうございました。最終写真と回答は保存されました。");stopLiveShare();currentStream?.getTracks().forEach(t=>t.stop());}
    if(["experimentCompleted","withdrawn","technical_failure","researcher_terminated"].includes(s.viewPhase))panel.append(button("別のペアの実験を開始",async()=>{if(!window.confirm("この端末の参加情報を消して退出します。保存済みの研究データは残ります。"))return ui.state;return api("reset",{});}));
    else panel.append(button("実験を中断する",async()=>{if(!window.confirm("ふたりの実験を中断しますか？再開はできません。ここまでの記録は保存されます。"))return ui.state;return api("withdraw",{confirm:true});}));
  }
  void ui.diagnostic("experiment_resume");
  window.addEventListener("online",ui.refresh);
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")void ui.refresh();});
  setInterval(ui.refresh,2000);
  setTimeout(ui.refresh,0);
})();
