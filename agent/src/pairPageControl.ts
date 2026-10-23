// Discovery only, never pairing progress or credentials. The protected home lets
// the tray find the memory-only page when the default browser cannot open.
import fs from "node:fs";
import path from "node:path";
import {spawn} from "node:child_process";
import net from "node:net";
import {fileURLToPath} from "node:url";
import {CONFIG_DIR} from "./config.js";
import {checkControlDirectory,pidAlive,instanceKey} from "./resident.js";
import {publicPairState,openDefaultBrowser,type PairPage} from "./pairPage.js";
import {nodeLaunch,applyLaunchEnv,installedSite} from "./siteTrust.js";

const file=()=>path.join(CONFIG_DIR,"pair-page.json");
/** A mutex only; no command, status or permission requests on this pipe. */
export async function acquirePairPage():Promise<(()=>Promise<void>)|null>{
  checkControlDirectory();
  const server=net.createServer(socket=>socket.destroy());
  try{await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(`\\\\.\\pipe\\sunmoon-pair-page-${instanceKey(CONFIG_DIR)}`,resolve);});}
  catch(error){if((error as NodeJS.ErrnoException).code==="EADDRINUSE")return null;throw error;}
  return ()=>new Promise<void>(resolve=>server.close(()=>resolve()));
}
export interface PageDiscovery {pid:number;url:string}
export function readPageDiscovery(target=file(),alive=pidAlive):PageDiscovery|null{
  try{
    const st=fs.lstatSync(target);
    if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>1024)throw new Error("Unsafe pairing page discovery");
    const item=JSON.parse(fs.readFileSync(target,"utf8"));
    const match=/^http:\/\/127\.0\.0\.1:(\d{1,5})\/setup\/[a-f0-9]{64}$/.exec(item.url);
    if(!Number.isSafeInteger(item.pid)||item.pid<=0||!match||Number(match[1])<1||Number(match[1])>65535||Object.keys(item).sort().join(",")!=="pid,url")throw new Error("Invalid pairing page discovery");
    return alive(item.pid)?item:null;
  }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}
}
export function publishPageDiscovery(page:PairPage,target=file()):()=>void{
  const old=readPageDiscovery(target);
  if(old)throw new Error("接入页已经打开，请使用现有页面。");
  // readPageDiscovery checks a stale plain file before it may be removed.
  if(fs.existsSync(target))fs.unlinkSync(target);
  fs.writeFileSync(target,JSON.stringify({pid:process.pid,url:page.url}),{flag:"wx",mode:0o600});
  return ()=>{
    const current=readPageDiscovery(target);
    if(current?.pid===process.pid&&current.url===page.url)fs.unlinkSync(target);
  };
}
export async function pairingPageStatus():Promise<object>{
  checkControlDirectory();
  const record=readPageDiscovery();if(!record)return {active:false};
  try{
    const response=await fetch(record.url+"/state",{redirect:"error",signal:AbortSignal.timeout(2000)});
    if(!response.ok)return {active:false};
    return {active:true,url:record.url,...publicPairState(await response.json())};
  }catch{return {active:false};}
}
/** No PowerShell in the pairing launch path. Resolve after the page publishes. */
export async function openPairPage():Promise<void>{
  checkControlDirectory();
  const old=readPageDiscovery();if(old){await openDefaultBrowser(old.url);return;}
  const launch=nodeLaunch(installedSite(import.meta.url));
  const child=spawn(process.execPath,[...launch.execArgv,fileURLToPath(new URL("./cli.js",import.meta.url)),"pair","--page"],{
    env:{...applyLaunchEnv(process.env,launch),SUNMOON_AGENT_HOME:CONFIG_DIR},detached:true,windowsHide:true,stdio:"ignore",
  });
  let failed=false;child.once("error",()=>{failed=true;});child.unref();
  for(let n=0;n<100;n++){
    if(readPageDiscovery())return;
    if(failed||child.exitCode!==null)throw new Error("本机颁发令牌页未能启动，请查看本地 link 的日志。");
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error("本机接入页启动超时，请查看托盘连接状态。");
}
