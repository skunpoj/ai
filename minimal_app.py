import os
from dotenv import load_dotenv
from fasthtml.common import *
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket

# Minimal FastHTML app with inline UI and a simple WS endpoint.

load_dotenv()

import sys
from pathlib import Path
_ROOT = Path(__file__).resolve().parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

# Ensure Google service account JSON from env is materialized to a temp file
try:
    from utils.credentials import ensure_google_credentials_from_env
    ensure_google_credentials_from_env()
except Exception:
    pass

# No compatibility shims needed; keep minimal surface

try:
    from google import genai as genai_sdk
    from google.genai import types as genai_types
except Exception:
    genai_sdk = None
    genai_types = None

def _INLINE_JS() -> str:
    # Minimal inline JS; native API for recording and WS
    return """
console.log('[minimal] inline JS loaded');
let ws=null, media=null, rec=null, segMs=10000, currentId=Date.now(), segIdx=0;
const tbody=()=>document.getElementById('tbody');
const logEl=()=>document.getElementById('log');
function log(msg){ try{ console.log('[minimal]', msg); if(logEl()){ const p=document.createElement('div'); p.textContent=String(msg); logEl().appendChild(p); } }catch(_){} }
function wsOpen(){
  if(ws&&ws.readyState===WebSocket.OPEN) return Promise.resolve();
  return new Promise((res)=>{
    const scheme=(location.protocol==='https:'?'wss':'ws');
    ws=new WebSocket(scheme+'://'+location.host+'/ws');
    ws.addEventListener('open',()=>{ try{ ws.send(JSON.stringify({type:'hello'})); }catch(_){} log('ws: open'); res(); });
    ws.addEventListener('error',()=>{ log('ws: error (continuing)'); try{ res(); }catch(_){} });
    ws.addEventListener('close',()=>{ log('ws: close'); });
    ws.addEventListener('message',ev=>{
      try{
        const m=JSON.parse(ev.data);
        if(m.type==='segment_saved'){
          const row=document.createElement('div');
          row.id='seg-'+m.idx;
          row.style.cssText='display:flex;gap:8px;align-items:flex-start;margin:4px 0;padding:4px 0;border-top:1px solid #eee';
          row.innerHTML=
            '<span style="display:inline-block;width:80px">'+m.idx+'</span>'+
            '<span style="display:inline-block;width:140px">'+(m.range||'')+'</span>'+
            '<span data-svc="gemini" style="white-space:pre-wrap;flex:1 1 auto">transcribing...</span>';
          tbody().appendChild(row);
        } else if(m.type==='transcript'){
          const row=document.getElementById('seg-'+m.idx);
          if(row){ const cell=row.querySelector('[data-svc=\'gemini\']'); if(cell) cell.textContent=m.text||m.error||''; }
        }
      }catch(_){ }
    });
  });
}
window.start = async function start(){
  try{
    document.getElementById('btnStart').disabled=true;
    document.getElementById('btnStop').disabled=false;
    segIdx=0; currentId=Date.now();
    log('start: requesting mic');
    media=await navigator.mediaDevices.getUserMedia({audio:true});
    log('start: opening ws');
    await wsOpen();
    log('start: mic granted');
    const mt = MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    rec=new MediaRecorder(media,{mimeType:mt});
    rec.onstart=()=>log('rec: started');
    rec.onerror=(e)=>log('rec: error '+(e&&e.error?e.error.name:'unknown'));
    rec.ondataavailable=async (e)=>{
      try{
        if(!e.data||!e.data.size) return;
        const ab=await e.data.arrayBuffer();
        const b64=btoa(String.fromCharCode(...new Uint8Array(ab)));
        const mime=e.data.type||'audio/webm';
        const ts=Date.now();
        const start=(ts-(segMs)), end=ts;
        if(ws&&ws.readyState===WebSocket.OPEN){
          ws.send(JSON.stringify({type:'segment', audio:b64, idx:segIdx, ts, mime, start, end, id:currentId, auto:document.getElementById('autoTx').checked}));
          log('sent segment '+segIdx+' bytes='+ab.byteLength);
        } else {
          log('ws not open; segment dropped');
        }
        segIdx++;
      }catch(err){ log('ondata error '+err); }
    };
    rec.start(segMs);
  }catch(err){
    log('start error: '+err);
    try{ document.getElementById('btnStart').disabled=false; document.getElementById('btnStop').disabled=true; }catch(_){ }
  }
}
window.stop = async function stop(){
  try{ if(rec&&rec.state==='recording') rec.stop(); }catch(_){ }
  try{ if(media){ media.getTracks().forEach(t=>{ try{ t.stop(); }catch(_){ } }); } }catch(_){ }
  document.getElementById('btnStart').disabled=false; document.getElementById('btnStop').disabled=true;
}
document.addEventListener('DOMContentLoaded',()=>{
  try{
    const bs=document.getElementById('btnStart'); if(bs&&!bs._bound){ bs.addEventListener('click', window.start); bs._bound=true; }
    const be=document.getElementById('btnStop'); if(be&&!be._bound){ be.addEventListener('click', window.stop); be._bound=true; }
  }catch(err){ console.log('[minimal] bind error', err); }
});
(function(){
  try{
    if(document.readyState!=='loading'){
      const bs=document.getElementById('btnStart'); if(bs&&!bs._bound){ bs.addEventListener('click', window.start); bs._bound=true; }
      const be=document.getElementById('btnStop'); if(be&&!be._bound){ be.addEventListener('click', window.stop); be._bound=true; }
      log('init: handlers bound immediately');
    } else {
      log('init: waiting DOMContentLoaded');
    }
  }catch(err){ console.log('[minimal] init error', err); }
})();
"""

