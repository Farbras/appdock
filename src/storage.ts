import { z } from 'zod';
import { getApp, extensions, defaultSelection } from './catalog';
import type { Preset, Selection } from './types';
export function readStorage<T>(key:string,fallback:T):T { try{return JSON.parse(localStorage.getItem(`appdock:${key}`)||'null')??fallback}catch{return fallback} }
export function writeStorage(key:string,value:unknown){localStorage.setItem(`appdock:${key}`,JSON.stringify(value))}
const itemSchema=z.object({appId:z.string().max(80),action:z.enum(['install','download','open','shortcut','guide']),options:z.record(z.string(),z.union([z.string().max(500),z.number(),z.boolean()])),extensions:z.array(z.string()).max(30),version:z.string().max(40).optional()});
const presetSchema=z.object({schemaVersion:z.literal(1),name:z.string().min(1).max(80),description:z.string().max(300).default('Импортированный набор'),items:z.array(itemSchema).min(1).max(100)});
export function sanitizeSelection(s:Selection):Selection {
 const app=getApp(s.appId);if(!app)throw new Error(`Неизвестная программа: ${s.appId}`);
 const options={...defaultSelection(app).options};
 for(const [key,value] of Object.entries(s.options)) {
  const option=app.options.find(o=>o.id===key);
  if(option && !/password|secret|token|credential/i.test(key)) {if(typeof value!==typeof option.default)throw new Error(`Неверный тип параметра ${key}`);if(option.values&&!option.values.includes(String(value)))throw new Error(`Недопустимое значение ${key}`);options[key]=value;}
 }
 if(s.options.edition&&app.editions.some(e=>e.id===s.options.edition))options.edition=s.options.edition;
 if(app.id==='visual-studio'&&typeof s.options.fullProfile==='boolean')options.fullProfile=s.options.fullProfile;
 return {...s,options,extensions:app.id==='vscode'?s.extensions.filter(id=>extensions.some(e=>e.id===id)):[]};
}
export function parsePreset(text:string):Preset {
 if(text.length>200_000)throw new Error('Размер набора не должен превышать 200 КБ');
 const p=presetSchema.parse(JSON.parse(text)); const seen=new Set<string>();
 const items=p.items.map(sanitizeSelection);for(const i of items){if(seen.has(i.appId))throw new Error('В наборе есть повторяющиеся программы');seen.add(i.appId)}
 return {id:crypto.randomUUID(),name:p.name,description:p.description,items,icon:'Package',builtin:false};
}
export function serializePreset(p:Preset){return JSON.stringify({schemaVersion:1,name:p.name,description:p.description,items:p.items.map(s=>{const clean=sanitizeSelection(s);const app=getApp(s.appId);return {...clean,version:clean.version||(/^\d/.test(app.version)?app.version:undefined)}})},null,2)}
export function downloadJson(name:string,text:string){const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
