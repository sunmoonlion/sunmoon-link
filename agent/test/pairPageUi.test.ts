import vm from "node:vm";
import {describe,it,expect,vi} from "vitest";
import {createPairPage,runPairPage,type PairPage} from "../src/pairPage.js";

const wait=()=>new Promise(resolve=>setTimeout(resolve,10));
async function until(check:()=>boolean){for(let n=0;n<100&&!check();n++)await wait();expect(check()).toBe(true);}
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

// Execute the exact served inline script, with only browser APIs replaced.
function browser(html:string,url:string,fetcher:typeof fetch){
  const elements=new Map([...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map(([tag,id])=>[id,{
    hidden:tag.includes(" hidden"),textContent:"",href:"",onclick:undefined as undefined|(()=>Promise<void>),
    removeAttribute(name:string){if(name==="href")this.href="";},
  }]));
  const close=vi.fn(),clearInterval=vi.fn();
  const script=/<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1];
  const actions=vm.runInNewContext(script+"\n({poll,command})",{
    document:{getElementById:(id:string)=>elements.get(id)},location:{pathname:new URL(url).pathname},
    fetch:fetcher,window:{close},navigator:{},AbortSignal,Date,
    setInterval:()=>1,clearInterval,setTimeout,clearTimeout,
  }) as {poll:()=>Promise<void>;command:(name:string)=>Promise<void>};
  return {elements,close,clearInterval,...actions};
}
async function html(){const page=await createPairPage({refresh:async()=>{},cancel:async()=>{},done:async()=>{}});try{return await (await fetch(page.url)).text();}finally{await page.close();}}
const result=(value:object)=>new Response(JSON.stringify(value),{status:200});

