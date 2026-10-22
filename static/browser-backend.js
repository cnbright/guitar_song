/* Local adapter for the existing UI. IndexedDB stores music on the user's device. */
(function(root){
  'use strict';
  const jobs=new Map(),audioURLs=new Map(),exportURLs=new Map();
  let databasePromise,active=false;
  const engine=root.StringspaceEngine;
  function db(){
    if(!databasePromise)databasePromise=new Promise((resolve,reject)=>{
      if(!root.indexedDB)return reject(new Error('此浏览器不支持本机作品存储，请使用新版 Chrome、Edge 或 Safari。'));
      const request=indexedDB.open('stringspace-browser-v1',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('jobs',{keyPath:'id'});
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(new Error('无法打开浏览器存储。请检查浏览器的隐私或存储设置。'));
    });
    return databasePromise;
  }
  async function persist(job){
    const database=await db();
    await new Promise((resolve,reject)=>{
      const transaction=database.transaction('jobs','readwrite');
      transaction.objectStore('jobs').put(job);
      transaction.oncomplete=resolve;
      transaction.onabort=transaction.onerror=()=>reject(new Error('浏览器存储空间不足或被限制，请删除旧作品后重试。'));
    });
  }
  async function get(id){
    if(jobs.has(id))return jobs.get(id);
    const database=await db();
    const job=await new Promise((resolve,reject)=>{
      const request=database.transaction('jobs').objectStore('jobs').get(id);
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(new Error('读取本机作品失败，请重新选择文件。'));
    });
    if(!job)throw new Error('当前浏览器中没有这份作品，请重新选择音乐文件。');
    if(['queued','processing'].includes(job.status)){
      job.status='failed';job.message='上一次分析因页面关闭而中断，请重新选择音乐文件。';await persist(job);
    }
    jobs.set(id,job);return job;
  }
  function audioURL(id){
    if(audioURLs.has(id))return audioURLs.get(id);
    const job=jobs.get(id);if(!job?.file)return '';
    const url=URL.createObjectURL(job.file);audioURLs.set(id,url);return url;
  }
  function exportURL(score,kind){
    if(exportURLs.has(kind))URL.revokeObjectURL(exportURLs.get(kind));
    const formats={musicxml:()=>[engine.musicxml(score),'application/vnd.recordare.musicxml+xml'],
      midi:()=>[engine.midiBytes(score),'audio/midi'],txt:()=>[engine.textTab(score),'text/plain;charset=utf-8'],
      json:()=>[JSON.stringify(score,null,2),'application/json'],
      report:()=>[JSON.stringify(score.comparison||{status:'unverified'},null,2),'application/json'],
      wav:()=>[root.StringspaceVerification.wav(root.StringspaceVerification.render(score)),'audio/wav']};
    if(!formats[kind])throw new Error('不支持的导出格式。');
    const [data,type]=formats[kind](),url=URL.createObjectURL(new Blob([data],{type}));
    exportURLs.set(kind,url);return url;
  }
  async function verifyScore(job,score){
    if(!job.features.acoustic){score.comparison={status:'unverified'};return score;}
    job.progress=92;job.message='正在把实际合成音与原音逐段对比';
    const worker=new Worker(new URL('./audio-worker.js?v=4',document.baseURI));
    try{
      score.comparison=await new Promise((resolve,reject)=>{
        worker.onmessage=({data})=>{if(data.type==='verified')resolve(data.comparison);else if(data.type==='error')reject(new Error(data.message));};
        worker.onerror=()=>reject(new Error('声学验收未完成，请重新生成。'));
        worker.postMessage({kind:'verify',score,reference:job.features.acoustic});
      });
    }finally{worker.terminate();}
    return score;
  }
  async function analyzeJob(job){
    let context,worker;
    try{
      job.status='processing';job.progress=10;job.message='正在浏览器中解码音轨';
      const Audio=root.AudioContext||root.webkitAudioContext;
      if(!Audio)throw new Error('此浏览器不支持音频解码，请使用新版 Chrome、Edge 或 Safari。');
      context=new Audio({sampleRate:22050});
      let decoded;
      try{decoded=await context.decodeAudioData(await job.file.arrayBuffer());}
      catch{throw new Error('浏览器无法解码这个文件。请尝试 MP3 或 WAV，或将视频音轨转为 M4A。');}
      if(decoded.duration>600.1)throw new Error('请选择 10 分钟以内的片段。');
      if(decoded.duration<2)throw new Error('请选择至少 2 秒的音乐片段。');
      const samples=new Float32Array(decoded.length);
      for(let channel=0;channel<decoded.numberOfChannels;channel++){
        const input=decoded.getChannelData(channel);for(let i=0;i<samples.length;i++)samples[i]+=input[i]/decoded.numberOfChannels;
      }
      const sampleRate=decoded.sampleRate;decoded=null;await context.close();context=null;
      job.features=await new Promise((resolve,reject)=>{
        worker=new Worker(new URL('./audio-worker.js?v=4',document.baseURI));
        worker.onmessage=({data})=>{
          if(data.type==='progress'){job.progress=job.config.pattern==='transcribe' && !data.message.includes('模型') && data.progress<80 && !data.message.includes('实际音符') ? Math.round(data.progress*.3) : data.progress;job.message=data.message;}
          else if(data.type==='complete')resolve(data.features);
          else if(data.type==='error')reject(new Error(data.message));
        };
        worker.onerror=()=>reject(new Error('音频分析线程无法启动，请刷新页面并尝试较短的音频。'));
        worker.postMessage({samples,sampleRate,transcribe:job.config.pattern==='transcribe'},[samples.buffer]);
      });
      job.progress=90;job.message='正在编配指型和六线谱';
      job.score=await verifyScore(job,engine.arrange(job.features,job.config,job.title));
      job.status='completed';job.progress=100;job.message=job.score.comparison.status==='passed'?'达到自动检查门槛，仍需试听校对':'与原音差异超出门槛，仅保留不合格草稿';
      await persist(job);
    }catch(error){
      job.status='failed';job.progress=0;job.message=error.message||'分析遇到问题，请尝试其他文件。';
      try{await persist(job);}catch{/* The original, actionable error remains visible in memory. */}
    }finally{worker?.terminate();if(context)await context.close();active=false;}
  }
  async function api(path,options={}){
    if(path==='/api/chords')return {chords:[...engine.CHORDS,'N']};
    if(path==='/api/health')return {status:'ok',mode:'browser-accompaniment',version:'1.1.0'};
    if(path==='/api/jobs'&&options.method==='POST'){
      if(active)throw new Error('当前还有一段音乐正在分析，请稍候。');
      const file=options.body.get('file'),config=engine.configOptions(JSON.parse(options.body.get('config')||'{}'));
      if(!file?.size)throw new Error('选择的文件是空的。');
      if(file.size>100*1024*1024)throw new Error('文件超过 100 MB，请截取需要练习的片段。');
      const job={id:crypto.randomUUID().replaceAll('-',''),file,config,title:(options.body.get('title')?.trim()||file.name.replace(/\.[^.]+$/,'')).slice(0,120),status:'queued',progress:3,message:'文件已读取，准备分析'};
      await persist(job);jobs.set(job.id,job);active=true;analyzeJob(job);return {id:job.id};
    }
    const match=/^\/api\/jobs\/([a-f0-9]{32})(?:\/(arrange))?$/.exec(path);
    if(!match)throw new Error('无法识别这个本机操作。');
    const job=await get(match[1]);
    if(options.method==='DELETE'){
      if(['queued','processing'].includes(job.status))throw new Error('请等待分析结束后再删除。');
      const database=await db();await new Promise((resolve,reject)=>{
        const transaction=database.transaction('jobs','readwrite');transaction.objectStore('jobs').delete(job.id);
        transaction.oncomplete=resolve;transaction.onerror=()=>reject(new Error('删除失败，请重试。'));
      });
      if(audioURLs.has(job.id)){URL.revokeObjectURL(audioURLs.get(job.id));audioURLs.delete(job.id);}jobs.delete(job.id);return null;
    }
    if(match[2]==='arrange'&&options.method==='POST'){
      if(job.status!=='completed')throw new Error('乐谱尚未生成完成。');
      const config=engine.configOptions(JSON.parse(options.body));
      if(!job.features.acoustic||(config.pattern==='transcribe'&&!job.features.transcription)){
        if(active)throw new Error('还有一段音乐正在分析，请稍候。');
        const updated={...job,config,status:'queued',progress:1,message:'正在重新识别原音'};
        jobs.set(job.id,updated);active=true;await analyzeJob(updated);
        if(updated.status==='failed'){jobs.set(job.id,job);await persist(job);throw new Error(updated.message);}
        return updated.score;
      }
      const score=await verifyScore(job,engine.arrange(job.features,config,job.title));
      const updated={...job,config,score};await persist(updated);jobs.set(job.id,updated);return score;
    }
    return {id:job.id,status:job.status,progress:job.progress,message:job.message,...(job.status==='completed'?{score:job.score}:{})};
  }
  root.StringspaceBrowser={api,audioURL,exportURL};
})(globalThis);
