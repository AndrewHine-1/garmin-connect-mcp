// The Cadence dashboard — a single embedded HTML/CSS/JS page served by
// dashboard.ts. Kept as one string so `tsc` ships it in dist without a copy
// step. The browser JS deliberately avoids backtick template literals so this
// outer TS template literal needs no escaping.

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Cadence — Garmin recovery & habits</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Fraunces:opsz,wght@9..144,500;9..144,600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
  :root {
    --bg:#0E1116; --panel:#161B22; --card:#1C2330; --line:#2D3848;
    --text:#E8EDF2; --text2:#8B97A7; --dim:#5A6573;
    --accent:#1FA98C; --good:#3FB950; --warn:#E0A106; --bad:#F0556B;
    --mono:"JetBrains Mono",ui-monospace,Menlo,monospace;
    --serif:"Fraunces",Georgia,serif;
    --sans:"Inter",system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
  }
  * { box-sizing:border-box; }
  body {
    margin:0; background:var(--bg); color:var(--text);
    font-family:var(--sans); font-size:14px; line-height:1.5;
    -webkit-font-smoothing:antialiased;
  }
  .wrap { max-width:960px; margin:0 auto; padding:0 16px 80px; }
  .num { font-variant-numeric:tabular-nums; }
  .mono { font-family:var(--mono); }
  .eyebrow { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--text2); margin:0 0 8px; }
  h2.section { font-size:16px; font-weight:600; margin:28px 0 12px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; box-shadow:0 1px 2px rgba(0,0,0,.4); }
  button { font-family:var(--sans); cursor:pointer; border-radius:8px; border:1px solid var(--line); background:var(--panel); color:var(--text); padding:8px 12px; font-size:13px; }
  button:hover { border-color:var(--accent); }
  button.primary { background:var(--accent); border-color:var(--accent); color:#04150F; font-weight:600; }
  button.ghost { background:transparent; }
  input, select, textarea { font-family:var(--sans); background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:8px 10px; font-size:13px; }
  input:focus, select:focus, textarea:focus { outline:none; border-color:var(--accent); }
  a { color:var(--accent); }

  /* top bar */
  .topbar { position:sticky; top:0; z-index:20; background:rgba(14,17,22,.92); backdrop-filter:blur(8px); border-bottom:1px solid var(--line); }
  .topbar .row { max-width:960px; margin:0 auto; padding:12px 16px; display:flex; align-items:center; gap:12px; }
  .brand { font-family:var(--serif); font-size:20px; font-weight:600; letter-spacing:.01em; }
  .brand small { font-family:var(--sans); font-size:11px; color:var(--text2); font-weight:400; }
  .spacer { flex:1; }
  .datepick { display:flex; align-items:center; gap:6px; }
  .pill { display:inline-flex; align-items:center; gap:7px; padding:6px 12px; border-radius:999px; border:1px solid var(--line); font-size:12px; font-weight:500; }
  .pill .dot { width:8px; height:8px; border-radius:50%; background:var(--dim); }
  .pill.ok { border-color:rgba(63,185,80,.4); color:var(--good); } .pill.ok .dot { background:var(--good); }
  .pill.no { border-color:rgba(240,85,107,.4); color:var(--bad); } .pill.no .dot { background:var(--bad); }
  .pill.busy .dot { background:var(--warn); animation:pulse 1s infinite; }
  @keyframes pulse { 50% { opacity:.3; } }

  /* hero */
  .hero { display:flex; gap:20px; align-items:center; flex-wrap:wrap; margin-top:18px; }
  .ring { width:128px; height:128px; flex:none; position:relative; }
  .ring svg { transform:rotate(-90deg); }
  .ring .center { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; }
  .ring .val { font-size:34px; font-weight:700; }
  .ring .verdict { font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--text2); }
  .coach { flex:1; min-width:240px; }
  .coach .line { font-family:var(--serif); font-size:22px; line-height:1.35; }
  .coach .sub { color:var(--text2); margin-top:6px; font-size:13px; }

  /* logger */
  .logger { display:flex; flex-direction:column; gap:8px; margin-top:8px; }
  .habrow { display:flex; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid var(--line); }
  .habrow:last-child { border-bottom:none; }
  .habname { flex:1; font-weight:500; }
  .habname .tag { font-size:10px; color:var(--dim); text-transform:uppercase; letter-spacing:.05em; margin-left:6px; }
  .pills { display:flex; gap:6px; }
  .toggle { padding:5px 12px; border-radius:999px; border:1px solid var(--line); background:transparent; color:var(--text2); font-size:12px; min-width:44px; }
  .toggle.on-yes { background:rgba(63,185,80,.16); border-color:var(--good); color:var(--good); }
  .toggle.on-no { background:rgba(240,85,107,.14); border-color:var(--bad); color:var(--bad); }
  .numwrap { display:flex; align-items:center; gap:6px; }
  .numwrap input { width:90px; }
  .savetag { font-size:11px; color:var(--good); opacity:0; transition:opacity .2s; }
  .savetag.show { opacity:1; }

  /* tiles */
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; }
  .tile { cursor:pointer; position:relative; }
  .tile.pinned { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent); }
  .tile .label { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--text2); }
  .tile .v { font-size:30px; font-weight:600; margin-top:4px; }
  .tile .u { font-size:12px; color:var(--text2); margin-left:4px; }
  .tile .nodata { font-size:13px; color:var(--dim); margin-top:8px; }
  .tile .pinhint { position:absolute; top:12px; right:12px; font-size:10px; color:var(--dim); }
  .band-good { color:var(--good); } .band-warn { color:var(--warn); } .band-bad { color:var(--bad); }

  /* analyze table */
  table.an { width:100%; border-collapse:collapse; font-size:13px; }
  table.an th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--text2); font-weight:500; padding:8px 10px; border-bottom:1px solid var(--line); }
  table.an td { padding:10px; border-bottom:1px solid var(--line); vertical-align:middle; }
  table.an tr.low { opacity:.5; }
  .eff-up { color:var(--good); } .eff-down { color:var(--bad); } .eff-none { color:var(--text2); }
  .mag { font-family:var(--mono); }
  .conf { display:inline-flex; gap:3px; align-items:center; }
  .conf .d { width:7px; height:7px; border-radius:50%; background:var(--line); }
  .conf .d.f-good { background:var(--good); } .conf .d.f-warn { background:var(--warn); } .conf .d.f-bad { background:var(--bad); }
  .rbar { display:inline-block; width:70px; height:6px; background:var(--line); border-radius:3px; position:relative; vertical-align:middle; margin-left:6px; }
  .rbar i { position:absolute; top:-2px; width:2px; height:10px; background:var(--text); }
  .coachpick { background:linear-gradient(90deg,rgba(31,169,140,.12),transparent); border:1px solid rgba(31,169,140,.35); border-radius:10px; padding:12px 14px; margin-bottom:12px; }
  .coachpick b { color:var(--accent); }
  .disclaimer { font-size:11px; color:var(--dim); margin-top:10px; }

  /* history grid */
  .grid { overflow-x:auto; }
  .grid table { border-collapse:collapse; }
  .grid td.lbl { font-size:12px; padding-right:10px; white-space:nowrap; color:var(--text2); position:sticky; left:0; background:var(--card); }
  .cell { width:14px; height:14px; border-radius:3px; background:#222B36; border:1px solid #222B36; cursor:pointer; }
  .cell.on { background:var(--accent); border-color:var(--accent); }
  .cell.partial { background:rgba(31,169,140,.4); }
  .cell:hover { outline:1px solid var(--text2); }

  /* console */
  details.console summary { cursor:pointer; font-size:16px; font-weight:600; padding:8px 0; list-style:none; }
  details.console summary::-webkit-details-marker { display:none; }
  details.console summary:before { content:"▸ "; color:var(--accent); }
  details.console[open] summary:before { content:"▾ "; }
  .cgrid { display:grid; grid-template-columns:280px 1fr; gap:16px; }
  @media (max-width:720px) { .cgrid { grid-template-columns:1fr; } }
  .cmdlist { max-height:420px; overflow:auto; border:1px solid var(--line); border-radius:10px; }
  .cmdgroup { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--text2); padding:8px 10px 4px; }
  .cmditem { padding:7px 10px; cursor:pointer; border-radius:6px; font-size:13px; }
  .cmditem:hover { background:var(--panel); }
  .cmditem.sel { background:var(--panel); color:var(--accent); }
  .formrow { display:flex; flex-direction:column; gap:4px; margin-bottom:10px; }
  .formrow label { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--text2); }
  .formrow .req { color:var(--bad); }
  .preview { font-family:var(--mono); font-size:12px; color:var(--text2); background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:8px 10px; word-break:break-all; margin:8px 0; }
  pre.out { font-family:var(--mono); font-size:12px; background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:12px; max-height:360px; overflow:auto; white-space:pre-wrap; word-break:break-word; }
  .tabs { display:flex; gap:6px; margin:8px 0; }
  .tabs button.active { border-color:var(--accent); color:var(--accent); }
  .slog { font-size:12px; margin-top:10px; }
  .slog .it { display:flex; gap:8px; align-items:center; padding:5px 0; border-bottom:1px solid var(--line); }
  .slog .it .nm { font-family:var(--mono); }
  .slog .ok { color:var(--good); } .slog .er { color:var(--bad); }

  /* modal + toast */
  .modal-bg { position:fixed; inset:0; background:rgba(0,0,0,.6); display:none; align-items:center; justify-content:center; z-index:50; }
  .modal-bg.show { display:flex; }
  .modal { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:24px; max-width:420px; width:90%; text-align:center; }
  .modal h3 { font-family:var(--serif); margin:0 0 8px; }
  .modal .status { color:var(--text2); font-size:13px; margin:12px 0; min-height:20px; }
  .spinner { width:34px; height:34px; border:3px solid var(--line); border-top-color:var(--accent); border-radius:50%; animation:spin 1s linear infinite; margin:6px auto; }
  @keyframes spin { to { transform:rotate(360deg); } }
  .toast { position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:var(--card); border:1px solid var(--accent); color:var(--text); padding:10px 16px; border-radius:10px; font-size:13px; opacity:0; transition:opacity .25s; z-index:60; pointer-events:none; }
  .toast.show { opacity:1; }
  .empty { text-align:center; padding:48px 16px; color:var(--text2); }
  .muted { color:var(--dim); }
  .footer { margin-top:40px; padding-top:16px; border-top:1px solid var(--line); font-size:12px; color:var(--dim); display:flex; gap:16px; flex-wrap:wrap; }
