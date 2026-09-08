import { spawnSync } from 'node:child_process';
export function processIdentity(pid) {
 if (!Number.isSafeInteger(pid)||pid<1) throw new Error('INVALID_PID');
 if (process.platform!=='win32') throw new Error('WINDOWS_RUNNER_REQUIRED');
 const r=spawnSync('powershell.exe',['-NoProfile','-Command',`$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if($p){[pscustomobject]@{pid=$p.ProcessId;created=$p.CreationDate.ToUniversalTime().ToString('o');executable=$p.ExecutablePath;commandLine=$p.CommandLine}|ConvertTo-Json -Compress}`],{encoding:'utf8',windowsHide:true});
 if(r.status!==0)throw new Error('PROCESS_IDENTITY_UNAVAILABLE');return r.stdout.trim()?JSON.parse(r.stdout):null;
}
export function stopOwnedProcess(record) {
 const actual=processIdentity(record.pid);if(!actual)return 'ALREADY_STOPPED';
 if(!record.identity||actual.created!==record.identity.created||actual.executable!==record.identity.executable||actual.commandLine!==record.identity.commandLine)throw new Error('PROCESS_IDENTITY_CHANGED_'+record.name);
 const r=spawnSync('powershell.exe',['-NoProfile','-Command',`$p=Get-CimInstance Win32_Process -Filter "ProcessId=${record.pid}"; if($p -and $p.CreationDate.ToUniversalTime().ToString('o') -eq '${actual.created}'){Stop-Process -Id ${record.pid} -Force -ErrorAction Stop}else{exit 2}`],{encoding:'utf8',windowsHide:true});if(r.status!==0)throw new Error('OWNED_PROCESS_STOP_FAILED');return 'STOPPED';
}
