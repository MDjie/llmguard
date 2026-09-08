import { readFileSync } from 'node:fs';
import { describe,expect,it } from 'vitest';
import yaml from 'js-yaml';
const load=path=>yaml.load(readFileSync(new URL('../../'+path,import.meta.url),'utf8'));
describe('three-center deployment safety',()=>{
  it('uses independent center identities and leaves standby application writers disabled',()=>{
    const topology=JSON.parse(readFileSync(new URL('../../deploy/ha/two-region-three-center/topology.json',import.meta.url),'utf8'));
    expect(new Set(topology.centers.map(center=>center.region)).size).toBe(2);
    expect(new Set(topology.centers.map(center=>center.context)).size).toBe(3);
    expect(topology.database).toMatchObject({singleWriter:true,fencingRequired:true});
    const defaults=load('deploy/helm/guardllm/values.yaml'),standby=load('deploy/ha/two-region-three-center/center-c.yaml');
    for(const [name,workload] of Object.entries(defaults.workloads))if(workload.enabled&&name!=='analyzer')expect(standby.workloads[name]?.enabled,name).toBe(false);
    expect(standby.deploymentTopology.zoneMinDomains).toBe(3);
  });
  it('requests actual device-plugin resources for each heterogeneous pool',()=>{
    for(const [file,resource] of [['values-nvidia-example.yaml','nvidia.com/gpu'],['values-ascend-example.yaml','huawei.com/Ascend910']]){
      const workload=load('deploy/helm/guardllm/'+file).workloads.analyzer;
      expect(workload.resources.requests[resource]).toBe('1');expect(workload.resources.limits[resource]).toBe('1');expect(workload.runtimeClassName).toBeTruthy();
    }
  });
});