_HDRS = (Script(src=None, content=_INLINE_JS()),)

app, rt = fast_app(exts='ws', hdrs=_HDRS)

# Serve static for saved recordings only; UI is inline
_STATIC = os.path.join(_ROOT, "static")
os.makedirs(os.path.join(_STATIC, "recordings"), exist_ok=True)
try:
    app.mount("/static", StaticFiles(directory=_STATIC), name="static")
except Exception:
    pass


# --- Minimal provider: Gemini consumer API (optional) ---
class GeminiClient:
    def __init__(self, api_key: str, model_name: str = "gemini-2.5-flash") -> None:
        self._client = genai_sdk.Client(api_key=api_key) if genai_sdk else None
        self._model = model_name

    def transcribe(self, raw: bytes, mime_type: str) -> str:
        if not self._client:
            return ""
        try:
            parts = [
                "Transcribe the spoken audio to plain text. Return only the transcript.",
                genai_types.Part.from_bytes(raw, mime_type=mime_type) if genai_types else {"mime_type": mime_type, "data": raw},
            ]
            resp = self._client.models.generate_content(model=self._model, contents=parts)
            # Prefer candidates/parts path, fall back to .text
            try:
                cands = getattr(resp, "candidates", None) or []
                if cands and getattr(cands[0], "content", None) and getattr(cands[0].content, "parts", None):
                    texts = [getattr(p, "text", "") for p in cands[0].content.parts]
                    text = " ".join([t.strip() for t in texts if isinstance(t, str) and t.strip()]).strip()
                    if text:
                        return text
            except Exception:
                pass
            txt = getattr(resp, "text", None)
            if isinstance(txt, str) and txt.strip():
                return txt.strip()
            return ""
        except Exception as e:
            print(f"Gemini transcribe error: {e}")
            return ""


GEMINI: GeminiClient | None
try:
    key = (os.environ.get("GEMINI_API_KEY") or "").strip()
    GEMINI = GeminiClient(key) if key and genai_sdk else None
    if GEMINI:
        print("Gemini client ready (consumer API)")
    else:
        print("Gemini client not configured; transcripts will be empty")
except Exception as e:
    print(f"Gemini init failed: {e}")
    GEMINI = None


@rt("/")
def index():
    # Minimal inline UI: Start/Stop, checkbox, segments table
    return Titled("Live Transcription",
        Div(
            Div(
                # Use FastHTML forms with hx-post; trigger native start/stop via hx-on
                Form(hx_post="/control/start", hx_target="#log", hx_swap="beforeend")(
                    Button("Start", id="btnStart", type="submit", **{"hx-on":"click: js: window.start && window.start()"})
                ),
                Form(hx_post="/control/stop", hx_target="#log", hx_swap="beforeend")(
                    Button("Stop", id="btnStop", disabled=True, type="submit", **{"hx-on":"click: js: window.stop && window.stop()"})
                ),
                Label(Input(type="checkbox", id="autoTx", checked=True), " Auto Transcribe"),
                id="toolbar", cls="toolbar"
            ),
            Div(id="log", style="font-family:monospace;font-size:12px;color:#444;margin:6px 0"),
            Hr(),
            H3("Segments"),
            Div(
                Div(
                    Span("Segment", style="display:inline-block;width:80px;font-weight:bold"),
                    Span("Time", style="display:inline-block;width:140px;font-weight:bold"),
                    Span("Transcript", style="display:inline-block;font-weight:bold"),
                    style="margin-bottom:6px"
                ),
                Div(id="tbody"),
                id="segwrap", style="width:100%"
            ),
        )
    )


