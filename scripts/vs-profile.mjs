import fs from 'node:fs';
import crypto from 'node:crypto';
const channel=JSON.parse(fs.readFileSync('.tools/vs-channel.json','utf8'));
const payload=channel.channelItems.find(i=>i.id==='Microsoft.VisualStudio.Manifests.VisualStudio').payloads[0];
const localPath=process.argv[2];
const bytes=localPath?fs.readFileSync(localPath):Buffer.from(await(await fetch(payload.url)).arrayBuffer());
if(!localPath&&crypto.createHash('sha256').update(bytes).digest('hex')!==payload.sha256.toLowerCase())throw new Error('VS catalog checksum mismatch');
const catalog=JSON.parse(bytes.toString('utf8'));
fs.writeFileSync('.tools/vs-catalog.json',bytes);
const packages=catalog.packages.filter(p=>!p.productArch||p.productArch==='x64');
const workloads=packages.filter(p=>p.type==='Workload'&&p.localizedResources?.some(r=>r.language==='en-us'&&r.category==='Desktop & Mobile')&&!p.id.includes('BuildTools'));
const unique=[...new Map(workloads.map(w=>[w.id,w])).values()];
const out={checkedAt:'2026-10-28',version:catalog.info.productDisplayVersion,source:localPath?'Microsoft Visual Studio Installer local catalog cache':payload.url,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),verification:localPath?'local-installer-cache':'channel-sha256',channel:'https://aka.ms/vs/18/stable/channel',editions:[]};
for(const edition of ['community','professional','enterprise']) {
 const productId=`Microsoft.VisualStudio.Product.${edition[0].toUpperCase()+edition.slice(1)}`;
 const product=packages.find(p=>p.id===productId);
 const components=new Map(),excluded=[],selectedWorkloads=[];
 const supports=w=>!product?.dependencies||Object.values(product.dependencies).some((dep)=>typeof dep==='object'&&dep?.id===w.id)||Object.hasOwn(product.dependencies,w.id);
 function collect(id,type='Required',seen=new Set()){
  if(seen.has(id))return;seen.add(id);
  const p=packages.find(p=>p.id===id);if(!p){if(id.includes('Component')||id.includes('Workload'))excluded.push({id,reason:'Отсутствует в каталоге x64; проверяется Installer'});return}
  if(p.isDeprecated||p.isOutOfSupport||p.localizedResources?.some(r=>r.language==='en-us'&&/out of support|deprecated/i.test(r.title))){excluded.push({id,reason:'Снят с поддержки / устарел в официальном каталоге'});return}
  if(['Component','ComponentGroup','Workload'].includes(p.type)&&!components.has(id))components.set(id,{id,type});
  if(['Component','ComponentGroup','Workload'].includes(p.type))for(const [key,dep]of Object.entries(p.dependencies||{})){
   const d=typeof dep==='object'?dep:{};const depId=d.id||key;
   if(d.when?.some(w=>w.startsWith('Microsoft.VisualStudio.Product.'))&&!d.when.includes(productId)){excluded.push({id:depId,reason:`Недоступен в редакции ${edition}`});continue}
   if(d.chip&&d.chip!=='x64')continue;
   // Installer resolves non-product applicability conditions at runtime.
   collect(depId,d.type||'Required',seen);
  }
 }
 for(const w of unique){if(w.localizedResources.some(r=>r.language==='en-us'&&/out of support|deprecated/i.test(r.title))){excluded.push({id:w.id,reason:'Поддержка этой нагрузки прекращена Microsoft. Не добавляется в установку.'});continue}if(!supports(w)){excluded.push({id:w.id,reason:`Нагрузка не предлагается в ${edition}`});continue}const name=w.localizedResources.find(r=>r.language==='ru-ru')?.title||w.localizedResources.find(r=>r.language==='en-us')?.title||w.id;selectedWorkloads.push({id:w.id,name});collect(w.id)}
 const e={id:edition,productId,workloads:selectedWorkloads,components:[...components.values()],excluded:[...new Map(excluded.map(e=>[e.id+e.reason,e])).values()],diskMb:null};out.editions.push(e);
 fs.mkdirSync('catalog/vsconfig',{recursive:true});fs.writeFileSync(`catalog/vsconfig/${edition}.vsconfig`,JSON.stringify({version:'1.0',components:e.components.map(c=>c.id)},null,2)+'\n');
}
fs.writeFileSync('catalog/vs-profiles.json',JSON.stringify(out,null,2)+'\n');
console.log(out.version,out.editions.map(e=>`${e.id}: ${e.workloads.length} workloads, ${e.components.length} components, ${e.excluded.length} exclusions`));
