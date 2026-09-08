import { describe,it,expect } from 'vitest';
import { currentDetectionCapabilities,inspectDetectionCapabilities,assertPublishableDetectionCapabilities } from '../../src/lib/policy-bundle/detection-capabilities';
import { DEFAULT_DETECTOR_DAG } from '../../src/lib/guard-engine-v2/default-dag';
import type { CompiledPolicyBundle } from '../../src/lib/policy-bundle/types';
const payload:CompiledPolicyBundle={schemaVersion:'1.0',policyId:'test',policyVersion:1,dimensions:[],rules:[],exceptions:[],thresholds:[],detectorDag:DEFAULT_DETECTOR_DAG,detectionCapabilities:currentDetectionCapabilities()};
describe('publication capability contracts',()=>{
  it('keeps runtime compatibility distinct from independent quality qualification',()=>{
    expect(inspectDetectionCapabilities(payload)).toMatchObject({runtimeCompatible:true,qualityQualified:null,mediaRuntimeVerified:false});
  });
  it('identifies a legacy signed package without silently inserting new detectors',()=>{
    const legacy={...payload,detectionCapabilities:undefined,detectorDag:{...DEFAULT_DETECTOR_DAG,nodes:DEFAULT_DETECTOR_DAG.nodes.slice(1,3)}};
    expect(inspectDetectionCapabilities(legacy).runtimeCompatible).toBe(false);
    expect(()=>assertPublishableDetectionCapabilities(legacy)).toThrow('POLICY_DETECTION_CAPABILITY_GATE_FAILED');
    expect(legacy.detectorDag.nodes).toHaveLength(2);
  });
  it('rejects conditional necessary controls and version or budget mismatches',()=>{
    const nodes=DEFAULT_DETECTOR_DAG.nodes.map(node=>node.detectorId==='output-privacy-dlp'?{...node,runCondition:'WHEN_NO_BLOCKING_MATCH' as const}:node);
    expect(inspectDetectionCapabilities({...payload,detectorDag:{...DEFAULT_DETECTOR_DAG,nodes}}).reasons).toContain('ENFORCEMENT_CONTROL_UNSAFE:output-privacy-dlp');
    expect(inspectDetectionCapabilities({...payload,detectorDag:{...DEFAULT_DETECTOR_DAG,maximumCostUnits:1}}).reasons).toContain('REQUIRED_DETECTOR_BUDGET_INSUFFICIENT');
    expect(inspectDetectionCapabilities({...payload,detectionCapabilities:{...currentDetectionCapabilities(),normalizationVersion:'future'}}).reasons).toContain('NORMALIZATION_VERSION_INCOMPATIBLE');
  });
});

it('rejects an advertised detector that cannot be constructed by the runtime',()=>{
  const node={...DEFAULT_DETECTOR_DAG.nodes[0],id:'unknown',detectorId:'unknown-detector'};
  expect(inspectDetectionCapabilities({...payload,detectorDag:{...DEFAULT_DETECTOR_DAG,nodes:[...DEFAULT_DETECTOR_DAG.nodes,node]}}).reasons)
    .toContain('DETECTOR_REGISTRY_UNKNOWN:unknown-detector');
});
