import { createServer } from 'node:http';
import next from 'next';
const database=new URL(process.env.PGDATABASE_URL??'');
if(!['127.0.0.1','localhost','[::1]'].includes(database.hostname)||!/^\/guardllm_integration_v2_[a-z0-9_]+$/u.test(database.pathname))throw new Error('ISOLATED_CONSOLE_DATABASE_REQUIRED');
const port=Number(process.env.PORT);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('ISOLATED_PORT_REQUIRED');
const app=next({dev:true,hostname:'127.0.0.1',port,turbo:false});
app.prepare().then(()=>createServer(app.getRequestHandler()).listen(port,'127.0.0.1',()=>console.log('ISOLATED_CONSOLE_READY')))
  .catch(()=>{console.error('ISOLATED_CONSOLE_START_FAILED');process.exitCode=1;});
