import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
let attemptedConnections=0;
const forbidden=():never=>{attemptedConnections++;throw new Error('OFFLINE_EVALUATION_NETWORK_FORBIDDEN');};
globalThis.fetch=async()=>forbidden();
net.Socket.prototype.connect=forbidden;
syncBuiltinESMExports();
export const networkFenceStatus=()=>({mode:'SOCKET_AND_FETCH_DENY',attemptedConnections,externalModelCalls:0});
