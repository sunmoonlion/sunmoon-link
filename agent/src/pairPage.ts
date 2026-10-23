// Browser presentation only. Pairing credentials stay in runPair and config.
import http, {type IncomingMessage} from "node:http";
import {randomBytes} from "node:crypto";
import {spawn} from "node:child_process";
import {type PairProgress} from "./pair.js";

export interface PageState extends PairProgress { browser_opened?: boolean }
/** Only deliberately mapped human errors can become browser text. */
export class PairPageError extends Error {}
const fields = ["event","user_code","expires_at","verify_url","status","message","account"] as const;
/** Explicit projection: extra fields from any caller can never reach the page. */
export function publicPairState(input: PairProgress): PairProgress {
  const result: PairProgress={event:"starting"};
  for(const key of fields)if(typeof input[key]==="string")result[key]=input[key]!.slice(0,2048);
  return result;
}

export function localRequestAllowed(req: Pick<IncomingMessage,"headers">, origin: string): boolean {
  if(req.headers.host!==new URL(origin).host)return false;
  if(req.headers.origin && req.headers.origin!==origin)return false;
  if(req.headers.referer){
    try {const ref=new URL(req.headers.referer);if(ref.origin!==origin||ref.username||ref.password)return false;}
    catch{return false;}
  }
  return true;
}

