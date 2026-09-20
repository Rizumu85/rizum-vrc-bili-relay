/** Quantitative coordinator workloads, not a functional assertion suite.
 * Uses production modules with explicitly simulated latency/faults. No accounts,
 * native window, real streaming or disk credentials are used by these workloads.
 */
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PlaybackFlow, PlaybackFailure, PlaybackSuperseded, type PlaybackBackend } from "../src/relay/playback-flow";
import { LibraryCache } from "../src/relay/library-cache";
import { CoverLoader } from "../src/relay/cover-loader";
import { SettingsPersistence, flushSettingsBeforeClose } from "../src/relay/settings-persistence";
import { SettingsDraftState } from "../src/relay/settings-draft";
import { RelayWorkerError, WorkerRpc } from "../src/relay/worker-rpc";
import { RELAY_PROTOCOL_VERSION, type PlaybackOptions, type RelayStatus, type SourceResolution, type ProductSettings } from "../src/relay/protocol";
import { RelayWorkerClient } from "../src/relay/worker-client";
import { DEFAULT_SETTINGS } from "../src/settings";
import { recordUiState, flushWorkerDiagnostics, workerDiagnosticsDirectory } from "../src/relay/worker-diagnostics";

const options: PlaybackOptions = { danmaku: DEFAULT_SETTINGS.danmaku, playback_rate: "1", output_resolution: "p720" };
const traces: Record<string, number> = {};
function trace(event: string, fields: Record<string, number> = {}) { traces[event] = (traces[event] ?? 0) + 1; recordUiState(event, fields); }
function deferred<T = void>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; }
function resolution(id: string): SourceResolution { return { kind:"video", source_id:id, canonical_url:"local-synthetic", title:"synthetic", session_id:id,
  routing:{kind:"relay_with_ffmpeg",reason:"requires_headers",has_separate_audio:false} }; }
