'use strict';
importScripts('./engine.js');
self.onmessage=event=>{
  try{
    const features=StringspaceEngine.analyze(event.data.samples,event.data.sampleRate,(progress,message)=>self.postMessage({type:'progress',progress,message}));
    self.postMessage({type:'complete',features},[features.chroma.buffer,features.rms.buffer]);
  }catch(error){self.postMessage({type:'error',message:error.message||'音频分析失败，请尝试其他片段。'});}
};
