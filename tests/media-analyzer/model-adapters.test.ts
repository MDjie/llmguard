import { describe, expect, it } from 'vitest';
import type { CommandRunner } from '../../services/media-analyzer/src/command-runner';
import {
  classifyAudioAnomalies,
  classifyImage,
  transcribeAudio,planAsrWindows,transcribeAudioWindowed,
} from '../../services/media-analyzer/src/model-adapters';

const runner: CommandRunner = {
  async run(_program, args) {
    if (args.includes('--input') && String(args[args.indexOf('--input') + 1]).endsWith('.wav')) {
      return {
        stdout: JSON.stringify({
          modelVersion: 'audio-v1',
          segments: [{ text: 'hello', startMs: 0, endMs: 100, confidence: 0.9 }],
        }),
        stderr: '',
        exitCode: 0,
      };
    }
    return {
      stdout: JSON.stringify({
        modelVersion: 'visual-v1',
        risks: [{ riskType: 'violence', score: 0.8, reasonCode: 'VISUAL_VIOLENCE' }],
      }),
      stderr: '',
      exitCode: 0,
    };
  },
};

describe('media analyzer model adapters', () => {
  it('requires explicit model commands and validates visual output', async () => {
    process.env.ANALYZER_VISUAL_COMMAND = 'visual-model';
    await expect(classifyImage({
      runner, imagePath: 'input.png', workspace: '.', viewId: 'original',
    })).resolves.toMatchObject({
      modelVersion: 'visual-v1',
      risks: [{ viewId: 'original', riskType: 'violence', score: 0.8 }],
    });
    delete process.env.ANALYZER_VISUAL_COMMAND;
    await expect(classifyImage({
      runner, imagePath: 'input.png', workspace: '.', viewId: 'original',
    })).rejects.toThrow('ANALYZER_VISUAL_COMMAND_REQUIRED');
  });

  it('validates ASR time ranges', async () => {
    process.env.ANALYZER_ASR_COMMAND = 'asr-model';
    await expect(transcribeAudio({
      runner, audioPath: 'audio.wav', workspace: '.',
    })).resolves.toMatchObject({
      modelVersion: 'audio-v1',
      segments: [{ text: 'hello', startMs: 0, endMs: 100 }],
    });
    delete process.env.ANALYZER_ASR_COMMAND;
  });

  it('requires an audio anomaly classifier', async () => {
    delete process.env.ANALYZER_AUDIO_CLASSIFIER_COMMAND;
    await expect(classifyAudioAnomalies({
      runner, audioPath: 'audio.wav', workspace: '.',
    })).rejects.toThrow('ANALYZER_AUDIO_CLASSIFIER_COMMAND_REQUIRED');
  });
});

describe('ASR provider windows',()=>{
 it('covers 30-second boundaries without gaps and bounds each request',()=>{const windows=planAsrWindows(61000);expect(windows).toEqual([{startMs:0,endMs:30000},{startMs:29000,endMs:59000},{startMs:58000,endMs:61000}]);expect(windows.every(window=>window.endMs-window.startMs<=30000)).toBe(true);expect(()=>planAsrWindows(0)).toThrow();});
 it('rejects provider timestamps outside a clip rather than clipping them',async()=>{
  process.env.ANALYZER_ASR_COMMAND='test-adapter';const mock:CommandRunner={async run(_program,args){return {stdout:args.includes('--input')?JSON.stringify({modelVersion:'m',segments:[{text:'x',startMs:0,endMs:31000,confidence:.9}]}):'',stderr:'',exitCode:0};}};
  try{await expect(transcribeAudioWindowed({runner:mock,audioPath:'audio.wav',workspace:'.',durationMs:60000})).rejects.toThrow('TIMELINE_OUT_OF_BOUNDS');}finally{delete process.env.ANALYZER_ASR_COMMAND;}
 });
});
