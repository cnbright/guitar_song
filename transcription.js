/* Preserve detected notes and their real timestamps; never replace them with a pattern. */
(function(root){
  'use strict';
  const E=root.StringspaceEngine,round=n=>Math.round(n*1000000)/1000000;
  const median=a=>{const s=[...a].sort((x,y)=>x-y);return s[Math.floor(s.length/2)]||0;};
  function cleanNotes(raw,attacks,duration,reference){
    const grouped=new Map(),output=[];
    for(const source of raw){
      if(!Number.isFinite(source.time)||!Number.isFinite(source.duration)||!Number.isInteger(source.midi)||source.amplitude<.22||source.duration<.06)continue;
      const note={...source,time:Math.max(0,source.time),duration:Math.min(source.duration,duration-source.time)};
      if(note.time>=duration||note.duration<=0)continue;
      if(!grouped.has(note.midi))grouped.set(note.midi,[]);grouped.get(note.midi).push(note);
    }
    let merged=0,unsupportedRetriggers=0;
    for(const notes of grouped.values()){
      notes.sort((a,b)=>a.time-b.time);let last;
      for(const note of notes){
        let attack=attacks.some(a=>Math.abs(a.time-note.time)<.055);
        if(attack&&last&&note.amplitude<.6&&note.time<=last.time+last.duration+.045&&reference){
          const rise=root.StringspaceVerification.pitchRise(reference,note.midi,note.time);
          if(rise!==null&&rise<.85){attack=false;unsupportedRetriggers++;}
        }
        if(last && note.time<=last.time+last.duration+.045 && !attack){
          last.duration=Math.max(last.duration,note.time+note.duration-last.time);last.amplitude=Math.max(last.amplitude,note.amplitude);merged++;
        }else{
          if(last && last.time+last.duration>note.time)last.duration=note.time-last.time;
          output.push(note);last=note;
        }
      }
    }
    return {notes:output.sort((a,b)=>a.time-b.time||a.midi-b.midi),merged,unsupportedRetriggers};
  }
  function grid(features,notes,config){
    const period=60/(config.bpm??features.meta.bpm),start=config.offset??notes[0].time;
    if(start>=features.meta.duration-.05)throw new Error('起拍时间必须早于音频结束。');
    const beats=[start],attacks=features.attacks||[];let step=period;
    while(beats.at(-1)<features.meta.duration+config.meter*period){
      const previous=beats.at(-1),expected=previous+step;
      let next=expected;
      if(config.bpm===null){
        const candidates=attacks.filter(a=>Math.abs(a.time-expected)<step*.2 && a.time>previous+period*.65);
        if(candidates.length){
          candidates.sort((a,b)=>Math.abs(a.time-expected)-Math.abs(b.time-expected));next=candidates[0].time;
          step=Math.max(period*.85,Math.min(period*1.15,.88*step+.12*(next-previous)));
        }
      }
      beats.push(next);
    }
    return beats;
  }
  function timeToBeat(times,time){
    if(time<=times[0])return (time-times[0])/(times[1]-times[0]);
    let lo=0,hi=times.length-1;
    while(hi-lo>1){const mid=(lo+hi)>>1;if(times[mid]<=time)lo=mid;else hi=mid;}
    return lo+(time-times[lo])/(times[Math.min(lo+1,times.length-1)]-times[lo]||.5);
  }
  function finger(notes,capo,maxFret=7){
    const valid=[],unplayable=[];
    for(const note of notes){
      const choices=E.OPEN.map((open,i)=>({string:6-i,fret:note.midi-open-capo})).filter(x=>x.fret>=0&&x.fret<=maxFret);
      if(choices.length)valid.push({...note,choices});else unplayable.push(note);
    }
    const weight=note=>note.duration*note.amplitude;
    const totalWeight=notes.reduce((sum,n)=>sum+weight(n),0);
    const lowWeight=unplayable.filter(n=>n.midi>=40&&n.midi<E.OPEN[0]+capo).reduce((sum,n)=>sum+weight(n),0);
    // Isolated low-pitch artifacts are reported as unmapped; a capo that loses
    // a material bass part is rejected instead of silently transposing it.
    if(capo>0 && lowWeight>totalWeight*.02)throw new Error(`变调夹夹 ${capo} 品后会丢失较多低音，无法保持原演奏。请降低品位，或改用简化编配。`);
    const assigned=[];let position=0,dropped=unplayable.length;
    for(let index=0;index<valid.length;){
      const start=valid[index].time,group=[];
      while(index<valid.length&&valid[index].time-start<=.045)group.push(valid[index++]);
      group.sort((a,b)=>b.amplitude-a.amplitude||a.midi-b.midi);
      if(group.length>6){dropped+=group.length-6;group.length=6;}
      let beam=[{used:[],notes:[],cost:0,frets:[]}];
      for(const note of group){
        const next=[];
        for(const partial of beam)for(const choice of note.choices){
          if(partial.used.includes(choice.string))continue;
          const frets=[...partial.frets,...(choice.fret?[choice.fret]:[])],span=frets.length?Math.max(...frets)-Math.min(...frets):0;
          const cost=partial.cost+choice.fret*.045+Math.abs(choice.fret-position)*.07+Math.max(0,span-4)*3;
          next.push({used:[...partial.used,choice.string],notes:[...partial.notes,{...note,...choice}],cost,frets});
        }
        if(!next.length){dropped++;continue;}
        next.sort((a,b)=>a.cost-b.cost);beam=next.slice(0,64);
      }
      const best=beam[0];if(best){position=median(best.frets);assigned.push(...best.notes);}
    }
    assigned.sort((a,b)=>a.time-b.time||a.midi-b.midi);
    const previous=new Map();let clipped=0;
    for(const note of assigned){
      const last=previous.get(note.string);
      if(last && last.time+last.duration>note.time){last.duration=Math.max(.01,note.time-last.time);clipped++;}
      previous.set(note.string,note);delete note.choices;
    }
    return {notes:assigned,dropped,clipped};
  }
  function arrange(features,config,title){
    if(!features.transcription?.notes?.length)throw new Error('这份旧作品没有逐音转录数据，请重新导入音乐，选择“原伴奏转录”。');
    const cleaned=cleanNotes(features.transcription.notes,features.attacks||[],features.meta.duration,features.acoustic);
    const mapping=finger(cleaned.notes,config.capo,config.max_fret);
    if(!mapping.notes.length)throw new Error('没有可映射到标准吉他的音符，请使用清晰的吉他音轨。');
    const beats=grid(features,mapping.notes,config),offset=beats[0],meter=config.meter;
    const base=E.arrange(features,{...config,pattern:'arpeggio',offset},title),measures=[],ranges=[];
    for(let index=0;beats[index*meter]<features.meta.duration-.05;index++){
      const beatTimes=beats.slice(index*meter,index*meter+meter+1),start=beatTimes[0],end=Math.min(beatTimes.at(-1),features.meta.duration);
      const bar={number:index+1,start:round(start),end:round(end),beat_times:beatTimes,segments:[],events:[]};
      const parts=config.changes==='half'?2:1;
      for(let part=0;part<parts;part++){
        const beat=part*meter/parts,position=Math.floor(beat),fraction=beat-position;
        const at=beatTimes[position]+fraction*(beatTimes[position+1]-beatTimes[position]);
        const segmentEnd=part===parts-1?end:beatTimes[Math.floor(meter/parts)]+(meter/parts%1)*(beatTimes[Math.floor(meter/parts)+1]-beatTimes[Math.floor(meter/parts)]);
        const id=String(index*parts+part),rate=features.meta.sample_rate/features.meta.hop;
        bar.segments.push({id,start:round(at),end:round(segmentEnd)});
        ranges.push([Math.min(features.rms.length-1,Math.floor(at*rate)),Math.min(features.rms.length,Math.floor(segmentEnd*rate))]);
      }
      measures.push(bar);
    }
    const harmonic=new Float32Array(features.chroma.length);
    for(const note of mapping.notes){
      const rate=features.meta.sample_rate/features.meta.hop,lo=Math.max(0,Math.floor(note.time*rate)),hi=Math.min(features.rms.length,Math.ceil((note.time+note.duration)*rate));
      for(let i=lo;i<hi;i++)harmonic[i*12+note.midi%12]+=note.amplitude;
    }
    const detected=E.recognize({...features,chroma:harmonic},ranges);let segmentIndex=0;
    for(const bar of measures)for(const segment of bar.segments){
      const detection=detected[segmentIndex++],chord=config.overrides[segment.id]??detection.chord;
      Object.assign(segment,{sounding:chord,shape:E.transpose(chord,-config.capo),confidence:detection.confidence,edited:Object.hasOwn(config.overrides,segment.id)});
    }
    const retained=mapping.notes.filter(note=>note.time>=offset-.001);
    for(let i=0;i<retained.length;){
      const first=retained[i],group=[first];i++;
      while(i<retained.length&&retained[i].time-first.time<=.035)group.push(retained[i++]);
      const index=Math.min(measures.length-1,Math.max(0,Math.floor(timeToBeat(beats,first.time)/meter))),bar=measures[index];
      const end=first.time+Math.min(...group.map(n=>n.duration));
      bar.events.push({beat:round(timeToBeat(beats,first.time)-index*meter),time:first.time,duration:round(timeToBeat(beats,end)-timeToBeat(beats,first.time)),
        duration_seconds:Math.min(...group.map(n=>n.duration)),direction:null,source:true,
        notes:group.map(n=>({id:n.id,string:n.string,fret:n.fret,midi:n.midi,amplitude:n.amplitude,onset_offset:n.time-first.time,duration_seconds:n.duration}))});
    }
    const unique=[...new Set(measures.flatMap(b=>b.segments).map(s=>s.shape).filter(s=>s!=='N'))];
    const weighted=[...retained].sort((a,b)=>a.midi-b.midi),totalWeight=weighted.reduce((sum,n)=>sum+n.duration*n.amplitude,0);
    let minimum=40,cumulative=0;for(const note of weighted){cumulative+=note.duration*note.amplitude;if(cumulative>=totalWeight*.02){minimum=note.midi;break;}}
    return {...base,config,offset,bpm:config.bpm??Math.round(60/median(beats.slice(1).map((t,i)=>t-beats[i]))*10)/10,
      measures,chords:unique.map(name=>({name,frets:E.voicing(name),sounding:E.transpose(name,config.capo)})),
      capo_suggestions:base.capo_suggestions.filter(c=>c.capo<=minimum-40),beat_times:beats,
      source_notes:retained.map(({choices,...note})=>note),algorithm:'basic-pitch-note-transcription-v3',
      quality:{status:'draft',model:features.transcription.model,raw_notes:features.transcription.notes.length,retained_notes:retained.length,
        merged_retriggers:cleaned.merged,unsupported_retriggers:cleaned.unsupportedRetriggers,unmapped_notes:mapping.dropped,clipped_sustains:mapping.clipped,needs_review:true},
      review_count:retained.filter(n=>n.amplitude<.5).length,
      warnings:['逐音识别草稿：保留检测到的音高与实际时间，但仍可能漏音、多音或选错弦位。','和弦名称仅为估计标注，不参与生成转录音符。','请先试听短片段并校对，再使用整曲谱。']};
  }
  function midiBytes(score){
    const track=[],events=[],tempo=Math.round(60000000/score.bpm),encoder=new TextEncoder();
    const variable=n=>{const bytes=[n&127];while(n>>=7)bytes.unshift((n&127)|128);return bytes;};
    const title=encoder.encode(score.title);track.push(0,255,3,...variable(title.length),...title,0,255,81,3,tempo>>16&255,tempo>>8&255,tempo&255);
    track.push(0,255,88,4,score.config.meter,2,24,8);
    for(let channel=0;channel<6;channel++)track.push(0,192+channel,24);
    const rate=480*score.bpm/60;
    for(const note of score.source_notes??score.performance_notes){
      const tick=Math.max(0,Math.round((note.time-score.offset)*rate)),end=tick+Math.max(1,Math.round(note.duration*rate));
      events.push({tick,on:true,note},{tick:end,on:false,note});
    }
    events.sort((a,b)=>a.tick-b.tick||Number(a.on)-Number(b.on));let previous=0;
    for(const {tick,on,note} of events){track.push(...variable(tick-previous),(on?144:128)+note.string-1,note.midi,on?(note.gain===undefined?80:Math.min(127,Math.max(1,Math.round(100*Math.sqrt(note.gain))))):0);previous=tick;}
    track.push(0,255,47,0);const n=track.length;
    return new Uint8Array([77,84,104,100,0,0,0,6,0,0,0,1,1,224,77,84,114,107,n>>>24&255,n>>>16&255,n>>>8&255,n&255,...track]);
  }
  const xmlEscape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  function musicxml(score){
    const meter=score.config.meter,barTicks=meter*480;
    const pitches=[['C',0],['C',1],['D',0],['E',-1],['E',0],['F',0],['F',1],['G',0],['A',-1],['A',0],['B',-1],['B',0]];
    const label=score.arrangement?'简化分解 · 伴奏编配（不代表原音逐音还原）':score.performance_notes?'简化分解':'逐音转录草稿';
    let xml=`<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><work><work-title>${xmlEscape(score.title)} · ${label}</work-title></work><part-list><score-part id="P1"><part-name>Guitar</part-name></score-part></part-list><part id="P1">`;
    const rest=(ticks,voice)=>ticks>0?`<note><rest/><duration>${ticks}</duration><voice>${voice}</voice></note>`:'';
    for(const bar of score.measures){
      xml+=`<measure number="${bar.number}">`;
      if(bar.number===1){
        xml+=`<attributes><divisions>480</divisions><time><beats>${meter}</beats><beat-type>4</beat-type></time><clef><sign>TAB</sign><line>5</line></clef><staff-details><staff-lines>6</staff-lines>`;
        ['E','A','D','G','B','E'].forEach((step,i)=>xml+=`<staff-tuning line="${i+1}"><tuning-step>${step}</tuning-step><tuning-octave>${Math.floor(E.OPEN[i]/12)-1}</tuning-octave></staff-tuning>`);
        xml+=`<capo>${score.config.capo}</capo></staff-details></attributes><direction><direction-type><words>${label}，请校对。和弦标注为估计值。</words></direction-type></direction>`;
      }
      for(let beat=0;beat<meter;beat++)xml+=`<direction><direction-type><words/></direction-type><offset>${beat*480}</offset><sound tempo="${60/(bar.beat_times[beat+1]-bar.beat_times[beat])}"/></direction>`;
      for(const segment of bar.segments){
        if(segment.shape==='N')continue;
        const [r,m]=E.parse(segment.shape),[step,alter]=pitches[r];
        const bass=segment.display_shape&&Number.isInteger(segment.bass_midi)?pitches[(segment.bass_midi-score.config.capo+120)%12]:null;
        xml+=`<harmony><root><root-step>${step}</root-step>${alter?`<root-alter>${alter}</root-alter>`:''}</root><kind>${m?'minor':'major'}</kind>${bass?`<bass><bass-step>${bass[0]}</bass-step>${bass[1]?`<bass-alter>${bass[1]}</bass-alter>`:''}</bass>`:''}<offset>${Math.round(timeToBeat(bar.beat_times,segment.start)*480)}</offset></harmony>`;
      }
      for(let voice=1;voice<=6;voice++){
        if(voice>1)xml+=`<backup><duration>${barTicks}</duration></backup>`;
        let position=0;
        const notes=(score.source_notes??score.performance_notes).filter(n=>n.string===voice&&n.time<bar.beat_times.at(-1)&&n.time+n.duration>bar.start);
        for(const note of notes){
          const from=Math.max(note.time,bar.start),to=Math.min(note.time+note.duration,bar.beat_times.at(-1));
          const start=Math.max(position,Math.round(timeToBeat(bar.beat_times,from)*480)),end=Math.min(barTicks,Math.round(timeToBeat(bar.beat_times,to)*480));
          if(end<=start)continue;
          xml+=rest(start-position,voice);
          const [step,alter]=pitches[note.midi%12],stop=note.time<bar.start-.00001,tie=note.time+note.duration>bar.beat_times.at(-1)+.00001;
          xml+=`<note><pitch><step>${step}</step>${alter?`<alter>${alter}</alter>`:''}<octave>${Math.floor(note.midi/12)-1}</octave></pitch><duration>${end-start}</duration>${stop?'<tie type="stop"/>':''}${tie?'<tie type="start"/>':''}<voice>${voice}</voice><notations>${stop?'<tied type="stop"/>':''}${tie?'<tied type="start"/>':''}<technical><string>${voice}</string><fret>${note.fret}</fret></technical></notations></note>`;
          position=end;
        }
        xml+=rest(barTicks-position,voice);
      }
      xml+='</measure>';
    }
    return xml+'</part></score-partwise>';
  }
  function textTab(score){
    const lines=[score.title+' · '+(score.performance_notes?'简化分解':'逐音转录草稿'),`Capo ${score.config.capo} | ${score.bpm} BPM（小节随起音校正）`,'每列为一次起音，列间不等时。精确时值请使用 MIDI 或 MusicXML。',''];
    if(score.arrangement)lines.splice(1,0,'伴奏编配：按和弦、重复弦序和可弹指法定稿；不代表原音逐音还原。');
    for(const bar of score.measures){
      lines.push(`第 ${bar.number} 小节 · ${bar.start.toFixed(3)}s · `+bar.segments.map(s=>s.display_shape??s.shape).join(' → '));
      const rows=Array.from({length:6},()=>[]);
      for(const event of bar.events){
        for(let string=1;string<=6;string++){const note=event.notes.find(n=>n.string===string);rows[string-1].push(note?String(note.fret).padStart(2,'-').padEnd(4,'-'):'----');}
      }
      ['e','B','G','D','A','E'].forEach((label,i)=>lines.push(label+'|'+rows[i].join('')+'|'));
      lines.push('起音秒数：'+bar.events.map(e=>e.time.toFixed(3)).join(', '),'');
    }
    return lines.join('\n');
  }
  const api={cleanNotes,finger,grid,timeToBeat,arrange,midiBytes,musicxml,textTab};root.StringspaceTranscription=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(globalThis);