describe("served pairing page completion",()=>{
  it("automatically acknowledges connected, closes the local server and attempts to close only this page",async()=>{
    let page!:PairPage,starts=0,settled=false;
    const controller=new AbortController();
    const task=runPairPage({signal:controller.signal,ready:async value=>{page=value;},open:async()=>true,
      run:async()=>0,complete:async()=>{starts++;}}).then(()=>{settled=true;});
    try{
      await until(()=>page?.state().status==="connected");
      const source=await (await fetch(page.url)).text();
      const fetcher=vi.fn((url:string,options?:RequestInit)=>fetch(new URL(url,page.url),options));
      const ui=browser(source,page.url,fetcher as typeof fetch);
      await until(()=>ui.close.mock.calls.length===1&&settled);
      expect(starts).toBe(1);
      expect(fetcher.mock.calls.map(([url])=>url.split('/').at(-1))).toEqual(['state','done']);
      await expect(fetch(page.url)).rejects.toThrow();
      // close() was blocked by this fake browser; the remaining view is success.
      expect(ui.elements.get('message')!.textContent).toContain('本地 link 已在线');
      expect(ui.elements.get('next')!.hidden).toBe(false);
      for(const id of ['refresh','cancel','verify','copy','warning'])expect(ui.elements.get(id)!.hidden).toBe(true);
      for(const id of ['code','clock','copyStatus'])expect(ui.elements.get(id)!.textContent).toBe('');
      expect(ui.elements.get('verify')!.href).toBe('');
      await ui.poll();await ui.command('done');
      expect(fetcher).toHaveBeenCalledTimes(2);expect(ui.close).toHaveBeenCalledTimes(2);
    }finally{controller.abort();await task;}
  });

  it("keeps observed success when the completion acknowledgement is lost",async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(result({event:'result',status:'connected'})).mockRejectedValueOnce(Error('server closed'));
    const ui=browser(await html(),'http://127.0.0.1/setup/test',fetcher);
    await until(()=>ui.close.mock.calls.length===1);
    await ui.poll();
    expect(ui.elements.get('message')!.textContent).toContain('本地 link 已在线');
    expect(ui.elements.get('message')!.textContent).not.toContain('已停止');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(['reply','disconnect'])("cancel clears the code and ignores a late poll %s",async outcome=>{
    const pending=deferred<Response>();
    const fetcher=vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(new Response('Accepted',{status:202}));
    const ui=browser(await html(),'http://127.0.0.1/setup/test',fetcher);
    ui.elements.get('code')!.textContent='ABCD-2345';
    await ui.command('cancel');
    if(outcome==='reply')pending.resolve(result({event:'code',user_code:'OLD-CODE',verify_url:'https://example.test'}));
    else pending.reject(Error('server closed'));
    await wait();await ui.poll();
    expect(ui.close).toHaveBeenCalledTimes(1);expect(fetcher).toHaveBeenCalledTimes(2);
    expect(ui.elements.get('message')!.textContent).toContain('取消请求已提交');
    expect(ui.elements.get('code')!.textContent).toBe('');
    expect(ui.elements.get('verify')!.hidden).toBe(true);expect(ui.elements.get('next')!.hidden).toBe(true);
  });

  it("does not claim cancellation undid a connection completing during the cancel request",async()=>{
    let page!:PairPage,settled=false,runs=0,starts=0;
    const startup=deferred<void>();const controller=new AbortController();
    const task=runPairPage({signal:controller.signal,ready:async value=>{page=value;},open:async()=>true,
      run:async()=>{runs++;return 0;},complete:()=>{starts++;return startup.promise;}}).then(()=>{settled=true;});
    try{
      await until(()=>page?.state().status==='starting');
      const source=await (await fetch(page.url)).text();
      const ui=browser(source,page.url,((url:string,options?:RequestInit)=>fetch(new URL(url,page.url),options)) as typeof fetch);
      await ui.command('cancel');
      expect(ui.close).toHaveBeenCalledTimes(1);expect(settled).toBe(false);
      startup.resolve();await task;await ui.poll();
      expect(page.state().status).toBe('connected');
      expect(runs).toBe(1);expect(starts).toBe(1);
      await expect(fetch(page.url)).rejects.toThrow();
      expect(ui.elements.get('message')!.textContent).toContain('取消请求已提交');
      expect(ui.elements.get('message')!.textContent).toContain('会继续在后台运行');
      expect(ui.elements.get('next')!.hidden).toBe(true);
    }finally{startup.resolve();controller.abort();await task;}
  });

  it("does not finish at approval or startup failure; retry remains available until connected",async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(result({event:'result',status:'approved'}));
    const ui=browser(await html(),'http://127.0.0.1/setup/test',fetcher);
    await wait();expect(ui.close).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(result({event:'result',status:'startup-failed',message:'请重试'}));
    await ui.poll();
    expect(ui.elements.get('refresh')!.hidden).toBe(false);expect(ui.elements.get('refresh')!.textContent).toBe('重试');
    expect(ui.elements.get('done')!.hidden).toBe(true);
    fetcher.mockResolvedValueOnce(new Response('Accepted',{status:202}));await ui.command('refresh');
    expect(ui.close).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(result({event:'result',status:'connected'})).mockResolvedValueOnce(new Response('Accepted',{status:202}));
    await ui.poll();expect(ui.close).toHaveBeenCalledTimes(1);
  });

  it("retains retry after an unacknowledged cancel instead of claiming it succeeded",async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(result({event:'code',user_code:'ABCD-2345'}));
    const ui=browser(await html(),'http://127.0.0.1/setup/test',fetcher);await wait();
    fetcher.mockRejectedValueOnce(Error('network'));await ui.command('cancel');
    expect(ui.close).not.toHaveBeenCalled();expect(ui.elements.get('message')!.textContent).toContain('操作未完成');
    fetcher.mockResolvedValueOnce(result({event:'code',user_code:'ABCD-2345'}));await ui.poll();
    expect(fetcher).toHaveBeenCalledTimes(3);expect(ui.elements.get('copy')!.hidden).toBe(false);
  });
});
