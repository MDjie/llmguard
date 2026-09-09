'use client';
import { useCallback, useEffect, useState } from 'react';
import type { Permission } from '@/lib/api-security/types';
export function useAccessProfile() {
  const [permissions,setPermissions]=useState<readonly string[]>([]);
  const [deploymentMode,setDeploymentMode]=useState<'strict'|'implementation'>('strict');
  useEffect(()=>{
    const controller=new AbortController();
    void fetch('/api/auth/me',{signal:controller.signal,cache:'no-store'}).then(async response=>{
      if(!response.ok)return;
      const value:unknown=await response.json();
      if(typeof value==='object'&&value!==null&&'user' in value&&typeof value.user==='object'&&value.user!==null&&'permissions' in value.user&&Array.isArray(value.user.permissions)) {
        setPermissions(value.user.permissions.filter((item:unknown):item is string=>typeof item==='string'));
        setDeploymentMode('deploymentMode' in value.user&&value.user.deploymentMode==='implementation'?'implementation':'strict');
      }
    }).catch(()=>undefined);
    return ()=>controller.abort();
  },[]);
  const can=useCallback((permission:Permission)=>permissions.includes(permission),[permissions]);
  return {can,deploymentMode};
}
export function usePermissions() { return useAccessProfile().can; }
