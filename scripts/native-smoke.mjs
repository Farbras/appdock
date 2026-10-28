import fs from 'node:fs';
const {chromium}=await import(process.env.APPDOCK_PLAYWRIGHT||'playwright');
const browser=await chromium.connectOverCDP('http://127.0.0.1:9224');
try{
 const pages=browser.contexts().flatMap(c=>c.pages());const page=pages.find(p=>/tauri\.localhost|tauri:\/\//.test(p.url()))||pages[0];if(!page)throw new Error('Native WebView not found');
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.getByRole('heading',{name:'Подготовьте компьютер к работе'}).waitFor();
 const system=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('system_info'));
 if(!system.windows||!system.winget||system.freeDiskMb===null)throw new Error('Native system IPC failed');
 const queue=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('queue_snapshot'));
 if(queue.running)throw new Error('Unexpected real active queue; will not interfere');
 const unsafe=await page.evaluate(async()=>{try{await window.__TAURI_INTERNALS__.invoke('prepare_plan',{items:[{appId:'cmd.exe',action:'install',options:{},extensions:[]}],skipCurrent:true,parallelDownloads:1});return false}catch{return true}});
 if(!unsafe)throw new Error('Native plan must reject untrusted products');
 const unsupported=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('prepare_plan',{items:[{appId:'safari',action:'install',options:{},extensions:[]}],skipCurrent:true,parallelDownloads:1}));
 if(!unsupported.items[0].blocked)throw new Error('Safari install must be blocked');
 const plan=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('prepare_plan',{items:[{appId:'python',action:'install',options:{pip:true,path:true,scope:'user'},extensions:[]}],skipCurrent:true,parallelDownloads:1}));
 if(plan.items[0].blocked||plan.mode!=='live')throw new Error('Valid native review plan failed');
 await page.getByRole('button',{name:'Настройки',exact:true}).click();
 const toggle=page.getByRole('switch',{name:'Демонстрационный режим'});
 if(await toggle.getAttribute('aria-checked')==='false')await toggle.click();
 await page.getByRole('button',{name:'Каталог',exact:true}).click();
 await page.locator('.main-scroll').evaluate(el=>el.scrollTop=0);
 fs.mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/native-catalog.png'});
 if(errors.length)throw new Error(errors.join('; '));
 fs.writeFileSync('artifacts/native-smoke.json',JSON.stringify({passed:true,checks:['WebView2 render','system_info IPC','queue_snapshot IPC','reject arbitrary ID','block Safari for Windows','valid Python review (not started)','demo switch'],winget:system.winget,arch:system.arch},null,2));
 console.log('PASS: real Tauri/WebView2, system/queue IPC, rejected unsafe ID, blocked Safari, reviewed Python plan without execution, demo switch. No programs installed.');
}finally{await browser.close()}