export function browserLaunch(url:string, platform=process.platform):{command:string;args:string[]} {
  const parsed=new URL(url);
  // Local URL is generated here. Site URL is independently checked against site.json.
  if(!["http:","https:"].includes(parsed.protocol)||parsed.username||parsed.password||/[\s"<>^&|%\r\n]/.test(url))throw new Error("无法打开核对页面，请手动打开。");
  if(platform!=="win32")throw new Error("浏览器接入入口仅支持 Windows。");
  return {command:"cmd.exe",args:["/d","/c","start","",url]};
}
export async function openDefaultBrowser(url:string):Promise<boolean>{
  try{
    const plan=browserLaunch(url);
    return await new Promise(resolve=>{
      const child=spawn(plan.command,plan.args,{windowsHide:true,stdio:"ignore"});
      const timer=setTimeout(()=>{child.kill();resolve(false);},5000);
      child.once("error",()=>{clearTimeout(timer);resolve(false);});
      child.once("exit",code=>{clearTimeout(timer);resolve(code===0);});
    });
  }catch{return false;}
}

function pageHtml(scriptNonce:string):string{return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SunMoon · 颁发令牌</title><style nonce="${scriptNonce}">
body{font:17px system-ui,sans-serif;max-width:660px;margin:7vh auto;padding:24px;color:#182235;background:#f5f7fb}main{background:white;padding:28px;border-radius:14px}#code{font:42px monospace;letter-spacing:4px;cursor:pointer}button,a{display:inline-block;margin:10px 12px 10px 0}button{padding:10px 18px}#next{white-space:pre-line}#message{white-space:pre-line}a{color:#1654a3}
</style></head><body><main><h1>给本地 link 颁发令牌</h1><p id="message">正在取确认码…</p><div id="code" title="点击复制确认码"></div><p id="clock"></p><a id="verify" target="_blank" rel="noopener noreferrer" hidden>去网站允许</a><button id="copy" hidden>复制确认码</button><span id="copyStatus" role="status" aria-live="polite"></span><p id="warning" hidden>别人发给你的码不要允许。</p><p id="next" hidden>接下来选文件夹：托盘图标右键 → 这台电脑上的设置。不选的话工作和专家碰不到你的文件。\n登录时自动运行已打开，可在「这台电脑上的设置」里关闭。</p><button id="refresh">重新获取</button><button id="cancel">取消</button><button id="done" hidden>完成</button></main><script nonce="${scriptNonce}">
const base=location.pathname,byId=id=>document.getElementById(id);let polling=false,finished=false,copyTimer;
async function command(name){try{const response=await fetch(base+'/'+name,{method:'POST',cache:'no-store',credentials:'omit'});if(!response.ok)throw Error();if(name==='cancel'||name==='done'){finished=true;byId('message').textContent=name==='done'?'接入已完成，可以关闭此页。':'已取消，可以关闭此页。';for(const id of ['refresh','cancel','done','verify'])byId(id).hidden=true;}}catch{byId('message').textContent='操作未完成，请查看托盘连接状态。';}}
for(const name of ['refresh','cancel','done'])byId(name).onclick=()=>command(name);
async function copyCode(){const value=byId('code').textContent||'';if(!value)return;try{if(!navigator.clipboard?.writeText)throw Error('clipboard unavailable');await navigator.clipboard.writeText(value);byId('copyStatus').textContent='已复制';clearTimeout(copyTimer);copyTimer=setTimeout(()=>byId('copyStatus').textContent='',2000);}catch{const range=document.createRange();range.selectNodeContents(byId('code'));const selection=window.getSelection();selection?.removeAllRanges();selection?.addRange(range);byId('copyStatus').textContent='复制失败，确认码已选中，请手动复制。';}}
byId('copy').onclick=copyCode;byId('code').onclick=copyCode;
async function poll(){if(polling||finished)return;polling=true;try{const response=await fetch(base+'/state',{cache:'no-store',credentials:'omit'});if(!response.ok)throw Error();const state=await response.json();byId('code').textContent=state.user_code||'';byId('message').textContent=state.message||(state.event==='code'?'网站页应该已经自动打开并填好了码，只要点「允许」。没有自动打开就点下面「去网站允许」。':'正在取确认码…');const remaining=state.expires_at?Math.max(0,Math.ceil((Date.parse(state.expires_at)-Date.now())/1000)):0;byId('clock').textContent=state.event==='code'?(remaining?'剩余 '+remaining+' 秒':'确认码已过期，请重新获取。'):'';byId('warning').hidden=state.event!=='code';byId('verify').hidden=!state.verify_url;byId('copy').hidden=state.event!=='code';if(state.verify_url)byId('verify').href=state.verify_url;const online=state.status==='connected';byId('next').hidden=!online;byId('done').hidden=!online;byId('refresh').hidden=online||state.status==='starting';byId('refresh').textContent=state.status==='startup-failed'?'重试':'重新获取';}catch{byId('message').textContent='本机接入页已停止，请在托盘点『重新颁发令牌』。';}finally{polling=false;}}
poll();setInterval(poll,1000);
</script></body></html>`;}

export interface PairPage {
  url:string;
  update:(value:PageState)=>void;
  state:()=>PageState;
  close:()=>Promise<void>;
}
export async function createPairPage(handlers:{refresh:()=>Promise<void>;cancel:()=>Promise<void>;done:()=>Promise<void>}):Promise<PairPage>{
  const nonce=randomBytes(32).toString("hex"),scriptNonce=randomBytes(24).toString("base64");
  const base="/setup/"+nonce;
  let state:PageState={event:"starting",message:"正在取确认码…"},origin="",closed=false;
  const server=http.createServer(async(req,res)=>{
    res.setHeader("Cache-Control","no-store");res.setHeader("Referrer-Policy","no-referrer");
    res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("X-Frame-Options","DENY");
    res.setHeader("Content-Security-Policy",`default-src 'none'; script-src 'nonce-${scriptNonce}'; style-src 'nonce-${scriptNonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
    const finish=(code:number,value:string,type="text/plain; charset=utf-8")=>{res.writeHead(code,{"Content-Type":type});res.end(value);};
    if(!localRequestAllowed(req,origin)){req.resume();finish(403,"Forbidden");return;}
    const route=req.url??"";
    if(![base,base+"/state",base+"/refresh",base+"/cancel",base+"/done"].includes(route)){req.resume();finish(404,"Not found");return;}
    if(route===base||route===base+"/state"){
      req.resume();if(req.method!=="GET"){finish(405,"Method not allowed");return;}
      finish(200,route===base?pageHtml(scriptNonce):JSON.stringify(state),route===base?"text/html; charset=utf-8":"application/json; charset=utf-8");return;
    }
    if(req.method!=="POST"){req.resume();finish(405,"Method not allowed");return;}
    // No body parameters are accepted: remote code/token/approval is never an input.
    if(req.headers["transfer-encoding"]||Number(req.headers["content-length"]??0)!==0){req.resume();finish(400,"Body not accepted");return;}
    req.resume();
    const action=route.slice(base.length+1) as "refresh"|"cancel"|"done";
    if(action==="done"&&state.status!=="connected"){finish(409,"Not online");return;}
    finish(202,"Accepted");
    try{await handlers[action]();}catch{state={event:"result",status:"failed",message:"操作未完成，请查看托盘连接状态。"};}
  });
  server.requestTimeout=5000;server.headersTimeout=5000;server.keepAliveTimeout=1000;
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  const address=server.address();if(!address||typeof address==="string")throw new Error("本机接入页面无法启动。");
  origin=`http://127.0.0.1:${address.port}`;
  return {url:origin+base,update:value=>{const browser=value.browser_opened??state.browser_opened;state={...publicPairState(value),...(typeof browser==="boolean"?{browser_opened:browser}:{})};},state:()=>({...state}),close:()=>{
    if(closed)return Promise.resolve();closed=true;
    return new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});
  }};
}

