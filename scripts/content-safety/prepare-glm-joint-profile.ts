import { GLM_JOINT_MODEL, jointEvidenceProfileSchema } from '../../src/lib/multimodal/joint-evidence-judge';
import { judgeProfileSchema } from '../../src/lib/judge/profile';
import { options,required,jsonFile,writeArtifact,fail } from './optimization-cli';

async function main(){
 const args=options(['profile','model','out']);
 if(args.help){console.log('prepare-glm-joint-profile --profile <existing-scoped-profile.json> --out <new.json> [--model glm-5.3-flash]. Preserves endpoint and secret reference, clears old quality approvals, writes a disabled SHADOW draft.');return;}
 const previous=judgeProfileSchema.parse(await jsonFile(required(args.profile,'profile')));
 const draft={...previous,revision:previous.revision+1,displayName:(args.model??GLM_JOINT_MODEL)+' joint evidence',enabled:false,mode:'SHADOW',
  modelId:args.model??GLM_JOINT_MODEL,modelRevision:null,weightsSha256:null,mutableAlias:true,backendKind:'chat_judge',
  role:'base',contextScope:'full',fallbackProfileIds:[],maxAttempts:1,maxInputChars:100000,maxOutputTokens:4096,
  thinkingMode:'enabled',reasoningEffort:'low',perAttemptTimeoutMs:15000,totalTimeoutMs:15000};
 const {qualityEvidenceId:_evidence,qualityValidUntil:_until,windowing:_window,...unqualified}=draft;
 void _evidence;void _until;void _window;
 const result=jointEvidenceProfileSchema.parse(unqualified);
 await writeArtifact(required(args.out,'out'),result);
 console.log('Disabled joint-evidence SHADOW profile created; previous model qualifications removed. No model call or publication.');
}
main().catch(error=>fail(error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error:new Error('GLM_JOINT_PROFILE_PREPARATION_FAILED')));
