import * as tf from '@tensorflow/tfjs';
import {setWasmPaths} from '@tensorflow/tfjs-backend-wasm';
import {BasicPitch, noteFramesToTime, outputToNotesPoly} from '@spotify/basic-pitch';

/** Use the upstream model and note decoder, but scope tensors per window.
 * Creating padded windows in JS avoids TFJS 3's WASM Fill dtype bug and bounds
 * memory instead of retaining tensors from the entire audio recording.
 */
export async function transcribe(samples, sampleRate, progress=()=>{}) {
  if (sampleRate !== 22050) throw new Error('逐音转录需要 22050 Hz 音轨，请重新选择文件。');
  progress(0, '正在加载逐音识别模型');
  setWasmPaths(new URL('./vendor/wasm/', self.location.href).href);
  tf.env().set('WASM_HAS_MULTITHREAD_SUPPORT', false);
  if (!await tf.setBackend('wasm')) throw new Error('浏览器无法运行音符识别，请使用新版 Chrome 或 Edge。');
  await tf.ready();
  const model=await tf.loadGraphModel(new URL('./vendor/model/model.json', self.location.href).href);
  const basic=new BasicPitch(model), frames=[], onsets=[];
  const inputLength=43844, hop=36164, pad=3840;
  const windows=Math.ceil((samples.length+pad)/hop);
  try {
    for(let i=0;i<windows;i++) {
      tf.engine().startScope();
      try {
        const window=new Float32Array(inputLength), start=i*hop-pad;
        for(let j=0;j<inputLength;j++) window[j]=samples[start+j]||0;
        const input=tf.tensor(window,[1,inputLength,1],'float32');
        const [f,o]=model.execute(input,['Identity_1','Identity_2']);
        const unwrappedF=basic.unwrapOutput(f), unwrappedO=basic.unwrapOutput(o);
        frames.push(...await unwrappedF.array()); onsets.push(...await unwrappedO.array());
      } finally { tf.engine().endScope(); }
      progress((i+1)/windows,'正在识别实际音符和起音时间');
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    const duration=samples.length/sampleRate;
    const notes=noteFramesToTime(outputToNotesPoly(frames,onsets,.25,.3,5,true,1400,82.4069,false))
      .filter(note=>note.startTimeSeconds>=0 && note.startTimeSeconds<duration && note.durationSeconds>=.06)
      .map((note,id)=>({id:String(id),midi:note.pitchMidi,time:note.startTimeSeconds,
        duration:Math.min(note.durationSeconds,duration-note.startTimeSeconds),amplitude:note.amplitude}))
      .sort((a,b)=>a.time-b.time||a.midi-b.midi);
    if(!notes.length) throw new Error('没有识别到稳定音符。请尝试清晰的独奏音轨，或改用简化编配。');
    return {model:'Spotify Basic Pitch 1.0.1',notes,needs_review:true};
  } finally { model.dispose(); }
}
