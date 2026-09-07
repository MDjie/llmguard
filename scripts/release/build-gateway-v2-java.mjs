import { existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const cache = path.join(root, '.artifact-build/upgrade-implementation-20260907/maven-repository');
const seed = path.join(process.env.USERPROFILE ?? '', '.m2/repository');
if (!existsSync(seed)) throw new Error('POPULATED_MAVEN_SEED_REQUIRED');
mkdirSync(cache, { recursive: true });
const online = process.argv.includes('--online');
const args = ['run','--rm','--pull=never', ...(online ? [] : ['--network','none']),
  '-v',`${root}:/workspace`, '-v',`${cache}:/root/.m2/repository`, '-v',`${seed}:/seed:ro`,
  '-w','/workspace/services/guard-gateway','maven:3.9.12-eclipse-temurin-21',
  'sh','-c','cp -an /seed/. /root/.m2/repository/ && mvn '+(online?'':'-o ')+'-B -ntp verify && javac -d target/probe probe/GatewayReadinessProbe.java'];
const child = spawn('docker', args, { stdio:'inherit', windowsHide:true });
child.on('exit', code => { process.exitCode=code??1; });