export async function runPairPage(options:{
  run:(cancelled:()=>boolean,progress:(value:PairProgress)=>void)=>Promise<number>;
  complete:()=>Promise<void>;
  open?:(url:string)=>Promise<boolean>;
  ready?:(page:PairPage)=>Promise<void>;
  output?:(url:string)=>void;
  signal?:AbortSignal;
  lifetimeMs?:number;
}):Promise<void>{
  let generation:Promise<void>|undefined,cancelled=false,closing=false,approved=false,refreshing=false;
  let finish!:()=>void;
  const ended=new Promise<void>(resolve=>finish=resolve);
  const page=await createPairPage({refresh:async()=>refresh(),cancel:async()=>stop(),done:async()=>stop()});
  const startup=async()=>{
    page.update({event:"result",status:"starting",account:page.state().account,message:"已给 "+(page.state().account??"你的账号")+" 颁发令牌，正在启动本地 link…"});
    try{await options.complete();page.update({event:"result",status:"connected",account:page.state().account,message:"已在线"});}
    catch(error){page.update({event:"result",status:"startup-failed",account:page.state().account,message:error instanceof PairPageError?error.message:"代理还没有连上，请检查网络或代理设置，然后点重试。"});}
  };
  const begin=()=>{
    cancelled=false;
    generation=(async()=>{
      if(approved){await startup();return;}
      page.update({event:"starting",message:"正在取确认码…"});
      try{
        const code=await options.run(()=>cancelled,value=>{
          page.update(value);
          if(value.event==="code"&&value.verify_url)void(options.open??openDefaultBrowser)(value.verify_url);
        });
        if(code===0){approved=true;if(!closing)await startup();}
      }catch(error){if(!closing)page.update({event:"result",status:"failed",message:error instanceof PairPageError?error.message:"连不上站点。检查网络或代理设置，再重新获取。"});}
    })().finally(()=>{generation=undefined;});
  };
  const stop=async()=>{if(closing)return;closing=true;cancelled=true;await generation;await page.close();finish();};
  // Refresh cancels a pending request before a new request starts. Never overlap generations.
  // createPairPage dispatches this through the same small command surface.
  const refresh=async()=>{if(closing||refreshing)return;refreshing=true;try{cancelled=true;await generation;if(!closing)begin();}finally{refreshing=false;}};
  const abort=()=>void stop();options.signal?.addEventListener("abort",abort,{once:true});
  const timer=setTimeout(abort,options.lifetimeMs??30*60*1000);
  try{
    await options.ready?.(page);
    options.output?.(page.url);
    page.update({...page.state(),browser_opened:await(options.open??openDefaultBrowser)(page.url)});
    if(options.signal?.aborted){await stop();return;}
    begin();await ended;
  }finally{clearTimeout(timer);options.signal?.removeEventListener("abort",abort);cancelled=true;await generation;await page.close();}
}
