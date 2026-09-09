import { z } from 'zod';
import { csrfHeaders } from '@/lib/auth/csrf-client';
export async function iamFetch<T>(url:string, schema:z.ZodType<T>, init?:RequestInit):Promise<T> {
  const response=await fetch(url,{cache:'no-store',...init,
    headers:{...csrfHeaders(),...(init?.body?{'content-type':'application/json'}:{}),...init?.headers}});
  const value:unknown=await response.json();
  if(!response.ok){
    const error=z.object({detail:z.string().optional(),code:z.string().optional()}).safeParse(value);
    throw new Error(error.success ? [error.data.detail,error.data.code].filter(Boolean).join(' · ') : '请求失败，请重试');
  }
  return schema.parse(value);
}
export const roleLabels:Record<string,string>={SYSTEM_ADMIN:'系统管理员',SECURITY_ADMIN:'安全管理员',AUDIT_ADMIN:'审计管理员',
  BUSINESS_OPERATOR:'业务操作员',APP_DEVELOPER:'应用开发者',READ_ONLY:'只读用户'};
