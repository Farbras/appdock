import { invoke, isTauri } from '@tauri-apps/api/core';
import { defaultSelection, extensions, getApp, isWeb } from './catalog';
import { readStorage, writeStorage } from './storage';
import type { InstalledApp, Plan, QueueState, QueueTask, Selection, Settings, SystemInfo } from './types';
export const native = isTauri();
export const emptyQueue:QueueState={tasks:[],running:false,paused:false,mode:'demo',updatedAt:0};
const demoSystem:SystemInfo={windows:true,arch:'x64',winget:null,freeDiskMb:null,virtualization:null,wsl:'Не проверено в деморежиме',hyperV:'Не проверено в деморежиме',admin:false,os:'Windows 11 · демонстрация'};
let demoQueue=readStorage<QueueState>('demo-queue',emptyQueue);
let demoToken=''; let demoItems:Selection[]=[];let timer:ReturnType<typeof setTimeout>|null=null;
const terminal=(s:string)=>['installed','current','error','cancelled','action-required','reboot-required','downloaded','opened','shortcut-created'].includes(s);
if(demoQueue.running){demoQueue={...demoQueue,running:false,paused:demoQueue.tasks.some(t=>!terminal(t.status)),tasks:demoQueue.tasks.map(t=>terminal(t.status)?t:{...t,status:'queued',message:'Демонстрация прервана. Можно продолжить.'})};}
const persist=()=>{demoQueue={...demoQueue,updatedAt:Date.now()};writeStorage('demo-queue',demoQueue)};
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function runDemo(){
 if(timer)return;
 timer=setTimeout(async()=>{
   timer=null;
   if(!demoQueue.running||demoQueue.paused)return;
   const task=demoQueue.tasks.find(t=>t.status==='queued');
   if(!task){demoQueue.running=false;persist();return}
   const parent=task.parentId&&demoQueue.tasks.find(t=>t.id===task.parentId);
   if(parent&&!['installed','current'].includes(parent.status)){task.status='action-required';task.message='Сначала завершите установку редактора';persist();runDemo();return}
   task.startedAt=Date.now();
   for(const stage of ['checking','downloading','installing'] as const){
    if(task.status==='cancelled')break;
    task.status=stage;task.message='Демонстрация этапа. Системные операции не выполняются.';task.percent=null;task.log.push(`[ДЕМО] ${stage}`);persist();await wait(550);
   }
   if(task.status!=='cancelled'){
    const a=getApp(task.appId);
    task.status=task.action==='extension'?'installed':task.action==='download'?'downloaded':task.action==='open'?'opened':task.action==='shortcut'?'shortcut-created':task.action==='guide'||a.install.method==='manual'?'action-required':a.platforms.includes('windows')?'installed':'action-required';
    task.message=task.status==='action-required'?'Демо: потребуется действие на официальном сайте.':'Демонстрация завершена. Компьютер не изменён.';task.finishedAt=Date.now();persist();
   }
   runDemo();
 },150);
}
export const api={
 async system(mode:'demo'|'live'):Promise<SystemInfo>{return mode==='live'&&native?invoke('system_info'):demoSystem},
 async scan(mode:'demo'|'live'):Promise<InstalledApp[]>{return mode==='live'&&native?invoke('scan_installed'):[]},
 async queue(mode:'demo'|'live'):Promise<QueueState>{return mode==='live'&&native?invoke('queue_snapshot'):{...demoQueue,tasks:demoQueue.tasks.map(t=>({...t}))}},
 async plan(items:Selection[],settings:Settings):Promise<Plan>{
  if(settings.mode==='live'&&native)return invoke('prepare_plan',{items,skipCurrent:settings.skipCurrent,parallelDownloads:settings.parallelDownloads});
  demoToken=crypto.randomUUID();demoItems=structuredClone(items);
  return {token:demoToken,mode:'demo',system:demoSystem,warnings:['Демонстрационный режим: загрузка, установка и создание ярлыков только имитируются.'],items:items.map(s=>{const a=getApp(s.appId);return {appId:s.appId,name:a.name,action:s.action,blocked:false,warnings:[!a.platforms.includes('windows')?'Недоступно для Windows':a.install.method==='manual'?'Потребуется официальный установщик и участие пользователя':''].filter(Boolean)}})};
 },
 async start(token:string,mode:'demo'|'live'){
  if(mode==='live'&&native)return invoke<void>('start_plan',{token});
  if(token!==demoToken)throw new Error('План устарел. Выполните проверку ещё раз.');
  if(demoQueue.running)throw new Error('Дождитесь завершения текущей очереди');
  const tasks:QueueTask[]=[];
  for(const s of demoItems){const a=getApp(s.appId);const id=crypto.randomUUID();tasks.push({id,appId:a.id,name:a.name,action:s.action,status:'queued',message:'Демонстрация',log:[],percent:null,selection:s});
   if(a.id==='vscode'&&s.action==='install')for(const ext of extensions.filter(e=>s.extensions.includes(e.id))){tasks.push({id:crypto.randomUUID(),appId:a.id,name:ext.name,action:'extension',status:'queued',message:'После установки VS Code',log:[],percent:null,parentId:id,selection:{...s,extensions:[ext.id]}})}
  }
  demoQueue={tasks:[...demoQueue.tasks.filter(t=>terminal(t.status)),...tasks],running:true,paused:false,mode:'demo',updatedAt:Date.now()};demoToken='';persist();runDemo();
 },
 async control(action:string,mode:'demo'|'live',taskId?:string){
  if(mode==='live'&&native)return invoke<void>('queue_control',{action,taskId:taskId??null});
  if(action==='pause'){demoQueue.paused=true}
  if(action==='resume'){demoQueue.paused=false;demoQueue.running=true;runDemo()}
  if(action==='cancel'){for(const t of demoQueue.tasks.filter(t=>t.status==='queued'&&(!taskId||taskId===t.id))){t.status='cancelled';t.message='Отменено пользователем'}}
  if(action==='retry'){for(const t of demoQueue.tasks.filter(t=>['error','action-required','cancelled'].includes(t.status)&&(!taskId||taskId===t.id))){t.status='queued';t.log.push('[ДЕМО] Повторная проверка');t.finishedAt=null}demoQueue.running=true;demoQueue.paused=false;runDemo()}
  if(action==='clear'&&!demoQueue.running)demoQueue.tasks=[];
  persist();
 },
 async source(appId:string,index=0){if(native)return invoke<void>('open_source',{appId,index});const a=getApp(appId);window.open(a.sources[index]||a.website,'_blank','noopener,noreferrer')},
 async openDownloads(){if(native)return invoke<void>('open_downloads');throw new Error('Папка загрузок доступна в настольном приложении')},
 async port(port:number):Promise<boolean>{if(native)return invoke('check_port',{port});throw new Error('Проверка порта доступна в настольном приложении')},
};
export function normalizePresetItems(items:Selection[]):Selection[]{return items.map(s=>({...defaultSelection(getApp(s.appId)),...s,action:isWeb(getApp(s.appId))?'open':getApp(s.appId).install.method==='manual'?'guide':s.action,options:{...defaultSelection(getApp(s.appId)).options,...s.options}}))}
