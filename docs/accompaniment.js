/* Chord-constrained accompaniment: follows acoustic attacks without a neural note model. */
(function(root){
  'use strict';
  const E=root.StringspaceEngine,V=root.StringspaceVerification,T=root.StringspaceTranscription;
  const VERSION='adaptive-arpeggio-v1',cache=new Map(),round=n=>Math.round(n*1000000)/1000000;
  function average(reference,start,end){
    const result=new Float64Array(reference.pitches),rate=reference.sample_rate/reference.hop;
    const lo=Math.max(0,Math.floor(start*rate)),hi=Math.min(reference.rms.length,Math.max(lo+1,Math.ceil(end*rate)));
    for(let i=lo;i<hi;i++)for(let p=0;p<result.length;p++)result[p]+=reference.bands[i*result.length+p]/(hi-lo);
    return result;
  }
  function template(midi){
    if(!cache.has(midi)){
      const a=V.extract(V.pluck(midi,.3)),vector=average(a,.035,.16),norm=Math.hypot(...vector);
      cache.set(midi,{vector:Float64Array.from(vector,x=>x/norm),norm});
    }
    return cache.get(midi);
  }
  function fit(reference,start,end,chord,capo,maxFret,overrideTarget){
    const [r,minor]=E.parse(chord),pcs=[r,(r+(minor?3:4))%12,(r+7)%12],candidates=[];
    const ceiling=Math.max(...E.voicing(E.transpose(chord,-capo)).map((f,i)=>f===null?0:E.OPEN[i]+f+capo));
    for(let midi=overrideTarget?40:40+capo;midi<=(overrideTarget?76:Math.min(88,64+capo+maxFret,ceiling));midi++)if(pcs.includes(midi%12))candidates.push({midi,...template(midi)});
    const target=overrideTarget??average(reference,start+.035,Math.min(start+.16,end)),residual=Float64Array.from(target),weights=new Float64Array(candidates.length);
    const penalty=Math.hypot(...target)*.018;
    for(let loop=0;loop<35;loop++)for(let j=0;j<candidates.length;j++){
      const v=candidates[j].vector;let dot=0;
      for(let p=0;p<v.length;p++)dot+=v[p]*residual[p];
      const next=Math.max(0,weights[j]+dot-penalty),delta=next-weights[j];weights[j]=next;
      for(let p=0;p<v.length;p++)residual[p]-=delta*v[p];
    }
    const ranked=candidates.map((c,i)=>({midi:c.midi,strength:weights[i],gain:weights[i]/c.norm})).sort((a,b)=>b.strength-a.strength);
    const output=ranked.filter(n=>n.strength>=ranked[0].strength*.12&&n.gain>.008&&
      !(n.midi<=52&&n.midi<ranked[0].midi&&n.strength<ranked[0].strength*.4)).slice(0,4);
    output.error=residual.reduce((sum,v)=>sum+v*v,0)/(target.reduce((sum,v)=>sum+v*v,0)||1);return output;
  }
  function chordCandidates(reference,start,end){
    const target=average(reference,start+(end-start)*.45,end-.04);
    return E.CHORDS.map(chord=>({chord,error:fit(reference,start,end,chord,0,12,target).error})).sort((a,b)=>a.error-b.error);
  }
  function rolePitches(chord,capo,phase,style){
    const frets=E.voicing(E.transpose(chord,-capo)),active=frets.map((f,i)=>f===null?null:E.OPEN[i]+f+capo).filter(n=>n!==null);
    const middle=frets[3]===null?active[1]??active[0]:E.OPEN[3]+frets[3]+capo;
    if(phase===0)return [active[0]];
    if(style==='ascending')return [phase===1?middle:active.at(phase===2?-2:-1)];
    return phase===2?active.slice(-2):[middle];
  }
  function patternError(reference,time,pitches){
    const after=average(reference,time+.025,time+.13),before=average(reference,time-.13,time-.045);
    const target=Float64Array.from(after,(v,p)=>Math.max(0,v-before[p]*.7)),residual=Float64Array.from(target);
    const vectors=pitches.map(p=>template(p).vector),weights=pitches.map(()=>0);
    for(let pass=0;pass<20;pass++)for(let j=0;j<vectors.length;j++){
      const v=vectors[j];let dot=0;for(let p=0;p<v.length;p++)dot+=v[p]*residual[p];
      const next=Math.max(0,weights[j]+dot),delta=next-weights[j];weights[j]=next;
      for(let p=0;p<v.length;p++)residual[p]-=delta*v[p];
    }
    return residual.reduce((sum,v)=>sum+v*v,0)/(target.reduce((sum,v)=>sum+v*v,0)||1);
  }
  function learnStyle(reference,measures,capo){
    const errors={pinch:0,ascending:0};let count=0;
    for(const bar of measures.slice(0,16))for(const beat of [2,3].filter(b=>b<bar.beat_times.length-1)){
      const time=bar.beat_times[beat],segment=bar.segments.findLast(s=>time>=s.start-.03);
      if(time>reference.duration-.15||!segment||segment.sounding==='N')continue;
      for(const style of Object.keys(errors))errors[style]+=patternError(reference,time,rolePitches(segment.sounding,capo,beat,style));
      count++;
    }
    return {style:errors.pinch<=errors.ascending?'pinch':'ascending',errors,count};
  }
  function arrange(features,config,title){
    const reference=features.acoustic;
    if(!reference)throw new Error('这份旧作品缺少原音节奏数据，请重新导入音乐。');
    const attacks=(features.attacks||reference.attacks).map(a=>({...a,time:a.time+.025}));
    if(!attacks.length)throw new Error('没有检测到稳定拨弦，请尝试清晰的吉他伴奏音轨。');
    const start=config.offset??attacks[0].time,grid=T.grid({...features,attacks},[{time:start}],config);
    const base=E.arrange({...features,acoustic:null},{...config,offset:start},title),measures=[],ranges=[];
    for(let i=0;grid[i*config.meter]<features.meta.duration-.05;i++){
      const times=grid.slice(i*config.meter,i*config.meter+config.meter+1),end=Math.min(times.at(-1),features.meta.duration),segments=[];
      for(let p=0;p<(config.changes==='half'?2:1);p++){
        const parts=config.changes==='half'?2:1;
        const at=beat=>{const i=Math.floor(beat);return times[i]+(beat-i)*(times[Math.min(i+1,times.length-1)]-times[i]);};
        const from=at(p*config.meter/parts),to=Math.min(end,at((p+1)*config.meter/parts));
        const rate=features.meta.sample_rate/features.meta.hop;segments.push({id:String(ranges.length),start:from,end:to});ranges.push([Math.floor(from*rate),Math.min(features.rms.length,Math.ceil(to*rate))]);
      }
      measures.push({number:i+1,start:round(times[0]),end:round(end),beat_times:times,segments,events:[]});
    }
    const recognized=E.recognize(features,ranges);let segmentIndex=0;const notes=[],lastPitches=new Map(),bassEvidence=[];
    for(const bar of measures)for(const segment of bar.segments){
      const coarse=recognized[segmentIndex++],candidates=chordCandidates(reference,segment.start,segment.end);
      const compatible=candidates.find(c=>c.chord===coarse.chord&&c.error<candidates[0].error+.008);
      const best=compatible??candidates[0],detection=coarse.chord==='N'?coarse:{chord:best.chord,confidence:Math.min(.95,.45+3*(candidates[1].error-candidates[0].error))};
      const chord=config.overrides[segment.id]??detection.chord;
      Object.assign(segment,{sounding:chord,shape:E.transpose(chord,-config.capo),confidence:detection.confidence,edited:Object.hasOwn(config.overrides,segment.id)});
      if(chord!=='N'){
        const observed=fit(reference,segment.start,segment.end,chord,0,12)[0];
        if(observed&&observed.midi<=52)bassEvidence.push(observed);
      }
    }
    const bassTotal=bassEvidence.reduce((sum,n)=>sum+n.strength,0),bassLost=bassEvidence.filter(n=>n.midi<40+config.capo).reduce((sum,n)=>sum+n.strength,0);
    if(bassLost>bassTotal*.02)throw new Error(`变调夹夹 ${config.capo} 品无法保留原音中的低音，请降低品位。`);
    const analysisCapo=base.capo_suggestions[0]?.capo??0;
    const learned=learnStyle(reference,measures,analysisCapo);
    const sequence=measures.flatMap(b=>b.segments);
    const near=(time,step)=>attacks.filter(a=>Math.abs(a.time-time)<step*.17);
    let quarterHits=0,quarterTotal=0;
    for(const bar of measures)if(bar.beat_times.at(-1)<=features.meta.duration+.05)for(let i=0;i<config.meter;i++){
      quarterTotal++;if(near(bar.beat_times[i],bar.beat_times[i+1]-bar.beat_times[i]).length)quarterHits++;
    }
    let inferredAttacks=0,omittedOffbeats=0;
    for(const bar of measures){
      const anchors=bar.beat_times.slice(0,-1).filter((t,i)=>near(t,bar.beat_times[i+1]-t).length).length;
      const barPeak=Math.max(...attacks.filter(a=>a.time>=bar.start-.08&&a.time<bar.end).map(a=>a.strength),0);
      const offbeats=bar.beat_times.slice(0,-1).filter((t,i)=>{
        const step=bar.beat_times[i+1]-t,at=(t+bar.beat_times[i+1])/2,a=near(at,step).sort((x,y)=>Math.abs(x.time-at)-Math.abs(y.time-at))[0];
        if(!a)return false;
        const segment=bar.segments.findLast(s=>a.time>=s.start-.03)??bar.segments[0];
        return segment.sounding!=='N'&&(a.strength>=barPeak*.25||fit(reference,a.time,a.time+step*.8,segment.sounding,analysisCapo,12).some(n=>n.gain>.02&&V.pitchRise(reference,n.midi,a.time)>1.25));
      }).length;
      const regular=quarterHits/quarterTotal>=.85&&anchors>=config.meter-1&&offbeats<2;
      for(let beat=0;beat<config.meter*2;beat++){
        if(config.arpeggio_rhythm==='quarter'&&beat%2)continue;
        const t=bar.beat_times[Math.floor(beat/2)]+(beat%2)*(bar.beat_times[Math.floor(beat/2)+1]-bar.beat_times[Math.floor(beat/2)])/2;
        if(t>=bar.end-.03)continue;
        const step=(bar.beat_times[Math.floor(beat/2)+1]-bar.beat_times[Math.floor(beat/2)]);
        const options=near(t,step).sort((a,b)=>Math.abs(a.time-t)-Math.abs(b.time-t));
        if(config.arpeggio_rhythm==='auto'&&beat%2&&offbeats<2&&(anchors===config.meter||regular)){if(options.length)omittedOffbeats++;continue;}
        const frame=Math.min(reference.rms.length-1,Math.round(t*reference.sample_rate/reference.hop));
        // Complete one masked weak beat only when this bar and the recording
        // strongly support a regular pulse. Two-pick patterns are not doubled.
        const infer=config.arpeggio_rhythm==='auto'&&!options.length&&beat%2===0&&(offbeats===0||regular)&&quarterHits/quarterTotal>=.75&&anchors>=config.meter-1&&reference.rms[frame]>.002;
        if(!options.length&&!infer&&config.arpeggio_rhythm==='auto')continue;
        const attack=config.arpeggio_rhythm==='auto'&&options.length?options[0]:{time:t},segment=bar.segments.findLast(s=>attack.time>=s.start-.03)??bar.segments[0];
        if(segment.sounding==='N')continue;
        const time=Math.max(bar.start,attack.time),fitted=fit(reference,time,Math.min(time+step*.8,features.meta.duration),segment.sounding,analysisCapo,12);
        if(beat%2&&config.arpeggio_rhythm==='auto'){
          if(attack.strength<barPeak*.25&&!fitted.some(n=>n.gain>.02&&V.pitchRise(reference,n.midi,time)>1.25))continue;
        }
        let chosen=fitted.filter(note=>!lastPitches.has(note.midi)||time-lastPitches.get(note.midi)>1.5||V.pitchRise(reference,note.midi,time)>1.1).slice(0,3);
        // A weak middle-string pick can be masked by the bass's harmonics.
        // Keep a simple bass / middle / upper / middle accompaniment role;
        // do not repeatedly pluck the ringing bass just because it is loudest.
        if(!chosen.length&&fitted.length){
          const frets=E.voicing(E.transpose(segment.sounding,-analysisCapo)),middle=frets[3]===null?fitted[0].midi:E.OPEN[3]+frets[3]+analysisCapo;
          const vector=average(reference,time+.035,Math.min(time+.16,features.meta.duration)),basis=template(middle),p=middle-reference.min_midi;
          const gain=Math.max(.02,Math.min(.6,(vector[p]||0)/(basis.vector[p]*basis.norm||1)));
          chosen=[{midi:middle,gain,strength:gain*basis.norm}];
        }
        // A regular four-pick recording is simplified into one consistent
        // right-hand pattern, rather than chasing the loudest ringing partial.
        if(beat%2===0&&offbeats<2&&quarterHits/quarterTotal>=.75){
          let pitches=rolePitches(segment.sounding,analysisCapo,(beat/2)%4,learned.style);
          if(beat===0&&!segment.edited){const bass=fitted.find(n=>n.midi<=52&&n.strength>=fitted[0].strength*.4);if(bass)pitches=[bass.midi];}
          const vector=average(reference,time+.035,Math.min(time+.16,features.meta.duration));
          chosen=pitches.map(midi=>{
            const existing=fitted.find(n=>n.midi===midi),basis=template(midi),p=midi-reference.min_midi;
            const gain=existing?.gain??Math.max(.02,Math.min(.6,(vector[p]||0)/(basis.vector[p]*basis.norm||1)));
            return {midi,gain,strength:gain*basis.norm};
          });
        }
        for(const note of chosen){
          let duration=Math.min(1.5,features.meta.duration-time);
          for(const future of sequence)if(future.start>time+.03&&future.start<time+duration){
            const [r,minor]=future.sounding==='N'?[-1,false]:E.parse(future.sounding);
            if(![r,(r+(minor?3:4))%12,(r+7)%12].includes(note.midi%12)){duration=future.start-time;break;}
          }
          notes.push({...note,time,duration,inferred:infer,amplitude:Math.min(1,note.gain),id:String(notes.length),bar:bar.number});
        }
        if(infer&&chosen.length)inferredAttacks++;
        for(const note of chosen)lastPitches.set(note.midi,time);
      }
    }
    const mapped=T.finger(notes,config.capo,config.max_fret);
    for(const note of mapped.notes){
      const bar=measures[note.bar-1];let event=bar.events.find(e=>Math.abs(e.time-note.time)<.001);
      if(!event){event={time:note.time,beat:round(T.timeToBeat(bar.beat_times,note.time)),duration:.5,direction:null,notes:[]};bar.events.push(event);}
      event.inferred=note.inferred;
      event.notes.push({id:note.id,string:note.string,fret:note.fret,midi:note.midi,gain:note.gain,duration_seconds:note.duration,onset_offset:0});
    }
    const names=['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B'];
    for(const bar of measures){
      bar.events.sort((a,b)=>a.time-b.time);
      for(let i=0;i<bar.events.length;i++){
        const event=bar.events[i],next=bar.events[i+1]?.time??bar.end;
        event.duration=round(T.timeToBeat(bar.beat_times,next)-event.beat);
      }
      for(const segment of bar.segments){
        const first=bar.events.find(e=>e.time>=segment.start-.001&&e.time<segment.end),low=first?.notes.reduce((a,b)=>a.midi<b.midi?a:b);
        if(low&&low.midi<53){
          segment.bass_midi=low.midi;
          if(low.midi%12!==E.parse(segment.sounding)[0]){
            segment.display_shape=segment.shape+'/'+names[(low.midi-config.capo+120)%12];
            segment.display_sounding=segment.sounding+'/'+names[low.midi%12];
          }
        }
      }
    }
    const unique=[...new Set(measures.flatMap(b=>b.segments).map(s=>s.shape).filter(s=>s!=='N'))];
    const lowest=bassEvidence.length?Math.min(...bassEvidence.map(n=>n.midi)):40;
    return {...base,config,offset:start,measures,chords:unique.map(name=>({name,frets:E.voicing(name),sounding:E.transpose(name,config.capo)})),beat_times:grid,performance_notes:mapped.notes,algorithm:VERSION,
      capo_suggestions:base.capo_suggestions.filter(s=>s.capo<=lowest-40),review_count:sequence.filter(s=>s.confidence<.55&&!s.edited&&s.sounding!=='N').length,
      accompaniment:{version:VERSION,mode:config.arpeggio_rhythm==='auto'?'audio-guided':'fixed-rhythm',right_hand_pattern:learned.style,analysis_capo:analysisCapo,inferred_attacks:inferredAttacks,omitted_offbeats:omittedOffbeats,attacks:measures.reduce((s,b)=>s+b.events.length,0),notes:mapped.notes.length,unmapped_notes:mapped.dropped},
      warnings:[config.arpeggio_rhythm==='auto'?'按原音的起音节奏与和弦音进行简化分解，未使用神经网络逐音转录。':'按手动选择的分解疏密重新编配节奏。','简化会省略装饰音，自动和弦和弦位仍需校对。']};
  }
  const api={VERSION,average,fit,chordCandidates,rolePitches,learnStyle,arrange};root.StringspaceAccompaniment=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(globalThis);
