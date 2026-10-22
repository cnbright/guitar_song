'use strict';
importScripts('./engine.js?v=4');
importScripts('./verification.js?v=4');
importScripts('./transcription.js?v=4');
importScripts('./accompaniment.js?v=4');
self.onmessage=async event=>{
  try{
    if(event.data.kind==='verify'){
      const comparison=StringspaceVerification.verify(event.data.score,event.data.reference);
      self.postMessage({type:'verified',comparison});return;
    }
    const features=StringspaceEngine.analyze(event.data.samples,event.data.sampleRate,(progress,message)=>self.postMessage({type:'progress',progress,message}));
    self.postMessage({type:'progress',progress:30,message:'正在提取独立的原音对照特征'});
    features.acoustic=StringspaceVerification.extract(event.data.samples,event.data.sampleRate);
    if(event.data.transcribe){
      self.postMessage({type:'progress',progress:35,message:'正在加载逐音识别模型'});
      importScripts('./vendor/transcriber.js');
      features.transcription=await StringspaceTranscriber.transcribe(event.data.samples,event.data.sampleRate,(value,message)=>self.postMessage({type:'progress',progress:35+Math.round(value*52),message}));
    }
    self.postMessage({type:'complete',features},[features.chroma.buffer,features.rms.buffer,features.acoustic.bands.buffer,features.acoustic.rms.buffer]);
  }catch(error){self.postMessage({type:'error',message:error.message||'音频分析失败，请尝试其他片段。'});}
};