class LatencyBackend implements PlaybackBackend {
  generation=1; live=true; next=0; readyCalls=0; statusReads=0; staleCalls=0; maxActive=0;
  sessions=new Map<string,RelayStatus>();
  listeners=new Set<(g:number,e:RelayWorkerError)=>void>();
  startEntered: ReturnType<typeof deferred> | null=null;
  startGate: ReturnType<typeof deferred> | null=null;
  fault: "command"|"transport"|"query"|null=null;
  failStopOnce=false;
  failResolve=false;
  ready() {this.readyCalls++;if(!this.live){this.generation++;this.live=true;}return Promise.resolve(this.generation);}
  isGenerationCurrent(g:number){return this.live&&g===this.generation;}
  onGenerationEnded(fn:(g:number,e:RelayWorkerError)=>void){this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
  check(g?:number){if(g!==undefined&&!this.isGenerationCurrent(g)){this.staleCalls++;throw new RelayWorkerError("worker_exited","synthetic generation ended");}}
  invalidateGeneration(g:number){if(this.generation===g)this.end();}
  end(){this.live=false;this.sessions.clear();for(const fn of this.listeners)fn(this.generation,new RelayWorkerError("worker_timeout","synthetic timeout"));}
  async resolveSource(_source:string,_part?:number,g?:number){this.check(g);if(this.failResolve)throw new RelayWorkerError("invalid_source","synthetic invalid source");return resolution(`${this.generation}-${++this.next}`);}
  async startRelay(id:string,_o:PlaybackOptions,_s=0,paused=false,g?:number){
    this.check(g);this.startEntered?.resolve(undefined);if(this.startGate)await this.startGate.promise;this.check(g);
    this.sessions.clear();const status:RelayStatus={session_id:id,stage:"running",paused};this.sessions.set(id,status);this.maxActive=Math.max(this.maxActive,this.sessions.size);return status;
  }
  async retargetRelay(_id:string|undefined,source:string,_part:number,o:PlaybackOptions,s:number,paused=false,g?:number){
    this.check(g);this.failure();const r=await this.resolveSource(source,1,g);return{resolution:r,relay:await this.startRelay(r.session_id!,o,s,paused,g)};
  }
  async relayStatus(id:string,g?:number){this.check(g);this.statusReads++;if(this.fault==="query")throw new RelayWorkerError("worker_busy","synthetic unsent read");
    const s=this.sessions.get(id);if(!s)throw new RelayWorkerError("media_session_not_found","synthetic missing");return{...s};}
  async stopRelay(id:string,g?:number){this.check(g);if(this.failStopOnce){this.failStopOnce=false;throw new RelayWorkerError("worker_busy","synthetic unsent stop");}
    this.sessions.delete(id);return{session_id:id,stage:"stopped" as const,paused:false};}
  async setRelayPaused(id:string,paused:boolean,_o:PlaybackOptions,_s:number,g?:number){this.check(g);this.failure();const s=await this.relayStatus(id,g);s.paused=paused;this.sessions.set(id,s);return s;}
  async setRelayRate(id:string,_o:PlaybackOptions,g?:number){this.check(g);this.failure();return this.relayStatus(id,g);}
  private failure(){if(this.fault==="transport"){this.end();throw new RelayWorkerError("worker_timeout","synthetic transport");}
    if(this.fault==="command"||this.fault==="query")throw new RelayWorkerError("arbitrary_core_error","synthetic command");}
}
async function seededFlow(backend:LatencyBackend){const invalidations:unknown[]=[];const flow=new PlaybackFlow(backend,(error)=>invalidations.push(error),trace);
  const intent=flow.begin("convert");await flow.run(intent,async task=>{const r=await task.resolve("fixture");await task.start(r.session_id!,options);});return{flow,invalidations};}

async function ownership(iterations:number){const at=performance.now();let residual=0,wrongOwner=0,superseded=0,staleCalls=0;
  for(let i=0;i<iterations;i++){
    const b=new LatencyBackend();const flow=new PlaybackFlow(b,()=>{},trace);
    b.startGate=deferred();b.startEntered=deferred();
    const a=flow.begin("convert");const first=flow.run(a,async task=>{const r=await task.resolve("a");return task.start(r.session_id!,options);}).catch(e=>{if(e instanceof PlaybackSuperseded)superseded++;});
    await b.startEntered.promise;const second=flow.begin("convert");
    const replacement=flow.run(second,async task=>{await task.stop();const r=await task.resolve("b");return task.start(r.session_id!,options);});
    const gate=b.startGate;b.startGate=null;gate.resolve(undefined);await first;const result=await replacement;
    if(flow.status?.session_id!==result.session_id)wrongOwner++;
    residual+=Math.max(0,b.sessions.size-1);staleCalls+=b.staleCalls;
    await flow.run(flow.begin("stop"),t=>t.stop());residual+=b.sessions.size;flow.dispose();
  }
  return {iterations,wall_ms:performance.now()-at,residual_sessions:residual,wrong_owner:wrongOwner,superseded,stale_generation_calls:staleCalls};
}
async function failures(){const rows=[];
  for(const fault of ["command","query","transport"] as const){const b=new LatencyBackend();const{flow,invalidations}=await seededFlow(b);b.fault=fault;
    const before=b.readyCalls;let confirmed:RelayStatus|null=null;let errorKind="none";
    try{await flow.run(flow.begin("rate"),t=>t.rate(flow.status!.session_id,options));}
    catch(e){errorKind=e instanceof Error ? e.constructor.name : "unknown";if(e instanceof PlaybackFailure)confirmed=e.confirmedStatus;}
    rows.push({fault,confirmed_active:confirmed?.stage==="running",status_reads:b.statusReads,ready_calls:b.readyCalls-before,generation:b.generation,
      invalidations:invalidations.length,active_sessions:b.sessions.size,owned:flow.status!==null,error_kind:errorKind});flow.dispose();
  }return rows;
}
async function cacheWorkload(){const cache=new LibraryCache(trace);let oldRejected=0,bCalls=0;
  cache.setScope("simulated-a");const old=deferred<string>();const a=cache.fill("folders",()=>old.promise).catch(()=>{oldRejected++;});await Promise.resolve();
  cache.setScope(null,true);cache.setScope("simulated-b");const next=deferred<string>();
  const b=cache.fill("folders",()=>{bCalls++;return next.promise;});await Promise.resolve();old.resolve("a");await a;
  const b2=cache.fill("folders",()=>{bCalls++;return Promise.resolve("unexpected");});next.resolve("b");await Promise.all([b,b2]);
  const crossAccountValue=cache.read<string>("folders")?.value!=="b";
  const at=performance.now();for(let i=0;i<1000;i++)await cache.fill(`page:${i}`,async()=>i);
  const elapsed=performance.now()-at;
  cache.setScope(null,true);
  return{old_results_rejected:oldRejected,new_account_fetches:bCalls,cross_account_value:Number(crossAccountValue),fill_calls:1000,fill_wall_ms:elapsed,revoked_size:cache.size};
}
async function coverWorkload(){const attempts=new Map<string,number>();const received=new Set<string>();let calls=0;let firstSuccessCall=0;
  const loader=new CoverLoader(async urls=>{calls++;await Bun.sleep(1);return urls.flatMap(url=>{const n=(attempts.get(url)??0)+1;attempts.set(url,n);
    return Number(url)<8?[]:[{url,path:"synthetic-local-file"}];});},covers=>{if(!firstSuccessCall)firstSuccessCall=calls;for(const c of covers)received.add(c.url);},trace,5);
  const at=performance.now();loader.setUrls(Array.from({length:64},(_,i)=>String(i)));
  while((loader.counts.done+loader.counts.exhausted<64||loader.counts.in_flight)&&performance.now()-at<2000)await Bun.sleep(2);
  const result={wall_ms:performance.now()-at,calls,first_success_call:firstSuccessCall,received:received.size,max_attempts:Math.max(...attempts.values()),...loader.counts};loader.dispose();return result;
}
async function settingsWorkload(){let disk:ProductSettings=structuredClone(DEFAULT_SETTINGS);const writes:number[]=[];const errors:unknown[]=[];
  const store=new SettingsPersistence(async()=>disk,async update=>{await Bun.sleep(1);disk={...disk,...update};writes.push(Number(update.playbackRate??0));return disk;},()=>{},e=>errors.push(e),trace);
  const at=performance.now();for(let i=0;i<1000;i++)store.schedule({playbackRate:i%2?"2":"1"},`edit:${i}`,60_000);
  await flushSettingsBeforeClose(store);const coalesced=writes.length;const finalRate=disk.playbackRate;
  // A failed earlier dispatch must not resurrect its snapshot after a newer
  // dispatched preference has already been committed.
  const gate=deferred<ProductSettings>();let calls=0;
  const ordering=new SettingsPersistence(async()=>disk,async u=>{if(++calls===1)return gate.promise;disk={...disk,...u};return disk;},()=>{},()=>{},trace);
  ordering.schedule({playbackRate:"1"},"old",0);await Bun.sleep(2);ordering.schedule({playbackRate:"2"},"new",60_000);
  const flushing=ordering.flush().then(()=>true,()=>false);gate.reject(new Error("synthetic write error"));const flushOk=await flushing;
  const draft=new SettingsDraftState(DEFAULT_SETTINGS);draft.edit("host","first-host");draft.edit("key","first-secret");const snapshot=draft.snapshot();
  draft.edit("host","newer-host");draft.edit("key","newer-secret");draft.edit("theme","dark");
  const cleared=draft.acknowledge(snapshot,{...DEFAULT_SETTINGS,host:"first-host",streamKeyStatus:"available"});
  const state=draft.value;
  return{wall_ms:performance.now()-at,automatic_edits:1000,coalesced_writes:coalesced,final_rate:finalRate,errors:errors.length,
    newer_dispatch_flush_completed:flushOk,newer_dispatch_rate:disk.playbackRate,
    newer_host_preserved:state.host==="newer-host",newer_secret_preserved:state.key==="newer-secret",newer_theme_preserved:state.theme==="dark",secret_wrongly_cleared:cleared,draft_dirty:draft.dirty};
}
async function rpcDeadline(){let fatal=0;const rpc=new WorkerRpc(async()=>{},()=>fatal++,entry=>trace(entry.event));const at=performance.now();let error="none";
  try{await rpc.request({type:"inspect_source",source:"synthetic"},5);}catch(e){error=e instanceof RelayWorkerError?e.code:"unknown";}
  return{wall_ms:performance.now()-at,fatal_notifications:fatal,error,protocol:RELAY_PROTOCOL_VERSION};}
async function cancelledAndFailedReplacement() {
  const rows=[];
  for (const mode of ["cancel", "replacement_fails", "cleanup_fails"] as const) {
    let residual=0, erroneousRecovery=0, invalidations=0;
    const at=performance.now();
    for(let i=0;i<100;i++) {
      const b=new LatencyBackend();
      const flow=new PlaybackFlow(b,()=>{invalidations++;},trace);
      b.startGate=deferred(); b.startEntered=deferred();
      const first=flow.run(flow.begin("convert"),async task=>{const r=await task.resolve("first");return task.start(r.session_id!,options);}).catch(()=>undefined);
      await b.startEntered.promise;
      let replacement:Promise<unknown>=Promise.resolve();
      if(mode==="replacement_fails") {
        b.failResolve=true;
        replacement=flow.run(flow.begin("convert"),async task=>{await task.stop();return task.resolve("bad");})
          .catch(e=>{if(e instanceof PlaybackFailure&&e.confirmedStatus?.stage==="running")erroneousRecovery++;});
      } else {flow.cancel(); if(mode==="cleanup_fails")b.failStopOnce=true;}
      const gate=b.startGate;b.startGate=null;gate.resolve(undefined);
      await first;await replacement;residual+=b.sessions.size;flow.dispose();
    }
    rows.push({mode,iterations:100,wall_ms:performance.now()-at,residual_sessions:residual,erroneous_recovery:erroneousRecovery,invalidations});
  }
  return rows;
}
async function closeDeadline() {
  const gate=deferred<ProductSettings>();let commits=0;
  const store=new SettingsPersistence(async()=>DEFAULT_SETTINGS,()=>gate.promise,()=>commits++,()=>{},trace);
  store.schedule({playbackRate:"2"},"last-edit",60_000);
  const at=performance.now();let closeCancelled=false;
  try{await flushSettingsBeforeClose(store,5);}catch{closeCancelled=true;}
  const pendingWall=performance.now()-at;
  gate.resolve({...DEFAULT_SETTINGS,playbackRate:"2"});await store.flush();
  return{close_cancelled_while_pending:closeCancelled,deadline_wall_ms:pendingWall,commits_after_completion:commits};
}
async function processLifecycle() {
  const executable=process.env.VRC_BILI_RELAY_WORKER;
  if(!executable||!existsSync(executable))return{skipped:true,reason:"No real worker selected; coordinator simulations above still ran"};
  const worker=new RelayWorkerClient();let ended=0;worker.onGenerationEnded(()=>ended++);
  let first=0,next=0,oldQuery="not_attempted";
  const at=performance.now();
  try {
    first=await worker.ready();worker.invalidateGeneration(first);
    const deadline=performance.now()+3000;
    while(performance.now()<deadline){
      try {next=await worker.ready();break;} catch {await Bun.sleep(10);}
    }
    try{await worker.relayStatus("synthetic-old-session",first);}catch(e){oldQuery=e instanceof RelayWorkerError?e.code:"unknown";}
    return{skipped:false,first_generation:first,replacement_generation:next,generation_end_events:ended,old_generation_request:oldQuery,wall_ms:performance.now()-at};
  } finally {await worker.close();}
}
const report={schema:1,revision:process.env.GITHUB_SHA??"local",platform:process.platform,bun:Bun.version,
  scope:"Production UI coordinator modules, synthetic backend latency/faults; not native-window or live-service acceptance",
  ownership:await ownership(200),cancelled:await cancelledAndFailedReplacement(),failures:await failures(),cache:await cacheWorkload(),covers:await coverWorkload(),settings:await settingsWorkload(),close:await closeDeadline(),process:await processLifecycle(),rpc:await rpcDeadline(),traces};
await flushWorkerDiagnostics();
const diagnosticEvents = ["worker-rpc.previous.jsonl", "worker-rpc.jsonl"].flatMap(name => {
  try {return readFileSync(join(workerDiagnosticsDirectory,name),"utf8").trim().split("\n").filter(Boolean).map(line=>JSON.parse(line));} catch {return [];}
});
const diagnostics = {records:diagnosticEvents.length,max_reported_drops:Math.max(0,...diagnosticEvents.map(e=>Number(e.dropped_records)||0))};
const directory=join(import.meta.dir,"../artifacts/benchmarks");mkdirSync(directory,{recursive:true});writeFileSync(join(directory,"ui-state.json"),JSON.stringify({...report,diagnostics},null,2));console.log(JSON.stringify({...report,diagnostics},null,2));
