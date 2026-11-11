// Build first, then pass an existing playwright-core index.mjs path. No live
// account, token, tray or installed link is involved in this browser probe.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {createPairPage} from '../dist/pairPage.js';
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const browser=await chromium.launch({headless:true});
const evidence=[];
try{
  // Keep an unrelated website tab open throughout every close operation.
  const context=await browser.newContext();
  const site=await context.newPage();await site.setContent('<p>Website remains open</p>');
  for(const scenario of ['connected','blocked-close','cancel','startup-retry']){
    let completions=0,cancellations=0,refreshes=0;
    const server=await createPairPage({done:async()=>{completions++;await server.close();},cancel:async()=>{cancellations++;await server.close();},refresh:async()=>{refreshes++;}});
    const page=await context.newPage();
    try{
      if(scenario==='blocked-close')await page.addInitScript(()=>{window.close=()=>{window.closeAttempts=(window.closeAttempts??0)+1;};});
      server.update({event:'code',user_code:'ABCD-2345',verify_url:'https://example.test/approve',expires_at:new Date(Date.now()+60000).toISOString()});
      // OS browser launch starts a fresh tab at this URL. Avoid retaining the
      // automation-created about:blank as an extra navigation history entry.
      await page.evaluate(url=>location.replace(url),server.url);
      await page.locator('#code').filter({hasText:'ABCD-2345'}).waitFor();
      assert.equal(await page.evaluate(()=>history.length),1);
      assert.equal(await page.locator('#done').isVisible(),false);
      assert.equal(await page.locator('#next').isVisible(),false);
      assert.equal(await page.locator('#copy').isVisible(),true);
      if(scenario==='cancel'){
        const closed=page.waitForEvent('close');await page.locator('#cancel').click();await closed;
        assert.equal(cancellations,1);assert.equal(completions,0);
      }else{
        if(scenario==='startup-retry'){
          server.update({event:'result',status:'startup-failed',message:'Please retry startup'});
          await page.getByRole('button',{name:'重试',exact:true}).waitFor();
          assert.equal(page.isClosed(),false);assert.equal(completions,0);
          assert.equal(await page.locator('#copy').isVisible(),false);
          assert.equal(await page.locator('#verify').isVisible(),false);
          await page.getByRole('button',{name:'重试',exact:true}).click();
          await page.waitForFunction(()=>document.getElementById('refresh')?.textContent==='重试');
          assert.equal(refreshes,1);
        }
        const closed=scenario==='blocked-close'?null:page.waitForEvent('close');
        server.update({event:'result',status:'connected',message:'已在线'});
        if(closed)await closed;
        else{
          await page.waitForFunction(()=>window.closeAttempts===1);
          // Observe beyond another poll interval after the HTTP server exited.
          await page.waitForTimeout(1200);
          assert.match(await page.locator('#message').innerText(),/本地 link 已在线/);
          for(const id of ['refresh','cancel','verify','copy','warning'])assert.equal(await page.locator('#'+id).isVisible(),false,id);
          assert.equal(await page.locator('#next').isVisible(),true);
          await page.getByRole('button',{name:'关闭页面',exact:true}).click();
          assert.equal(await page.evaluate(()=>window.closeAttempts),2);
        }
        assert.equal(completions,1);assert.equal(cancellations,0);
      }
      assert.equal(site.isClosed(),false);
      await assert.rejects(fetch(server.url));
      evidence.push({scenario,result:'pass'});
    }finally{await server.close();if(!page.isClosed())await page.close();}
  }
  console.log(JSON.stringify({browser:browser.version(),evidence},null,2));
}finally{await browser.close();}