</style>
</head>
<body>
  <div class="topbar"><div class="row">
    <div class="brand">Cadence <small>· Garmin recovery &amp; habits</small></div>
    <div class="spacer"></div>
    <div class="datepick">
      <button class="ghost" id="dprev" title="Previous day">◀</button>
      <input type="date" id="dinput" />
      <button class="ghost" id="dtoday">Today</button>
      <button class="ghost" id="dnext" title="Next day">▶</button>
    </div>
    <div class="pill" id="authpill"><span class="dot"></span><span id="authtext">checking…</span></div>
  </div></div>

  <div class="wrap">
    <div id="firstrun" style="display:none" class="empty card" >
      <h2 class="section" style="margin-top:0">Welcome to Cadence</h2>
      <p>Connect your Garmin account to load recovery data and unlock habit insights.</p>
      <button class="primary" id="firstlogin">Log in to Garmin</button>
      <p class="muted" style="margin-top:14px">You can still define and log habits without logging in — analysis just needs Garmin data.</p>
    </div>

    <!-- HERO -->
    <section id="hero" class="hero">
      <div class="ring" id="ring"></div>
      <div class="coach">
        <div class="line" id="coachline">Loading your recovery…</div>
        <div class="sub" id="coachsub"></div>
      </div>
    </section>

    <!-- LOGGER -->
    <h2 class="section">Today&#39;s habits <span class="muted" id="loggerdate"></span></h2>
    <div class="card">
      <div class="logger" id="logger"><div class="muted">Loading…</div></div>
      <div style="display:flex; gap:8px; margin-top:14px; flex-wrap:wrap; align-items:flex-end">
        <div class="formrow" style="margin:0"><label>New habit name</label><input id="nh-name" placeholder="e.g. Alcohol" /></div>
        <div class="formrow" style="margin:0"><label>Type</label>
          <select id="nh-type"><option value="boolean">yes / no</option><option value="numeric">number</option></select></div>
        <button id="nh-add">Add habit</button>
      </div>
    </div>

    <!-- RECOVERY TILES -->
    <h2 class="section">Recovery glance <span class="muted">· click a tile to correlate habits against it</span></h2>
    <div class="tiles" id="tiles"><div class="muted">Loading…</div></div>

    <!-- ANALYZE -->
    <h2 class="section">What&#39;s moving your recovery</h2>
    <div class="card" id="analyzecard"><div class="muted">Loading insights…</div></div>

    <!-- HISTORY -->
    <h2 class="section">History &amp; streaks <span class="muted">· last 30 days</span></h2>
    <div class="card grid" id="history"><div class="muted">Loading…</div></div>

    <!-- CONSOLE -->
    <h2 class="section" style="margin-bottom:0"></h2>
    <details class="console card">
      <summary>Command Console — run any of the commands</summary>
      <p class="muted" style="font-size:12px">Every Garmin read command and habit-journal action. The friendly sections above call these same commands under the hood. Workout-authoring file downloads live in the MCP tools.</p>
      <div class="cgrid">
        <div>
          <input id="cmdsearch" placeholder="Search commands…" style="width:100%; margin-bottom:8px" />
          <div class="cmdlist" id="cmdlist"></div>
        </div>
        <div>
          <div id="cmdform"><div class="muted">Select a command on the left.</div></div>
          <div class="preview" id="cmdpreview" style="display:none"></div>
          <div style="display:flex; gap:8px; align-items:center">
            <button class="primary" id="cmdrun" style="display:none">Run</button>
            <span class="muted" id="cmdtiming"></span>
          </div>
          <div id="cmdresult"></div>
          <div class="slog" id="slog"></div>
        </div>
      </div>
    </details>

    <div class="footer">
      <span id="ft-server">Server: localhost</span>
      <span id="ft-session"></span>
      <span class="muted">Correlation, not causation. Keep logging for sharper signals.</span>
    </div>
  </div>

  <div class="modal-bg" id="modalbg"><div class="modal">
    <h3>Connecting to Garmin</h3>
    <div class="spinner"></div>
    <div class="status" id="modalstatus">Opening a browser window… finish logging in there and we&#39;ll capture your session automatically.</div>
    <button class="ghost" id="modalclose">Close</button>
  </div></div>
  <div class="toast" id="toast"></div>

