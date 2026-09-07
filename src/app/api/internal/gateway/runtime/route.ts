import { z } from 'zod';
import { signedAuthContextSchema } from '@/contracts/http/gateway-v2';
import { validateActiveContext } from '@/lib/gateway-runtime/authorization';
import { internalGatewayRoute } from '@/lib/gateway-runtime/http';
export const GET = internalGatewayRoute(z.object({}).strict(), async (_body, request) => {
  const encoded = request.headers.get('x-guard-auth-context') ?? '';
  if (encoded.length > 16384) throw new Error('AUTH_CONTEXT_TOO_LARGE');
  const auth = signedAuthContextSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
  const { snapshot } = await validateActiveContext(auth);
  const headers={ETag:'\"'+snapshot.digest+'\"','X-Guard-Generation':String(snapshot.manifest.generation),'Cache-Control':'no-store'};
  if(request.headers.get('if-none-match')===headers.ETag)return new Response(null,{status:304,headers});
  return Response.json(snapshot,{headers});
});
