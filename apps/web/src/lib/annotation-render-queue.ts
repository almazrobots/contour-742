// Two background renders at most; current evidence never waits for this queue.
let active=0;
const waiting:Array<()=>void>=[];
export async function backgroundRenderSlot():Promise<()=>void>{
  if(active>=2)await new Promise<void>(resolve=>waiting.push(resolve));else active++;
  let released=false;
  return ()=>{if(released)return;released=true;const next=waiting.shift();if(next)next();else active--;};
}