def _INLINE_JS() -> str:
    # Minimal inline JS; native API for recording and WS
    return """
console.log('[minimal] inline JS loaded');
let ws=null, media=null, rec=null, segMs=10000, currentId=Date.now(), segIdx=0;
const tbody=()=>document.getElementById('tbody');
const logEl=()=>document.getElementById('log');
function log(msg){ try{ console.log('[minimal]', msg); if(logEl()){ const p=document.createElement('div'); p.textContent=String(msg); logEl().appendChild(p); } }catch(_){} }
const autoTx=()=>document.getElementById('autoTx').checked;
function wsOpen(){
  if(ws&&ws.readyState===WebSocket.OPEN) return Promise.resolve();
  return new Promise((res)=>{
    ws=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws');
    ws.addEventListener('open',()=>{ try{ ws.send(JSON.stringify({type:'hello'})); }catch(_){} log('ws: open'); res(); });
    ws.addEventListener('error',()=>{ log('ws: error (continuing)'); try{ res(); }catch(_){} });
    ws.addEventListener('close',()=>{ log('ws: close'); });
    ws.addEventListener('message',ev=>{
      try{
        const m=JSON.parse(ev.data);
        if(m.type==='segment_saved'){
          const row=document.createElement('div');
          row.id='seg-'+m.idx;
          row.style.cssText='display:flex;gap:8px;align-items:flex-start;margin:4px 0;padding:4px 0;border-top:1px solid #eee';
          row.innerHTML=
            '<span style="display:inline-block;width:80px">'+m.idx+'</span>'+
            '<span style="display:inline-block;width:140px">'+(m.range||'')+'</span>'+
            '<span data-svc="gemini" style="white-space:pre-wrap;flex:1 1 auto">transcribing...</span>';
          tbody().appendChild(row);
        } else if(m.type==='transcript'){
          const row=document.getElementById('seg-'+m.idx);
          if(row){ const cell=row.querySelector('[data-svc=\'gemini\']'); if(cell) cell.textContent=m.text||m.error||''; }
        }
      }catch(_){ }
    });
  });
}
window.start = async function start(){
  try{
    document.getElementById('btnStart').disabled=true;
    document.getElementById('btnStop').disabled=false;
    segIdx=0; currentId=Date.now();
    log('start: opening ws');
    await wsOpen();
    log('start: requesting mic');
    media=await navigator.mediaDevices.getUserMedia({audio:true});
    log('start: mic granted');
    const mt = MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    rec=new MediaRecorder(media,{mimeType:mt});
    rec.onstart=()=>log('rec: started');
    rec.onerror=(e)=>log('rec: error '+(e&&e.error?e.error.name:'unknown'));
    rec.ondataavailable=async (e)=>{
      try{
        if(!e.data||!e.data.size) return;
        const ab=await e.data.arrayBuffer();
        const b64=btoa(String.fromCharCode(...new Uint8Array(ab)));
        const mime=e.data.type||'audio/webm';
        const ts=Date.now();
        const start=(ts-(segMs)), end=ts;
        if(ws&&ws.readyState===WebSocket.OPEN){
          ws.send(JSON.stringify({type:'segment', audio:b64, idx:segIdx, ts, mime, start, end, id:currentId, auto:autoTx()}));
          log('sent segment '+segIdx+' bytes='+ab.byteLength);
        } else {
          log('ws not open; segment dropped');
        }
        segIdx++;
      }catch(err){ log('ondata error '+err); }
    };
    rec.start(segMs);
  }catch(err){
    log('start error: '+err);
    try{ document.getElementById('btnStart').disabled=false; document.getElementById('btnStop').disabled=true; }catch(_){ }
  }
}
window.stop = async function stop(){
  try{ if(rec&&rec.state==='recording') rec.stop(); }catch(_){ }
  try{ if(media){ media.getTracks().forEach(t=>{ try{ t.stop(); }catch(_){ } }); } }catch(_){ }
  document.getElementById('btnStart').disabled=false; document.getElementById('btnStop').disabled=true;
}
document.addEventListener('DOMContentLoaded',()=>{
  try{
    const bs=document.getElementById('btnStart'); if(bs&&!bs._bound){ bs.addEventListener('click', window.start); bs._bound=true; }
    const be=document.getElementById('btnStop'); if(be&&!be._bound){ be.addEventListener('click', window.stop); be._bound=true; }
  }catch(err){ console.log('[minimal] bind error', err); }
});
(function(){
  // Also bind immediately if DOM is already interactive/complete
  try{
    if(document.readyState!=='loading'){
      const bs=document.getElementById('btnStart'); if(bs&&!bs._bound){ bs.addEventListener('click', window.start); bs._bound=true; }
      const be=document.getElementById('btnStop'); if(be&&!be._bound){ be.addEventListener('click', window.stop); be._bound=true; }
      log('init: handlers bound immediately');
    } else {
      log('init: waiting DOMContentLoaded');
    }
  }catch(err){ console.log('[minimal] init error', err); }
})();
"""


