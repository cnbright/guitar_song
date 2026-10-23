/* Real acoustic guitar recordings, self-hosted; see instruments/credits.html. */
(function(root){
  'use strict';
  const VERSION='iowa-acoustic-v1',RATE=22050;
  const scriptURL=typeof document!=='undefined'?document.currentScript?.src:root.location?.href;
  let bank=null,loading=null;
  function install(bytes){
    const view=new DataView(bytes),magic=new TextDecoder().decode(new Uint8Array(bytes,0,4));
    if(magic!=='SGS1')throw new Error('木吉他音色文件损坏，请刷新重试。');
    const size=view.getUint32(4,true),meta=JSON.parse(new TextDecoder().decode(new Uint8Array(bytes,8,size))),start=8+size;
    if(meta.version!==VERSION||meta.sample_rate!==RATE||!meta.samples.length)throw new Error('木吉他音色版本不匹配，请刷新重试。');
    bank=meta.samples.map(entry=>{
      const audio=new Float32Array(entry.length);
      for(let i=0;i<audio.length;i++)audio[i]=view.getInt16(start+entry.offset+i*2,true)/32767;
      return {midi:entry.midi,audio};
    });
  }
  async function load(){
    if(bank)return;
    if(!loading)loading=(async()=>{
      if(typeof module!=='undefined'&&module.exports){
        const fs=require('node:fs'),path=require('node:path');
        const data=fs.readFileSync(path.join(__dirname,'instruments/acoustic-guitar.bin'));
        install(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength));
      }else{
        const response=await fetch(new URL('./instruments/acoustic-guitar.bin',scriptURL));
        if(!response.ok)throw new Error('木吉他音色加载失败，请检查网络后重试。');
        install(await response.arrayBuffer());
      }
    })().catch(error=>{loading=null;throw error;});
    return loading;
  }
  function pluck(midi,duration,sampleRate=RATE){
    if(!bank)throw new Error('木吉他音色尚未加载，请稍后重试。');
    const source=bank.reduce((best,entry)=>Math.abs(entry.midi-midi)<Math.abs(best.midi-midi)?entry:best);
    const step=2**((midi-source.midi)/12)*RATE/sampleRate;
    const length=Math.min(Math.ceil(Math.max(.01,duration)*sampleRate),Math.floor((source.audio.length-1)/step));
    const out=new Float32Array(length),release=Math.min(length,sampleRate*.045);
    for(let i=0;i<length;i++){
      const cursor=i*step,index=Math.floor(cursor),mix=cursor-index;
      // Keep the recorded pick/body transient; interpolate only to transpose.
      out[i]=(source.audio[index]*(1-mix)+source.audio[index+1]*mix)*Math.min(1,i/(sampleRate*.001))*Math.min(1,(length-1-i)/release);
    }
    return out;
  }
  const api={VERSION,load,pluck,get ready(){return !!bank;}};
  root.StringspaceGuitar=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(globalThis);
