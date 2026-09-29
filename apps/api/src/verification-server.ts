// T-244 review/annotation process. It deliberately owns no OCR lifecycle or parse jobs.
// Uses the same authentication, permission and security middleware as the platform.
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { buildApp } from "./app.ts";
import { loadHttpsOptions } from "./services/tls.ts";
const db=await openDb();
const app=buildApp(db,{https:loadHttpsOptions(config.tls)});
// Route only the module and its session endpoints here. Existing platform routes stay on their API.
app.addHook("onRequest",async(req,reply)=>{
  const path=req.url.split('?')[0];
  if(path==="/health"||path.startsWith('/api/v1/auth/')||path.startsWith('/api/v1/verification/')||path==='/api/v1/admin/verifiers'||path==='/api/v1/openapi.json')return;
  return reply.code(404).send({error:"Маршрут обслуживается основным API платформы"});
});
let stopping=false;
const close=async()=>{if(stopping)return;stopping=true;await app.close();await db.close();};
process.once('SIGTERM',()=>void close().then(()=>process.exit(0)).catch(()=>process.exit(1)));
process.once('SIGINT',()=>void close().then(()=>process.exit(0)).catch(()=>process.exit(1)));
await app.listen({host:config.host,port:config.port});
console.log(JSON.stringify({component:'verification-api',ready:true,revision:process.env.INSPECTOR_REVISION||'unknown'}));
