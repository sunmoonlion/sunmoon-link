import http from "node:http";
import {describe,it,expect} from "vitest";
import {browserLaunch,createPairPage,publicPairState,runPairPage,type PairPage} from "../src/pairPage.js";
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean){for(let n=0;n<100&&!check();n++)await pause(10);expect(check()).toBe(true);}
function request(url:string,options:{method?:string;headers?:Record<string,string>;body?:string}={}){
  return new Promise<{status:number;headers:http.IncomingHttpHeaders;body:string}>((resolve,reject)=>{
    const req=http.request(url,{method:options.method??"GET",headers:options.headers},res=>{
      let body="";res.on("data",chunk=>body+=chunk);res.on("end",()=>resolve({status:res.statusCode!,headers:res.headers,body}));
    });req.on("error",reject);req.end(options.body);
  });
}
describe("browser setup page boundaries",()=>{
  it("serves only loopback nonce routes, denies bad host/origin/referer/method/body and exposes no credentials",async()=>{
    let refresh=0,cancel=0,done=0;
    const page=await createPairPage({refresh:async()=>{refresh++;},cancel:async()=>{cancel++;},done:async()=>{done++;}});
    try{
      expect(new URL(page.url).hostname).toBe("127.0.0.1");expect(new URL(page.url).pathname).toMatch(/^\/setup\/[a-f0-9]{64}$/);
      const main=await request(page.url);expect(main.status).toBe(200);
      expect(main.headers["cache-control"]).toBe("no-store");expect(main.headers["referrer-policy"]).toBe("no-referrer");
      expect(main.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(main.headers["content-security-policy"]).toContain("connect-src 'self'");
      expect(main.body).toContain("去网站允许");
      expect(main.body).toContain("复制确认码");
      expect(main.body).toContain("navigator.clipboard.writeText");
      expect(main.body).toContain("网站页应该已经自动打开并填好了码，只要点「允许」。没有自动打开就点下面「去网站允许」。");
      expect(main.body).toContain("别人发给你的码不要允许");
      expect(main.body).not.toContain("在核对页输入确认码");
      expect(main.body).not.toMatch(/<script\s+src=|<link\s/);
      for(const url of [page.url.replace(/.$/,"Z"),page.url+"?other=1",page.url+"/../state",page.url+"/unknown"])
        expect((await request(url)).status).toBe(404);
      for(const headers of [{Host:"localhost:"+new URL(page.url).port},{Origin:"https://evil.example"},{Referer:"https://evil.example/"},{Origin:"null"}])
        expect((await request(page.url+"/refresh",{method:"POST",headers})).status).toBe(403);
      expect((await request(page.url+"/refresh")).status).toBe(405);
      expect((await request(page.url+"/state",{method:"POST"})).status).toBe(405);
      expect((await request(page.url+"/refresh",{method:"POST",body:'{"approved":true}',headers:{"Content-Length":"17"}})).status).toBe(400);
      expect((await request(page.url+"/done",{method:"POST"})).status).toBe(409);
      page.update({event:"code",user_code:"ABCD-2345",agent_token:"never-return-token",device_secret:"never-return-secret"} as never);
      const state=await request(page.url+"/state");expect(state.status).toBe(200);
      expect(JSON.parse(state.body)).toEqual({event:"code",user_code:"ABCD-2345"});
      expect(state.body).not.toMatch(/token|secret/);
      const origin=new URL(page.url).origin;
      expect((await request(page.url+"/refresh",{method:"POST",headers:{Origin:origin,Referer:page.url}})).status).toBe(202);
      expect(refresh).toBe(1);expect(done).toBe(0);expect(cancel).toBe(0);
      expect((await request(page.url+"/cancel",{method:"POST"})).status).toBe(202);expect(cancel).toBe(1);
    }finally{await page.close();}
    await expect(request(page.url)).rejects.toThrow();
  });
  it("projects a new safe state rather than retaining old codes or returning arbitrary fields",()=>{
    expect(publicPairState({event:"result",status:"approved",account:"owner",token:"hidden"} as never)).toEqual({event:"result",status:"approved",account:"owner"});
  });
  it("uses generated safe Windows browser arguments, rejects shell syntax and credentials",()=>{
    expect(browserLaunch("http://127.0.0.1:4000/setup/"+"a".repeat(64),"win32")).toEqual({command:"cmd.exe",args:["/d","/c","start","","http://127.0.0.1:4000/setup/"+"a".repeat(64)]});
    for(const url of ["https://user:pass@example.com","https://example.com/?x=1&evil=2","file:///C:/file","https://example.com/%PATH%"])
      expect(()=>browserLaunch(url,"win32")).toThrow();
  });
});

describe("pair page lifecycle",()=>{
  it("approves through the injected TLS pair flow, starts once, completes and closes the port",async()=>{
    let page!:PairPage,started=0;const opened:string[]=[];
    const task=runPairPage({ready:async current=>{page=current;},open:async url=>{opened.push(url);return true;},
      run:async(_cancel,progress)=>{progress({event:"code",user_code:"ABCD-2345",verify_url:"https://site.example/settings#computer"});progress({event:"result",status:"approved",account:"owner"});return 0;},
      complete:async()=>{started++;}});
    await until(()=>page?.state().status==="connected");
    expect(started).toBe(1);expect(opened).toContain(page.url);expect(opened).toContain("https://site.example/settings#computer");
    expect(page.state().account).toBe("owner");expect(JSON.stringify(page.state())).not.toMatch(/agent_token|device_secret/);
    await request(page.url+"/done",{method:"POST"});await task;
    await expect(request(page.url)).rejects.toThrow();
  });
  it("refresh cancels the previous request before starting another; cancel leaves no server",async()=>{
    let page!:PairPage,runs=0,active=0,maximum=0,cancelled=0;
    const task=runPairPage({ready:async current=>{page=current;},open:async()=>true,complete:async()=>{throw Error("must not start");},
      run:async(cancel,progress)=>{runs++;active++;maximum=Math.max(maximum,active);progress({event:"code",user_code:"ABCD-2345"});while(!cancel())await pause(5);cancelled++;active--;return 6;}});
    await until(()=>runs===1);
    await Promise.all([request(page.url+"/refresh",{method:"POST"}),request(page.url+"/refresh",{method:"POST"})]);
    await until(()=>runs===2);expect(maximum).toBe(1);expect(cancelled).toBe(1);
    await request(page.url+"/cancel",{method:"POST"});await task;
    expect(active).toBe(0);expect(cancelled).toBe(2);
  });
  it("retries startup without obtaining another token and expires after bounded lifetime",async()=>{
    let page!:PairPage,runs=0,starts=0;
    const controller=new AbortController();
    const task=runPairPage({ready:async current=>{page=current;},signal:controller.signal,open:async()=>false,
      run:async()=>{runs++;return 0;},complete:async()=>{if(++starts===1)throw Error("synthetic startup failure");}});
    await until(()=>page?.state().status==="startup-failed");
    await request(page.url+"/refresh",{method:"POST"});await until(()=>page.state().status==="connected");
    expect(runs).toBe(1);expect(starts).toBe(2);controller.abort();await task;
    let expired!:PairPage;
    await runPairPage({ready:async current=>{expired=current;},lifetimeMs:30,open:async()=>false,complete:async()=>{},run:async cancel=>{while(!cancel())await pause(5);return 6;}});
    await expect(request(expired.url)).rejects.toThrow();
  });
});