<script>
(function(){
  "use strict";
  var S = { date:null, pinned:"training_readiness", authed:false, sessionExpired:false, commands:[], selCmd:null, sessionLog:[], pending:null, journal:null, resultMode:"pretty", lastResult:null };

  function qs(s){ return document.querySelector(s); }
  function esc(v){ return String(v==null?"":v).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]; }); }
  function todayISO(){ var d=new Date(); function p(n){ return (n<10?"0":"")+n; } return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate()); }
  function shiftDate(iso, days){ var d=new Date(iso+"T00:00:00Z"); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10); }

  function getJSON(path){ return fetch(path).then(function(r){ return r.json(); }); }
  function postJSON(path, body){ return fetch(path,{ method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body||{}) }).then(function(r){ return r.json(); }); }

  function toast(msg){ var t=qs("#toast"); t.textContent=msg; t.classList.add("show"); setTimeout(function(){ t.classList.remove("show"); }, 1800); }

  // run a command via the API; handles needsLogin by opening the modal and retrying.
  function run(command, args, onResult){
    var t0=performance.now();
    return postJSON("/api/run",{ command:command, args:args||{} }).then(function(res){
      var ms=Math.round(performance.now()-t0);
      if(res && res.needsLogin){
        S.pending={ command:command, args:args, onResult:onResult };
        openLogin();
        return res;
      }
      logRun(command, args, res, ms);
      if(onResult) onResult(res);
      return res;
    });
  }
  function logRun(command, args, res, ms){
    S.sessionLog.unshift({ command:command, args:args, ok:!!(res&&res.ok), ms:ms });
    if(S.sessionLog.length>25) S.sessionLog.pop();
    renderSlog();
  }

  // ---------- auth ----------
  function applyAuth(){
    var pill=qs("#authpill"), txt=qs("#authtext");
    if(S.authed){ pill.className="pill ok"; txt.textContent="Connected"; }
    else if(S.sessionExpired){ pill.className="pill no"; txt.textContent="Session expired — log in"; }
    else { pill.className="pill no"; txt.textContent="Log in"; }
    qs("#firstrun").style.display = S.authed ? "none" : "block";
    qs("#hero").style.display = S.authed ? "flex" : "none";
  }

  function refreshAuth(){
    return getJSON("/api/status").then(function(s){
      S.serverToday=s.today;
      qs("#ft-session").textContent = "Session file: "+s.sessionFile;
      // The status endpoint only knows the session FILE exists; if a data call
      // already proved the cookies are expired, keep treating us as logged out.
      S.authed = !!s.authenticated && !S.sessionExpired;
      applyAuth();
      return S.authed;
    });
  }

  // Cookies expired mid-use: flip to logged-out and prompt a re-login instead
  // of showing blank "Connected" data.
  function markExpired(){
    S.sessionExpired = true;
    S.authed = false;
    applyAuth();
    qs("#tiles").innerHTML='<div class="muted">Your Garmin session expired. Click <b>“Session expired — log in”</b> at the top right to reconnect.</div>';
    qs("#analyzecard").innerHTML='<div class="muted">Log in again to refresh your recovery insights.</div>';
    renderRing(null);
    qs("#coachline").textContent="Session expired.";
    qs("#coachsub").textContent="Reconnect to Garmin to see today’s recovery.";
  }

  function openLogin(){
    qs("#modalbg").classList.add("show");
    qs("#modalstatus").textContent = "Opening a browser window… finish logging in there and we'll capture your session automatically.";
    var pill=qs("#authpill"); pill.className="pill busy";
    postJSON("/api/login",{}).then(function(res){
      pill.className="pill "+(res&&res.ok?"ok":"no");
      qs("#modalstatus").textContent = (res&&(res.message|| (res.ok?"Connected!":"Login did not complete."))) || "Login finished.";
      if(res && res.ok){
        S.sessionExpired = false;
        setTimeout(function(){ qs("#modalbg").classList.remove("show"); }, 900);
        refreshAuth().then(function(){ loadAll(); var p=S.pending; S.pending=null; if(p){ run(p.command,p.args,p.onResult); } });
      }
    }).catch(function(e){
      pill.className="pill no";
      qs("#modalstatus").textContent = "Error launching login: "+e;
    });
  }

  // ---------- hero ring ----------
  function band(v){ if(v==null) return ""; if(v>=67) return "good"; if(v>=34) return "warn"; return "bad"; }
  function bandColor(b){ return b==="good"?"#3FB950":b==="warn"?"#E0A106":b==="bad"?"#F0556B":"#2D3848"; }
  function verdict(v){ if(v==null) return ""; if(v>=67) return "PRIMED"; if(v>=34) return "STEADY"; return "STRAINED"; }

  function renderRing(value){
    var r=54, c=2*Math.PI*r, pct=value==null?0:Math.max(0,Math.min(100,value))/100;
    var off=c*(1-pct), col=bandColor(band(value));
    var svg = '<svg width="128" height="128" viewBox="0 0 128 128">'
      + '<circle cx="64" cy="64" r="'+r+'" fill="none" stroke="#222B36" stroke-width="10"/>'
      + '<circle cx="64" cy="64" r="'+r+'" fill="none" stroke="'+col+'" stroke-width="10" stroke-linecap="round" stroke-dasharray="'+c.toFixed(1)+'" stroke-dashoffset="'+off.toFixed(1)+'"/>'
      + '</svg>'
      + '<div class="center"><div class="val num">'+(value==null?"—":Math.round(value))+'</div><div class="verdict">'+(value==null?"no data":verdict(value))+'</div></div>';
    qs("#ring").innerHTML = svg;
  }

  function coachSentence(readiness, loggedCount){
    if(readiness==null) return ["No readiness data for this day.", "Wear your watch overnight, or pick another date."];
    var v=verdict(readiness), line, sub;
    if(v==="PRIMED") line="You're primed — your body is ready for load today.";
    else if(v==="STEADY") line="You're steady — fine for moderate effort, listen to your body.";
    else line="You're strained — favor recovery over intensity today.";
    sub = loggedCount>0 ? (loggedCount+" habit"+(loggedCount===1?"":"s")+" logged for this day.") : "No habits logged for this day yet — log below to build your insights.";
    return [line, sub];
  }

  // ---------- snapshot / tiles ----------
  function tileBandClass(metricKey, value){
    if(value==null) return "";
    if(metricKey==="training_readiness"||metricKey==="sleep_score"){ var b=band(value); return b?("band-"+b):""; }
    if(metricKey==="stress_avg"){ if(value<26) return "band-good"; if(value<51) return "band-warn"; return "band-bad"; }
    return ""; // hrv, resting_hr: personal baselines, keep neutral
  }

  function loadSnapshot(){
    renderRing(null);
    return getJSON("/api/snapshot?date="+encodeURIComponent(S.date)).then(function(snap){
      if(snap && snap.busy){ return; }
      if(snap && snap.authenticated===false){ markExpired(); return; }
      var byKey={}; (snap.metrics||[]).forEach(function(m){ byKey[m.key]=m; });
      var rdy = byKey.training_readiness ? byKey.training_readiness.value : null;
      renderRing(rdy);
      var loggedCount = S.journal && S.journal.byDate && S.journal.byDate[S.date] ? Object.keys(S.journal.byDate[S.date]).length : 0;
      var cs=coachSentence(rdy, loggedCount);
      qs("#coachline").textContent=cs[0]; qs("#coachsub").textContent=cs[1];

      var order=["sleep_score","hrv","resting_hr","stress_avg"];
      var html=order.map(function(k){
        var m=byKey[k]; if(!m) return "";
        var pinned = S.pinned===k ? " pinned" : "";
        var inner;
        if(m.value==null){ inner='<div class="nodata">No data — not synced for this day.</div>'; }
        else { inner='<div class="v num '+tileBandClass(k,m.value)+'">'+esc(m.value)+'<span class="u">'+esc(m.unit.split(" ")[0])+'</span></div>'; }
        return '<div class="card tile'+pinned+'" data-metric="'+k+'"><div class="label">'+esc(m.label)+'</div>'+inner+'<div class="pinhint">'+(S.pinned===k?"pinned":"pin")+'</div></div>';
      }).join("");
      // readiness tile too (so all 5 are pinnable)
      var rm=byKey.training_readiness;
      if(rm){
        var pr=S.pinned==="training_readiness"?" pinned":"";
        var rin = rm.value==null?'<div class="nodata">No data.</div>':'<div class="v num '+tileBandClass("training_readiness",rm.value)+'">'+esc(rm.value)+'</div>';
        html = '<div class="card tile'+pr+'" data-metric="training_readiness"><div class="label">'+esc(rm.label)+'</div>'+rin+'<div class="pinhint">'+(S.pinned==="training_readiness"?"pinned":"pin")+'</div></div>' + html;
      }
      qs("#tiles").innerHTML = html || '<div class="muted">No metrics.</div>';
      Array.prototype.forEach.call(document.querySelectorAll(".tile"), function(t){
        t.addEventListener("click", function(){ S.pinned=t.getAttribute("data-metric"); loadSnapshot(); loadAnalysis(); });
      });
    });
  }

  // ---------- habits: logger + history ----------
  function loadJournalThen(cb){
    return run("get-journal",{ startDate: shiftDate(todayISO(),-29), endDate: todayISO() }, function(res){
      if(res && res.ok){
        S.journal=res.result;
        // get-journal returns entries as an array of {date, values}; index it by date.
        S.journal.byDate={};
        (res.result.entries||[]).forEach(function(e){ S.journal.byDate[e.date]=e.values; });
      }
      if(cb) cb();
    });
  }

  function renderLogger(){
    qs("#loggerdate").textContent = S.date===todayISO() ? "(today)" : ("("+S.date+")");
    var j=S.journal; if(!j){ qs("#logger").innerHTML='<div class="muted">Loading…</div>'; return; }
    var todayVals = (j.byDate && j.byDate[S.date]) || {};
    if(!j.habits || !j.habits.length){ qs("#logger").innerHTML='<div class="muted">No habits yet — add one below to start tracking.</div>'; return; }
    var rows = j.habits.map(function(h){
      var cur = todayVals[h.id];
      var control;
      if(h.type==="boolean"){
        var yes = cur===true ? " on-yes":"", no = cur===false?" on-no":"";
        control = '<div class="pills">'
          + '<button class="toggle'+yes+'" data-h="'+esc(h.id)+'" data-v="yes">Yes</button>'
          + '<button class="toggle'+no+'" data-h="'+esc(h.id)+'" data-v="no">No</button>'
          + '</div>';
      } else {
        control = '<div class="numwrap"><input type="number" step="any" data-hn="'+esc(h.id)+'" value="'+(cur==null?"":esc(cur))+'" placeholder="value" /><button class="ghost" data-hns="'+esc(h.id)+'">Save</button></div>';
      }
      return '<div class="habrow"><div class="habname">'+esc(h.name)+'<span class="tag">'+esc(h.type)+'</span></div>'+control+'<span class="savetag" id="save-'+esc(h.id)+'">Saved</span></div>';
    }).join("");
    qs("#logger").innerHTML = rows;
    Array.prototype.forEach.call(document.querySelectorAll(".toggle"), function(b){
      b.addEventListener("click", function(){
        var id=b.getAttribute("data-h"), v=b.getAttribute("data-v");
        logHabitValue(id, v);
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-hns]"), function(b){
      b.addEventListener("click", function(){
        var id=b.getAttribute("data-hns");
        var inp=document.querySelector('[data-hn="'+id+'"]');
        if(inp.value==="") return;
        logHabitValue(id, inp.value);
      });
    });
  }

  function flashSaved(id){ var t=qs("#save-"+CSS.escape(id)); if(t){ t.classList.add("show"); setTimeout(function(){ t.classList.remove("show"); },1200); } }

  function logHabitValue(habitId, value){
    run("log-habit",{ habit:habitId, value:value, date:S.date }, function(res){
      if(res && res.ok){ flashSaved(habitId); toast("Saved"); loadJournalThen(function(){ renderLogger(); renderHistory(); loadSnapshot(); }); }
      else if(res && !res.needsLogin){ toast(res.error||"Could not save"); }
    });
  }

  function renderHistory(){
    var j=S.journal; if(!j || !j.habits || !j.habits.length){ qs("#history").innerHTML='<div class="muted">No habits to chart yet.</div>'; return; }
    var days=[]; for(var i=29;i>=0;i--){ days.push(shiftDate(todayISO(),-i)); }
    var head='<tr><td class="lbl"></td>'+days.map(function(d){ return '<td title="'+d+'" style="font-size:9px;color:var(--dim);text-align:center">'+(d.slice(8)==="01"||d===days[0]?d.slice(5):"")+'</td>'; }).join("")+'</tr>';
    var body=j.habits.map(function(h){
      var cells=days.map(function(d){
        var v = j.byDate[d] && (h.id in j.byDate[d]) ? j.byDate[d][h.id] : undefined;
        var cls="cell";
        if(v===true) cls+=" on";
        else if(v===false) cls+=" ";
        else if(typeof v==="number") cls+= v>0?" on":" partial";
        var title=h.name+" · "+d+(v===undefined?" · (no entry)":" · "+v);
        return '<td><div class="'+cls+'" title="'+esc(title)+'" data-eh="'+esc(h.id)+'" data-ed="'+d+'"></div></td>';
      }).join("");
      return '<tr><td class="lbl">'+esc(h.name)+'</td>'+cells+'</tr>';
    }).join("");
    qs("#history").innerHTML='<table>'+head+body+'</table>';
    Array.prototype.forEach.call(document.querySelectorAll(".cell[data-eh]"), function(c){
      c.addEventListener("click", function(){
        var id=c.getAttribute("data-eh"), d=c.getAttribute("data-ed");
        S.date=d; qs("#dinput").value=d;
        renderLogger(); loadSnapshot();
        window.scrollTo({ top:0, behavior:"smooth" });
        toast("Editing "+d);
      });
    });
  }

  // ---------- analyze-habits ----------
  function effChip(dir){ if(dir>0) return '<span class="eff-up">&#8593; better</span>'; if(dir<0) return '<span class="eff-down">&#8595; worse</span>'; return '<span class="eff-none">~ none</span>'; }
  function confDots(conf){
    var n = conf==="high"?3:conf==="medium"?2:conf==="low"?1:0;
    var fillCls = conf==="high"?"f-good":conf==="medium"?"f-warn":conf==="low"?"f-bad":"";
    var s='<span class="conf">'; for(var i=0;i<3;i++){ s+='<span class="d'+(i<n?(" "+fillCls):"")+'"></span>'; } s+=' '+esc(conf)+'</span>'; return s;
  }
  function magCell(a){
    if(a.group){
      var g=a.group, pct = (g.meanWithout!==0 && isFinite(g.percentChange)) ? ((g.percentChange>=0?"+":"")+g.percentChange.toFixed(1)+"%") : ((g.delta>=0?"+":"")+g.delta.toFixed(1));
      return '<span class="mag">'+esc(pct)+'</span>';
    }
    if(a.correlation){
      var r=a.correlation.r, left=((r+1)/2*100).toFixed(0);
      return '<span class="mag">r='+r.toFixed(2)+'</span><span class="rbar"><i style="left:'+left+'%"></i></span>';
    }
    return '<span class="muted">—</span>';
  }
  function neededDays(a){
    if(a.group){ var need=Math.max(0, 4-Math.min(a.group.nWith,a.group.nWithout)); return need>0?("needs ~"+need+" more split days"):""; }
    if(a.correlation){ var n2=Math.max(0,8-a.correlation.n); return n2>0?("needs ~"+n2+" more days"):""; }
    return "log more days";
  }

  function loadAnalysis(){
    var metricName = S.pinned;
    qs("#analyzecard").innerHTML='<div class="muted">Analyzing against '+esc(metricName)+'…</div>';
    run("analyze-habits",{ metric:metricName }, function(res){
      if(!res || !res.ok){
        if(res && res.needsLogin){ qs("#analyzecard").innerHTML='<div class="muted">Log in to Garmin to see habit insights.</div>'; return; }
        qs("#analyzecard").innerHTML='<div class="muted">'+esc((res&&res.error)||"Could not analyze. Log some habit days first.")+'</div>';
        return;
      }
      var d=res.result, rows=(d.results||[]).slice();
      // rank: confidence then magnitude
      var crank={high:3,medium:2,low:1,inconclusive:0};
      rows.sort(function(a,b){
        var ca=(a.group&&a.group.confidence)||(a.correlation&&a.correlation.confidence)||"inconclusive";
        var cb=(b.group&&b.group.confidence)||(b.correlation&&b.correlation.confidence)||"inconclusive";
        return (crank[cb]-crank[ca]);
      });
      var pick=rows.find(function(r){ var c=(r.group&&r.group.confidence)||(r.correlation&&r.correlation.confidence); return c==="high"||c==="medium"; });
      var pickHtml="";
      if(pick){
        pickHtml='<div class="coachpick">Coach&#39;s pick: <b>'+esc(pick.habitName)+'</b> shows the clearest link to your '+esc(d.metricLabel)+' — '+effChip(pick.recoveryDirection)+' recovery.</div>';
      }
      var head='<tr><th>Habit</th><th>Days</th><th>Effect on recovery</th><th>Magnitude</th><th>Confidence</th></tr>';
      var body=rows.map(function(a){
        var conf=(a.group&&a.group.confidence)||(a.correlation&&a.correlation.confidence)||"inconclusive";
        var low = (conf==="low"||conf==="inconclusive") ? " low":"";
        var note = a.note ? '<span class="muted"> · '+esc(neededDays(a))+'</span>' : (low?'<span class="muted"> · '+esc(neededDays(a))+'</span>':"");
        if(a.note){
          return '<tr class="low"><td>'+esc(a.habitName)+'</td><td class="num">'+a.daysAnalyzed+'</td><td colspan="3" class="muted">not enough data · '+esc(neededDays(a))+'</td></tr>';
        }
        return '<tr class="'+low+'"><td>'+esc(a.habitName)+note+'</td><td class="num">'+a.daysAnalyzed+'</td><td>'+effChip(a.recoveryDirection)+'</td><td>'+magCell(a)+'</td><td>'+confDots(conf)+'</td></tr>';
      }).join("");
      var meta='<div class="muted" style="font-size:12px;margin-bottom:10px">Effect on: <b style="color:var(--accent)">'+esc(d.metricLabel)+'</b> · '+d.loggedDays+' logged days · '+d.metricCoverage+' with metric data ('+esc(d.startDate)+' → '+esc(d.endDate)+')</div>';
      qs("#analyzecard").innerHTML = pickHtml + meta + '<table class="an">'+head+body+'</table>'
        + '<div class="disclaimer">Log a habit on the day you did it — overnight metrics (readiness, sleep, HRV, resting HR) are matched to the <b>next morning</b>; stress is same-day. Boolean: % change on habit days vs. not (Welch t-test); numeric: Pearson r. Direction accounts for metrics where lower is better. Correlation is not causation.</div>';
    });
  }

  // ---------- add habit ----------
  function addHabit(){
    var name=qs("#nh-name").value.trim(); if(!name){ toast("Enter a name"); return; }
    var type=qs("#nh-type").value;
    run("add-habit",{ name:name, type:type }, function(res){
      if(res && res.ok){ qs("#nh-name").value=""; toast("Added "+name); loadJournalThen(function(){ renderLogger(); renderHistory(); }); }
      else { toast((res&&res.error)||"Could not add"); }
    });
  }

  // ---------- command console ----------
  function buildConsole(){
    return getJSON("/api/commands").then(function(d){
      S.commands=d.commands||[];
      renderCmdList("");
    });
  }
  function renderCmdList(filter){
    var f=(filter||"").toLowerCase();
    var groups={};
    S.commands.forEach(function(c){ if(f && c.name.toLowerCase().indexOf(f)<0 && c.description.toLowerCase().indexOf(f)<0) return; (groups[c.group]=groups[c.group]||[]).push(c); });
    var html=Object.keys(groups).map(function(g){
      return '<div class="cmdgroup">'+esc(g)+'</div>'+groups[g].map(function(c){
        return '<div class="cmditem'+(S.selCmd===c.name?" sel":"")+'" data-cmd="'+esc(c.name)+'">'+esc(c.name)+'</div>';
      }).join("");
    }).join("");
    qs("#cmdlist").innerHTML=html||'<div class="muted" style="padding:10px">No matches.</div>';
    Array.prototype.forEach.call(document.querySelectorAll(".cmditem"), function(it){
      it.addEventListener("click", function(){ selectCmd(it.getAttribute("data-cmd")); });
    });
  }
  function selectCmd(name){
    S.selCmd=name; renderCmdList(qs("#cmdsearch").value);
    var c=S.commands.find(function(x){ return x.name===name; }); if(!c) return;
    var form=c.params.map(function(p){
      var id="p-"+p.name, req=p.required?'<span class="req">*</span>':"";
      var ctrl;
      if(p.type==="enum"){ ctrl='<select id="'+id+'">'+(p.required?"":'<option value=""></option>')+p.enumValues.map(function(v){ return '<option'+(String(p.default)===v?" selected":"")+'>'+esc(v)+'</option>'; }).join("")+'</select>'; }
      else if(p.type==="boolean"){ ctrl='<select id="'+id+'"><option value="">(default)</option><option value="true"'+(p.default===true?" selected":"")+'>true</option><option value="false"'+(p.default===false?" selected":"")+'>false</option></select>'; }
      else if(p.type==="date"){ var dv=(p.name==="date")?S.date:""; ctrl='<input type="date" id="'+id+'" value="'+dv+'" />'; }
      else if(p.type==="number"){ ctrl='<input type="number" step="any" id="'+id+'" placeholder="'+(p.default!=null?esc(p.default):"")+'" />'; }
      else { ctrl='<input type="text" id="'+id+'" placeholder="'+(p.default!=null?esc(p.default):"")+'" />'; }
      return '<div class="formrow"><label>'+esc(p.name)+req+(p.description?' <span class="muted" style="text-transform:none;letter-spacing:0">· '+esc(p.description)+'</span>':"")+'</label>'+ctrl+'</div>';
    }).join("");
    qs("#cmdform").innerHTML='<div style="font-weight:600;margin-bottom:8px">'+esc(c.name)+'</div><div class="muted" style="font-size:12px;margin-bottom:10px">'+esc(c.description)+(c.needsAuth?"":" · works offline")+'</div>'+(form||'<div class="muted">No parameters.</div>');
    qs("#cmdrun").style.display="inline-block";
    qs("#cmdresult").innerHTML=""; qs("#cmdtiming").textContent="";
    updatePreview();
    Array.prototype.forEach.call(qs("#cmdform").querySelectorAll("input,select"), function(el){ el.addEventListener("input", updatePreview); });
  }
  function collectArgs(){
    var c=S.commands.find(function(x){ return x.name===S.selCmd; }); if(!c) return {};
    var args={};
    c.params.forEach(function(p){ var el=document.getElementById("p-"+p.name); if(!el) return; var v=el.value; if(v!=="") args[p.name]=v; });
    return args;
  }
  function updatePreview(){
    var args=collectArgs(); var pv=qs("#cmdpreview"); pv.style.display="block";
    pv.textContent = S.selCmd+"("+JSON.stringify(args)+")";
  }
  function runConsole(){
    if(!S.selCmd) return;
    var args=collectArgs();
    qs("#cmdtiming").textContent="running…";
    var t0=performance.now();
    run(S.selCmd, args, function(res){
      var ms=Math.round(performance.now()-t0);
      qs("#cmdtiming").textContent=ms+" ms";
      S.lastResult = res && res.ok ? res.result : (res||{});
      renderResult();
      // habit-mutating commands should refresh the friendly UI
      if(["add-habit","log-habit","unlog-habit","delete-habit"].indexOf(S.selCmd)>=0){ loadJournalThen(function(){ renderLogger(); renderHistory(); }); }
    });
  }
  function renderResult(){
    var data=S.lastResult;
    var pretty = S.resultMode==="pretty";
    var txt = pretty ? JSON.stringify(data,null,2) : JSON.stringify(data);
    qs("#cmdresult").innerHTML =
      '<div class="tabs"><button id="t-pretty" class="'+(pretty?"active":"")+'">Pretty</button><button id="t-raw" class="'+(pretty?"":"active")+'">Raw</button><button id="t-copy">Copy</button><button id="t-dl">Download .json</button></div>'
      + '<pre class="out">'+esc(txt)+'</pre>';
    qs("#t-pretty").onclick=function(){ S.resultMode="pretty"; renderResult(); };
    qs("#t-raw").onclick=function(){ S.resultMode="raw"; renderResult(); };
    qs("#t-copy").onclick=function(){ navigator.clipboard.writeText(JSON.stringify(data,null,2)).then(function(){ toast("Copied"); }); };
    qs("#t-dl").onclick=function(){ var blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"}); var a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=(S.selCmd||"result")+".json"; a.click(); };
  }
  function renderSlog(){
    if(!S.sessionLog.length){ qs("#slog").innerHTML=""; return; }
    qs("#slog").innerHTML='<div class="cmdgroup">Session log</div>'+S.sessionLog.map(function(e,i){
      return '<div class="it"><span class="'+(e.ok?"ok":"er")+'">'+(e.ok?"✓":"✗")+'</span><span class="nm">'+esc(e.command)+'</span><span class="muted">'+e.ms+'ms</span><button class="ghost" data-rerun="'+i+'" style="margin-left:auto;padding:3px 8px;font-size:11px">re-run</button></div>';
    }).join("");
    Array.prototype.forEach.call(document.querySelectorAll("[data-rerun]"), function(b){
      b.addEventListener("click", function(){ var e=S.sessionLog[+b.getAttribute("data-rerun")]; if(e){ selectCmd(e.command); setTimeout(function(){ run(e.command, e.args, function(res){ S.lastResult=res&&res.ok?res.result:res; renderResult(); }); },50); } });
    });
  }

  // ---------- orchestration ----------
  function loadAll(){
    loadJournalThen(function(){ renderLogger(); renderHistory(); });
    if(S.authed){
      // Load the snapshot first; if it detects an expired session it flips us to
      // logged-out, so only run the analysis (which would otherwise pop the
      // login modal) when we're still authenticated.
      loadSnapshot().then(function(){ if(S.authed) loadAnalysis(); });
    } else {
      qs("#tiles").innerHTML='<div class="muted">Log in to Garmin to load your recovery metrics.</div>';
      qs("#analyzecard").innerHTML='<div class="muted">Log in to Garmin, then log a few habit days, to see what moves your recovery.</div>';
    }
  }

  function setDate(d){ S.date=d; qs("#dinput").value=d; qs("#loggerdate").textContent = d===todayISO()?"(today)":("("+d+")"); renderLogger(); if(S.authed){ loadSnapshot(); } }

  function init(){
    S.date=todayISO();
    qs("#dinput").value=S.date;
    qs("#dprev").onclick=function(){ setDate(shiftDate(S.date,-1)); };
    qs("#dnext").onclick=function(){ setDate(shiftDate(S.date,1)); };
    qs("#dtoday").onclick=function(){ setDate(todayISO()); };
    qs("#dinput").onchange=function(){ if(qs("#dinput").value) setDate(qs("#dinput").value); };
    qs("#authpill").onclick=openLogin;
    qs("#firstlogin").onclick=openLogin;
    qs("#modalclose").onclick=function(){ qs("#modalbg").classList.remove("show"); };
    qs("#nh-add").onclick=addHabit;
    qs("#cmdrun").onclick=runConsole;
    qs("#cmdsearch").oninput=function(){ renderCmdList(qs("#cmdsearch").value); };
    qs("#ft-server").textContent="Server: "+location.host;

    buildConsole();
    refreshAuth().then(loadAll);
    setInterval(refreshAuth, 60000);
  }
  document.addEventListener("DOMContentLoaded", init);
})();
</script>
</body>
</html>`;
