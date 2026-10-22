/* Browser-only music engine. No network, external models, or audio uploads. */
(function (root) {
  'use strict';
  const PITCHES = ['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B'];
  const OPEN = [40,45,50,55,59,64];
  const MAJOR = ['x32010','x46664','xx0232','x68886','022100','133211','244322','320003','466544','x02220','x13331','x24442'];
  const MINOR = ['x35543','x46654','xx0231','x68876','022000','133111','244222','355333','466444','x02210','x13321','x24432'];
  const CHORDS = [...PITCHES, ...PITCHES.map(p => p+'m')];
  const clamp = (x,lo,hi) => Math.max(lo,Math.min(hi,x));
  const round = (n,d=3) => Math.round(n*10**d)/10**d;
  const argmax = values => values.reduce((best,v,i) => v>values[best]?i:best,0);
  const median = values => { const sorted=[...values].sort((a,b)=>a-b); return sorted[Math.floor(sorted.length/2)] || 0; };
  const escapeXML = value => String(value).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  function parse(chord) {
    const index=CHORDS.indexOf(chord);
    if(index<0) throw new Error('不支持的和弦：'+chord);
    return [index%12,index>=12];
  }
  function transpose(chord,steps) { if(chord==='N')return chord; const [r,m]=parse(chord); return PITCHES[(r+steps+120)%12]+(m?'m':''); }
  function voicing(chord) { if(chord==='N')return Array(6).fill(null); const [r,m]=parse(chord); return [...(m?MINOR:MAJOR)[r]].map(f=>f==='x'?null:+f); }
  function configOptions(options={}) {
    const c={capo:0,pattern:'arpeggio',rhythm:'folk',meter:4,bpm:null,offset:null,changes:'bar',overrides:{},max_fret:7,...options};
    if(!Number.isInteger(c.max_fret)||c.max_fret<1||c.max_fret>24)throw new Error('最高品位应在 1–24 品之间。');
    if(!Number.isInteger(c.capo)||c.capo<0||c.capo>12) throw new Error('变调夹应为 0–12 品。');
    if(![3,4].includes(c.meter)) throw new Error('请选择 3/4 或 4/4 拍。');
    if(!['arpeggio','strum','transcribe'].includes(c.pattern)||!['folk','steady'].includes(c.rhythm)||!['bar','half'].includes(c.changes)) throw new Error('演奏配置不正确。');
    if(c.bpm!==null&&(!Number.isFinite(c.bpm)||c.bpm<40||c.bpm>220)) throw new Error('速度应为 40–220 BPM。');
    if(c.offset!==null&&(!Number.isFinite(c.offset)||c.offset<0||c.offset>30)) throw new Error('起拍时间应为 0–30 秒。');
    if(!c.overrides||typeof c.overrides!=='object'||Array.isArray(c.overrides)) throw new Error('和弦修改格式不正确。');
    for(const chord of Object.values(c.overrides)) if(chord!=='N')parse(chord);
    return c;
  }

  class FFT {
    constructor(size) {
      this.n=size; this.real=new Float64Array(size); this.imag=new Float64Array(size);
      this.reversed=new Uint32Array(size); this.window=new Float64Array(size);
      const bits=Math.log2(size);
      for(let i=0;i<size;i++){
        let x=i,r=0; for(let b=0;b<bits;b++){r=(r<<1)|(x&1);x>>=1;} this.reversed[i]=r;
        this.window[i]=.5-.5*Math.cos(2*Math.PI*i/(size-1));
      }
    }
    transform(samples, center) {
      const {n,real,imag,reversed,window}=this;
      for(let i=0;i<n;i++){const index=center+i-n/2; real[reversed[i]]=(samples[index]||0)*window[i]; imag[i]=0;}
      for(let length=2;length<=n;length*=2){
        const half=length/2,ca=Math.cos(-2*Math.PI/length),sa=Math.sin(-2*Math.PI/length);
        for(let start=0;start<n;start+=length){
          let wr=1,wi=0;
          for(let j=0;j<half;j++){
            const a=start+j,b=a+half,tr=wr*real[b]-wi*imag[b],ti=wr*imag[b]+wi*real[b];
            real[b]=real[a]-tr; imag[b]=imag[a]-ti; real[a]+=tr; imag[a]+=ti;
            const next=wr*ca-wi*sa; wi=wr*sa+wi*ca; wr=next;
          }
        }
      }
      return real;
    }
  }

  function estimateTempo(onset,frameRate,rms) {
    const floor=median(onset), curve=onset.map(x=>Math.max(0,x-floor));
    const lo=Math.ceil(frameRate*60/200), hi=Math.floor(frameRate*60/55);
    let bestLag=Math.round(frameRate*.5),best=-Infinity;
    for(let lag=lo;lag<=hi;lag++){
      let score=0,normA=0,normB=0;
      for(let i=lag;i<curve.length;i++){score+=curve[i]*curve[i-lag];normA+=curve[i]**2;normB+=curve[i-lag]**2;}
      score/=Math.sqrt(normA*normB)+1e-12;
      const bpm=60*frameRate/lag;
      score*=.75+.25*Math.exp(-.5*(Math.log2(bpm/115)/.7)**2);
      if(score>best){best=score;bestLag=lag;}
    }
    // Prefer a useful quarter-note practice grid when the strongest peak is a
    // half-time pulse. Tempo remains user-adjustable for genuinely slow songs.
    if(60*frameRate/bestLag<80)bestLag=Math.max(lo,Math.round(bestLag/2));
    const bpm=round(clamp(60*frameRate/bestLag,40,220),1);
    let peak=0; for(const v of rms)peak=Math.max(peak,v);
    let first=rms.findIndex(x=>x>Math.max(.0005,peak*.08)); if(first<0)first=0;
    // The large harmonic-analysis window smears attacks. Use the earliest
    // strong RMS attack for the initial phase, not the centre of that window.
    let bestPhase=first,bestAttack=-Infinity;
    for(let i=first;i<Math.min(rms.length,first+Math.round(bestLag*.6));i++){
      const attack=rms[i]-(rms[i-1]||0);
      if(attack>bestAttack){bestAttack=attack;bestPhase=i;}
    }
    return {bpm,offset:round(Math.min(bestPhase/frameRate,30)),beat_count:Math.floor(curve.length/bestLag)};
  }

  function analyze(samples,sampleRate=22050,progress=()=>{}) {
    const duration=samples.length/sampleRate;
    if(duration<2)throw new Error('音频太短，请选择至少 2 秒的片段。');
    if(duration>600.1)throw new Error('请选择 10 分钟以内的片段。');
    const size=8192,hop=512,frames=Math.ceil(samples.length/hop),fft=new FFT(size);
    const chroma=new Float32Array(frames*12),rms=new Float32Array(frames),onset=new Float32Array(frames);
    const previous=new Float64Array(size/2),magnitude=new Float64Array(size/2),prefix=new Float64Array(size/2+1);
    const bins=[];
    for(let bin=1;bin<size/2;bin++){
      const frequency=bin*sampleRate/size,midi=69+12*Math.log2(frequency/440),nearest=Math.round(midi);
      if(midi<35.5||midi>95.5)continue;
      const distance=Math.abs(midi-nearest);
      if(distance>.45)continue;
      bins.push({bin,pitch:(nearest+120)%12,weight:Math.exp(-.5*(distance/.22)**2)/Math.sqrt(frequency/110),
        low:Math.max(1,Math.floor(bin/1.13)),high:Math.min(size/2,Math.ceil(bin*1.13))});
    }
    let maxRms=0;
    for(let frame=0;frame<frames;frame++){
      const center=frame*hop; fft.transform(samples,center);
      prefix[0]=0; let flux=0,energy=0;
      for(let bin=0;bin<size/2;bin++){
        const power=Math.hypot(fft.real[bin],fft.imag[bin]); magnitude[bin]=power; prefix[bin+1]=prefix[bin]+power;
        if(bin>20&&bin<1500){const compressed=Math.log1p(power);flux+=Math.max(0,compressed-previous[bin]);previous[bin]=compressed;}
      }
      for(let i=center;i<Math.min(center+hop,samples.length);i++)energy+=samples[i]**2;
      rms[frame]=Math.sqrt(energy/hop);maxRms=Math.max(maxRms,rms[frame]);onset[frame]=flux;
      for(const {bin,pitch,weight,low,high} of bins){
        const background=(prefix[high]-prefix[low])/(high-low);
        const peak=Math.max(0,magnitude[bin]-background*.75);
        chroma[frame*12+pitch]+=Math.sqrt(peak)*weight;
      }
      let maximum=0;for(let p=0;p<12;p++)maximum=Math.max(maximum,chroma[frame*12+p]);
      if(maximum>0)for(let p=0;p<12;p++)chroma[frame*12+p]/=maximum;
      if(frame%80===0)progress(24+Math.round(frame/frames*48),'正在浏览器中分析节拍与和声');
    }
    if(maxRms<.0005)throw new Error('音轨接近静音，无法识别和弦。');
    progress(75,'正在估计速度与起拍');
    const tempo=estimateTempo(onset,sampleRate/hop,rms);
    const waveform=[];
    for(let i=0;i<240;i++){
      let peak=0;for(let j=Math.floor(i*samples.length/240);j<Math.floor((i+1)*samples.length/240);j++)peak=Math.max(peak,Math.abs(samples[j]));waveform.push(peak);
    }
    return {meta:{duration:round(duration),...tempo,sample_rate:sampleRate,hop,waveform,algorithm:'browser-fft-chroma-viterbi-v1'},chroma,rms,attacks:detectAttacks(samples,sampleRate)};
  }

  function detectAttacks(samples,sampleRate=22050) {
    const hop=256,size=2048,fft=new FFT(size),count=Math.ceil(samples.length/hop),flux=new Float32Array(count),previous=new Float32Array(size/2);
    for(let frame=0;frame<count;frame++){
      fft.transform(samples,frame*hop);let sum=0;
      for(let bin=4;bin<Math.min(size/2,Math.ceil(5000*size/sampleRate));bin++){
        const value=Math.log1p(10*Math.hypot(fft.real[bin],fft.imag[bin]));sum+=Math.max(0,value-previous[bin]);previous[bin]=value;
      }
      flux[frame]=sum;
    }
    let maximum=0;for(const value of flux)maximum=Math.max(maximum,value);
    const candidates=[];
    for(let i=3;i<count-3;i++){
      if(flux[i]<maximum*.018)continue;
      if(flux[i]<Math.max(...flux.subarray(i-2,i+3)))continue;
      const window=flux.subarray(Math.max(0,i-25),Math.min(count,i+26));
      const baseline=median(window);
      if(flux[i]<Math.max(baseline*1.8,maximum*.035))continue;
      candidates.push({time:round(i*hop/sampleRate),strength:round(flux[i]/maximum)});
    }
    const result=[];
    for(const candidate of candidates){
      const last=result.at(-1);
      if(last && candidate.time-last.time<.09){if(candidate.strength>last.strength)result[result.length-1]=candidate;}
      else result.push(candidate);
    }
    return result;
  }

  const TEMPLATES=CHORDS.map(chord=>{
    const [r,m]=parse(chord),v=Array(12).fill(-.12);v[r]=1;v[(r+(m?3:4))%12]=.85;v[(r+7)%12]=.8;
    const norm=Math.hypot(...v);return v.map(x=>x/norm);
  });
  function recognize(features,ranges) {
    const scores=[],energies=[];
    for(const [lo,hi] of ranges){
      const vector=Array(12).fill(0);let energy=0,count=0;
      for(let i=lo;i<Math.max(hi,lo+1)&&i<features.rms.length;i++){
        for(let p=0;p<12;p++)vector[p]+=features.chroma[i*12+p];energy+=features.rms[i];count++;
      }
      const norm=Math.hypot(...vector)+1e-9;
      scores.push(TEMPLATES.map(template=>template.reduce((s,v,p)=>s+v*vector[p]/norm,0)));
      energies.push(energy/Math.max(1,count));
    }
    const history=[];let dp=scores[0].slice();
    for(const row of scores.slice(1)){
      const next=[],back=[];
      for(let state=0;state<24;state++){
        const options=dp.map((v,i)=>v-(i===state?0:.13)),best=argmax(options);
        next.push(options[best]+row[state]);back.push(best);
      }
      dp=next;history.push(back);
    }
    const path=[argmax(dp)];for(let i=history.length-1;i>=0;i--)path.push(history[i][path.at(-1)]);path.reverse();
    const sorted=[...features.rms].sort((a,b)=>a-b),threshold=Math.max(.0005,(sorted[Math.floor(sorted.length*.75)]||0)*.045);
    return path.map((state,i)=>{
      if(energies[i]<threshold)return {chord:'N',confidence:0};
      const row=scores[i],margin=Math.max(0,row[state]-Math.max(...row.filter((_,j)=>j!==state)));
      return {chord:CHORDS[state],confidence:round(clamp(.35+margin*3+(row[state]-.65)*.65,.1,.95),2)};
    });
  }
  function estimateKey(features) {
    const mean=Array(12).fill(0);for(let i=0;i<features.chroma.length;i++)mean[i%12]+=features.chroma[i];
    const avg=mean.reduce((a,b)=>a+b,0)/12;for(let i=0;i<12;i++)mean[i]-=avg;
    const profiles=[[6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88],[6.33,2.68,3.52,5.38,2.6,3.53,2.54,4.75,3.98,2.69,3.34,3.17]],scores=[];
    for(const raw of profiles){
      const average=raw.reduce((a,b)=>a+b,0)/12,profile=raw.map(x=>x-average);
      for(let r=0;r<12;r++)scores.push(mean.reduce((s,v,p)=>s+v*profile[(p-r+12)%12],0)/(Math.hypot(...mean)*Math.hypot(...profile)+1e-9));
    }
    return CHORDS[argmax(scores)];
  }
  function noteEvents(shape,capo,pattern,rhythm,beats,beatOffset=0,meter=4) {
    const frets=voicing(shape),active=frets.map((f,i)=>f===null?-1:i).filter(i=>i>=0);
    if(!active.length)return [];
    const result=[],slots=Math.round(beats*2);
    for(let slot=0;slot<slots;slot++){
      const globalSlot=Math.round(beatOffset*2)+slot;
      let direction=null,indices;
      if(pattern==='strum'){
        if(rhythm==='steady'){if(globalSlot%2)continue;direction='down';}
        else {if((meter===4?[1,4]:[1]).includes(globalSlot))continue;direction=globalSlot%2?'up':'down';}
        indices=direction==='down'?active:[...active.filter(i=>i>=2)].reverse();
      }else{
        const order=slots===6?[active[0],3,4,5,4,3]:[active[0],3,4,3,5,3,4,3];
        const i=order[slot%order.length];indices=[active.includes(i)?i:active.at(-1)];
      }
      result.push({beat:round(beatOffset+slot/2),duration:pattern==='strum'&&rhythm==='steady'?1:.5,direction,
        notes:indices.map(i=>({string:6-i,fret:frets[i],midi:OPEN[i]+frets[i]+capo}))});
    }
    return result;
  }
  function arrange(features,options,title) {
    if(options?.pattern==='transcribe'){
      if(!root.StringspaceTranscription)throw new Error('逐音转录组件未加载，请刷新页面。');
      return root.StringspaceTranscription.arrange(features,configOptions(options),title);
    }
    const config=configOptions(options),meta=features.meta,bpm=config.bpm??meta.bpm,offset=config.offset??meta.offset;
    if(offset>=meta.duration-.05)throw new Error('起拍时间后没有足够的音乐，请提前起拍时间。');
    const beatSeconds=60/bpm,perBar=config.changes==='half'?2:1,step=config.meter*beatSeconds/perBar;
    const ranges=[],segments=[];
    for(let index=0,start=offset;start<meta.duration-.05;index++,start=offset+index*step){
      const end=Math.min(start+step,meta.duration),rate=meta.sample_rate/meta.hop;
      ranges.push([Math.min(features.rms.length-1,Math.floor(start*rate)),Math.min(features.rms.length,Math.floor(end*rate))]);
      segments.push({id:String(index),start:round(start),end:round(end)});
    }
    const detected=recognize(features,ranges);
    segments.forEach((s,i)=>{const chord=config.overrides[s.id]??detected[i].chord;Object.assign(s,{sounding:chord,shape:transpose(chord,-config.capo),confidence:detected[i].confidence,edited:Object.hasOwn(config.overrides,s.id)});});
    const measures=[];
    for(let i=0;i<segments.length;i+=perBar){
      const group=segments.slice(i,i+perBar),events=[];
      group.forEach((segment,position)=>{
        const beats=config.meter/perBar,available=(segment.end-segment.start)/beatSeconds;
        for(const event of noteEvents(segment.shape,config.capo,config.pattern,config.rhythm,beats,position*beats,config.meter)){
          const local=event.beat-position*beats;if(local>=available-.015)continue;
          event.duration=round(Math.min(event.duration,available-local));event.time=round(segment.start+local*beatSeconds);events.push(event);
        }
      });
      measures.push({number:measures.length+1,start:group[0].start,end:group.at(-1).end,segments:group,events});
    }
    const chords=[...new Set(segments.map(s=>s.shape).filter(s=>s!=='N'))].map(name=>({name,frets:voicing(name),sounding:transpose(name,config.capo)}));
    const easy=new Set(['C','D','E','G','A','Am','Dm','Em']);
    const recommendations=Array.from({length:8},(_,capo)=>{
      const shapes=segments.filter(s=>s.sounding!=='N').map(s=>transpose(s.sounding,-capo));
      return {capo,easy_ratio:round(shapes.filter(s=>easy.has(s)).length/Math.max(1,shapes.length),2)};
    }).sort((a,b)=>b.easy_ratio-a.easy_ratio||a.capo-b.capo);
    return {title,duration:meta.duration,bpm:round(bpm,1),offset:round(offset),key:estimateKey(features),config,measures,chords,waveform:meta.waveform,
      capo_suggestions:recommendations.slice(0,3),review_count:segments.filter(s=>s.confidence<.55&&!s.edited&&s.sounding!=='N').length,
      algorithm:meta.algorithm,warnings:['自动和弦识别后的伴奏编配，不是原录音逐音还原。','速度和起拍是估计值，请结合原音校对。','支持大、小三和弦，复杂和弦和转位会被简化。']};
  }
  function midiBytes(score) {
    if(score.source_notes)return root.StringspaceTranscription.midiBytes(score);
    const bytes=[],events=[];
    const variable=n=>{const out=[n&127];while(n>>=7)out.unshift((n&127)|128);return out;};
    const text=new TextEncoder().encode(score.title);bytes.push(0,255,3,...variable(text.length),...text);
    const tempo=Math.round(60000000/score.bpm);bytes.push(0,255,81,3,(tempo>>16)&255,(tempo>>8)&255,tempo&255,0,255,88,4,score.config.meter,2,24,8,0,192,24);
    for(const bar of score.measures)for(const event of bar.events){
      const onset=Math.round(((bar.number-1)*score.config.meter+event.beat)*480);
      event.notes.forEach((note,i)=>{const delay=event.direction?i*9:0;events.push([onset+delay,1,note.midi],[onset+delay+Math.max(1,Math.round(event.duration*480*.92)),0,note.midi]);});
    }
    events.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);let previous=0;
    for(const [tick,on,pitch] of events){bytes.push(...variable(tick-previous),on?144:128,pitch,on?76:0);previous=tick;}
    bytes.push(0,255,47,0);const length=bytes.length;
    return new Uint8Array([77,84,104,100,0,0,0,6,0,0,0,1,1,224,77,84,114,107,(length>>>24)&255,(length>>>16)&255,(length>>>8)&255,length&255,...bytes]);
  }
  function musicxml(score) {
    if(score.source_notes)return root.StringspaceTranscription.musicxml(score);
    const e=escapeXML,capo=score.config.capo,meter=score.config.meter;
    let xml=`<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><work><work-title>${e(score.title)}</work-title></work><part-list><score-part id="P1"><part-name>Guitar</part-name></score-part></part-list><part id="P1">`;
    const rest=n=>n>0?`<note><rest/><duration>${n}</duration></note>`:'';
    for(const bar of score.measures){
      xml+=`<measure number="${bar.number}">`;
      if(bar.number===1){
        xml+=`<attributes><divisions>480</divisions><time><beats>${meter}</beats><beat-type>4</beat-type></time><clef><sign>TAB</sign><line>5</line></clef><staff-details><staff-lines>6</staff-lines>`;
        ['E','A','D','G','B','E'].forEach((step,i)=>xml+=`<staff-tuning line="${i+1}"><tuning-step>${step}</tuning-step><tuning-octave>${Math.floor(OPEN[i]/12)-1}</tuning-octave></staff-tuning>`);
        xml+=`<capo>${capo}</capo></staff-details></attributes><direction><direction-type><words>Capo ${capo} · 和弦名为指型 · 自动伴奏编配</words></direction-type><sound tempo="${score.bpm}"/></direction>`;
      }
      for(const segment of bar.segments){
        if(segment.shape==='N')continue;const [r,m]=parse(segment.shape),name=PITCHES[r];
        xml+=`<harmony><root><root-step>${name[0]}</root-step>${name.length>1?`<root-alter>${name[1]==='#'?1:-1}</root-alter>`:''}</root><kind>${m?'minor':'major'}</kind><offset>${Math.round((segment.start-bar.start)*score.bpm/60*480)}</offset></harmony>`;
      }
      let position=0;
      for(const event of bar.events){
        const onset=Math.round(event.beat*480),ticks=Math.max(1,Math.round(event.duration*480));xml+=rest(onset-position);
        event.notes.forEach((note,i)=>{
          const name=PITCHES[note.midi%12];xml+=`<note>${i?'<chord/>':''}<pitch><step>${name[0]}</step>${name.length>1?`<alter>${name[1]==='#'?1:-1}</alter>`:''}<octave>${Math.floor(note.midi/12)-1}</octave></pitch><duration>${ticks}</duration>${[240,480].includes(ticks)?`<type>${ticks===240?'eighth':'quarter'}</type>`:''}<notations><technical><string>${note.string}</string><fret>${note.fret}</fret></technical></notations></note>`;
        });position=onset+ticks;
      }
      xml+=rest(meter*480-position)+'</measure>';
    }
    return xml+'</part></score-partwise>';
  }
  function textTab(score) {
    if(score.source_notes)return root.StringspaceTranscription.textTab(score);
    const lines=[score.title,`${score.bpm} BPM | ${score.config.meter}/4 | Capo ${score.config.capo}`,'和弦名为指型，数字相对变调夹。自动伴奏编配，请对照原音校对。',''];
    for(const bar of score.measures){
      lines.push(`第 ${bar.number} 小节 (${bar.start.toFixed(2)}s)  `+bar.segments.map(s=>s.shape).join(' → '));
      const width=score.config.meter*2,rows=Array.from({length:6},()=>Array(width).fill('---')),rhythm=Array(width).fill('   ');
      for(const event of bar.events){const slot=Math.round(event.beat*2);if(event.direction)rhythm[slot]=event.direction==='down'?' ↓ ':' ↑ ';for(const note of event.notes)rows[note.string-1][slot]=String(note.fret).padStart(2,'-').padEnd(3,'-');}
      lines.push('  '+rhythm.join(''));['e','B','G','D','A','E'].forEach((label,i)=>lines.push(label+'|'+rows[i].join('')+'|'));lines.push('');
    }
    return lines.join('\n');
  }
  const engine={CHORDS,OPEN,parse,transpose,voicing,configOptions,analyze,detectAttacks,recognize,arrange,noteEvents,midiBytes,musicxml,textTab};
  root.StringspaceEngine=engine;
  if(typeof module!=='undefined'&&module.exports)module.exports=engine;
})(globalThis);
