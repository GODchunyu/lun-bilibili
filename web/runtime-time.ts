export interface ClockAnchor {serverNow:number;receivedAt:number}
export function serverTime(anchor:ClockAnchor,monotonicNow:number){return anchor.serverNow+Math.max(0,monotonicNow-anchor.receivedAt);}
export function duration(ms:number){const n=Math.max(0,Math.floor(ms/1000));const days=Math.floor(n/86400);return (days?days+'天 ':'')+[Math.floor(n%86400/3600),Math.floor(n%3600/60),n%60].map(v=>String(v).padStart(2,'0')).join(':');}
export function until(at:number|null,now:number){return at===null?'等待人工或新的安排':at<=now?'已到时间，正在重新确认':'还需 '+duration(at-now);}
export function beijing(at:number){return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(at)+' 北京时间';}
