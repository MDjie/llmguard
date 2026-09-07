import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findCompatibilityViolations } from './check-compatibility.mjs';

const root=resolve(import.meta.dirname,'..');
const source=JSON.parse(readFileSync(resolve(root,'model/gateway-v2.schema.json'),'utf8'));
const baseline=JSON.parse(readFileSync(resolve(root,'baseline/gateway-v2.compatibility.json'),'utf8'));
const violations=findCompatibilityViolations(source,baseline);
if(violations.length){console.error('Breaking Gateway v2 contract changes:\n- '+violations.join('\n- '));process.exitCode=1;}
else console.log('Gateway v2 matches its accepted compatibility baseline');
