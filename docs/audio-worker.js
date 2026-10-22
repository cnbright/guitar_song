'use strict';
importScripts('./engine.js?v=2');
importScripts('./transcription.js?v=2');
self.onmessage=async event=>{
  try{
    const features=StringspaceEngine.analyze(event.data.samples,event.data.sampleRate,(progress,message)=>self.postMessage({type:'progress',progress,message}));
    if(event.data.transcribe){
      self.postMessage({type:'progress',progress:35,message:'正在加载逐音识别模型'});
      importScripts('./vendor/transcriber.js');
      features.transcription=await StringspaceTranscriber.transcribe(event.data.samples,event.data.sampleRate,(value,message)=>self.postMessage({type:'progress',progress:35+Math.round(value*52),message}));
    }
    self.postMessage({type:'complete',features},[features.chroma.buffer,features.rms.buffer]);
  }catch(error){self.postMessage({type:'error',message:error.message||'音频分析失败，请尝试其他片段。'});}
};
