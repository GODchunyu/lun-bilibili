export type ConnectionState='connecting'|'fresh'|'offline'|'stale'|'incompatible';
export class IncompatibleState extends Error {}
export interface PollOptions<T> {fetch:(signal:AbortSignal)=>Promise<unknown>;parse:(raw:unknown)=>T;data:(value:T,receivedAt:number)=>void;connection:(state:ConnectionState)=>void;now:()=>number;version?:(value:T)=>{instanceId:string;snapshotSeq:number};timeoutMs?:number;intervalMs?:number}
/** One valid request at a time. Timed-out or disposed requests cannot publish late data. */
export function createStatePoller<T>(options:PollOptions<T>){
 let accepted:{instanceId:string;snapshotSeq:number}|undefined;const retired=new Set<string>();
 let pending:Promise<void>|undefined;let controller:AbortController|undefined;let disposed=false;let generation=0;let lastSuccess:number|null=null;let interval:ReturnType<typeof setInterval>|undefined;
 const refresh=():Promise<void>=>{
  if(disposed)return Promise.resolve();if(pending)return pending;
  const owner=++generation;controller=new AbortController();const signal=controller.signal;
  let timeout!:ReturnType<typeof setTimeout>;
  const expired=new Promise<never>((_,reject)=>{timeout=setTimeout(()=>{controller?.abort();reject(new Error('state timeout'));},options.timeoutMs??5000);});
  pending=(async()=>{try{
   const raw=await Promise.race([options.fetch(signal),expired]);if(disposed||owner!==generation)return;
   let value:T;try{value=options.parse(raw);}catch{throw new IncompatibleState();}
   const version=options.version?.(value);if(version&&accepted){if(retired.has(version.instanceId))return;if(version.instanceId===accepted.instanceId&&version.snapshotSeq<=accepted.snapshotSeq)return;if(version.instanceId!==accepted.instanceId)retired.add(accepted.instanceId);}if(version)accepted=version;
   lastSuccess=options.now();options.data(value,lastSuccess);options.connection('fresh');
  }catch(error){if(!disposed&&owner===generation)options.connection(error instanceof IncompatibleState?'incompatible':'offline');}
  finally{clearTimeout(timeout);if(owner===generation)pending=undefined;}})();
  return pending;
 };
 const checkFreshness=()=>{if(!disposed&&lastSuccess!==null&&options.now()-lastSuccess>15000)options.connection('stale');};
 return {refresh,checkFreshness,start(){void refresh();interval=setInterval(()=>{checkFreshness();void refresh();},options.intervalMs??5000);},stop(){disposed=true;generation++;controller?.abort();clearInterval(interval);},resync(){if(lastSuccess!==null)options.connection('stale');return refresh();}};
}
