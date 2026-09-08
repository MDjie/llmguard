const messages: Readonly<Record<string,string>> = {
  AUTHENTICATION_REQUIRED:'登录已失效，请重新登录', FORBIDDEN:'当前角色没有此操作权限', PERMISSION_DENIED:'当前角色没有此操作权限',
  CSRF_VALIDATION_FAILED:'安全令牌失效，请刷新页面后重试', CSRF_TOKEN_INVALID:'安全令牌失效，请刷新页面后重试',
  BODY_VALIDATION_FAILED:'提交内容不符合要求，请检查字段格式和范围', RATE_LIMIT_EXCEEDED:'操作过于频繁，请稍后重试',
};
export function apiErrorMessage(value:unknown,fallback='操作失败'):string {
  if(typeof value!=='object'||value===null)return fallback;
  const row=value as Record<string,unknown>;
  const code=typeof row.code==='string'?row.code:'';
  const issues=Array.isArray(row.errors)?row.errors.flatMap((error:unknown)=>{
    if(typeof error!=='object'||error===null)return [];
    const item=error as Record<string,unknown>;
    return typeof item.message==='string'?[`${String(item.path??item.field??'字段')}：${item.message}`]:[];
  }).slice(0,3).join('；'):'';
  const message=messages[code]??(typeof row.detail==='string'?row.detail:typeof row.error==='string'?row.error:typeof row.title==='string'?row.title:fallback);
  return issues?`${message}（${issues}）`:message;
}