@app.ws("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        print("[minimal] ws: accepted")
    except Exception:
        pass
    import base64
    session_ts = str(int(__import__('time').time()*1000))
    seg_dir = Path(_STATIC) / "recordings" / f"session_{session_ts}"
    seg_dir.mkdir(parents=True, exist_ok=True)

    try:
        while True:
            msg = await websocket.receive_json()
            mtype = msg.get("type") if isinstance(msg, dict) else None
            try:
                print(f"[minimal] ws: recv type={mtype}")
            except Exception:
                pass
            if mtype == "hello":
                await websocket.send_json({"type": "ready"})
                continue
            if mtype == "segment":
                try:
                    raw = base64.b64decode((msg.get("audio") or "").encode("utf-8"))
                except Exception:
                    raw = b""
                idx = int(msg.get("idx") or 0)
                mime = (msg.get("mime") or "audio/webm").lower()
                ext = "ogg" if "ogg" in mime else "webm"
                p = seg_dir / f"segment_{idx}.{ext}"
                try:
                    with open(p, "wb") as f:
                        f.write(raw)
                except Exception:
                    pass
                # send ack to render row
                start_ms = int(msg.get("start") or 0)
                end_ms = int(msg.get("end") or 0)
                rng = f"{_fmt_ms(start_ms)} – {_fmt_ms(end_ms)}" if start_ms and end_ms else ""
                await websocket.send_json({"type": "segment_saved", "idx": idx, "url": f"/static/recordings/session_{session_ts}/segment_{idx}.{ext}", "range": rng})
                # transcribe inline, sequentially
                text = ""
                if GEMINI and (msg.get("auto") is None or bool(msg.get("auto", True))):
                    try:
                        # try preferred container first, then fallback
                        order = ["audio/ogg", "audio/webm"] if ext == "ogg" else ["audio/webm", "audio/ogg"]
                        for mt in order:
                            text = GEMINI.transcribe(raw, mt)
                            if text:
                                break
                    except Exception as e:
                        text = ""
                        print(f"transcribe error idx={idx}: {e}")
                await websocket.send_json({"type": "transcript", "idx": idx, "text": text, "svc": "gemini"})
                continue
    except Exception:
        try:
            await websocket.close()
        except Exception:
            pass


def _fmt_ms(ms: int) -> str:
    try:
        if not ms:
            return "0:00"
        s = int(round(ms/1000))
        return f"{s//60}:{(s%60):02d}"
    except Exception:
        return ""


# HTMX control endpoints to acknowledge Start/Stop clicks
@rt("/control/start", methods=["POST"])
def control_start():
    try:
        print("[minimal] control/start")
    except Exception:
        pass
    return Div("started…")


@rt("/control/stop", methods=["POST"])
def control_stop():
    try:
        print("[minimal] control/stop")
    except Exception:
        pass
    return Div("stopped.")


if __name__ == "__main__":
    try:
        import uvicorn
        uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 5001)), reload=False, log_level="info")
    except Exception:
        serve()


