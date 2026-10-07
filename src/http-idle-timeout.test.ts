import { expect,test } from 'bun:test';
import { loadConfig } from './config';

test('owning HTTP idle timeout keeps a slow handler connected beyond Bun default 10 seconds',async()=>{
 const config=loadConfig(new URL('../config/api2business.example.yaml',import.meta.url).pathname);
 expect(config.runtime.httpIdleTimeoutSeconds).toBeGreaterThan(10);
 const handler=async()=>{await Bun.sleep(21000);return new Response('completed');};
 const normal=Bun.serve({development:false,hostname:'127.0.0.1',port:0,fetch:handler});
 const configured=Bun.serve({development:false,hostname:'127.0.0.1',port:0,idleTimeout:config.runtime.httpIdleTimeoutSeconds,fetch:handler});
 try {
   const outcomes=await Promise.allSettled([fetch(normal.url).then(r=>r.text()),fetch(configured.url).then(r=>r.text())]);
   expect(outcomes[0]?.status).toBe('rejected');
   expect(outcomes[1]).toMatchObject({status:'fulfilled',value:'completed'});
 } finally {normal.stop(true);configured.stop(true);}
},28000);
