/* Chord-constrained accompaniment: follows acoustic attacks without a neural note model. */
(function(root){
  'use strict';
  const E=root.StringspaceEngine,V=root.StringspaceVerification,T=root.StringspaceTranscription;
  const M=root.StringspaceArrangement??(typeof module!=='undefined'&&module.exports?require('./arrangement.js'):null);
  const VERSION='adaptive-arpeggio-v3',cache=new Map(),round=n=>Math.round(n*1000000)/1000000;
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
  function power(reference,start,end){
    const rate=reference.sample_rate/reference.hop;let total=0,count=0;
    for(let i=Math.max(0,Math.floor(start*rate));i<Math.min(reference.rms.length,Math.ceil(end*rate));i++){
      total+=reference.rms[i]**2;count++;
    }
    return total/Math.max(1,count);
  }
  function excitation(reference,time){
    // Predict each ringing partial's decay independently. A bass fundamental
    // and its higher partials do not decay at the same speed.
    const early=average(reference,time-.22,time-.14),before=average(reference,time-.13,time-.045),after=average(reference,time+.025,time+.13);
    const residual=Float64Array.from(after,(v,p)=>{
      const decay=Math.max(-12,Math.min(0,Math.log((before[p]+1e-8)/(early[p]+1e-8))/.09));
      return Math.max(0,v-before[p]*Math.exp(decay*.15));
    });
    return {residual,after,ratio:Math.hypot(...residual)/Math.max(1e-8,Math.hypot(...after)),
      rms:Math.sqrt(power(reference,time+.015,Math.min(reference.duration,time+.125)))};
  }
  function fitPitches(target,pitches){
    const vectors=pitches.map(p=>template(p).vector),weights=pitches.map(()=>0),residual=Float64Array.from(target);
    for(let pass=0;pass<30;pass++)for(let j=0;j<vectors.length;j++){
      const v=vectors[j];let dot=0;for(let p=0;p<v.length;p++)dot+=v[p]*residual[p];
      const next=Math.max(0,weights[j]+dot),delta=next-weights[j];weights[j]=next;
      for(let p=0;p<v.length;p++)residual[p]-=delta*v[p];
    }
    return {weights,error:residual.reduce((sum,x)=>sum+x*x,0)/(target.reduce((sum,x)=>sum+x*x,0)||1)};
  }
  function support(onset,pitches){
    const fitted=fitPitches(onset.residual,pitches);
    return {...fitted,confidence:onset.ratio>.025?Math.max(0,1-fitted.error):0};
  }
  function sustain(reference,time,midi,limit,uncertain,nextPick){
    const bounded=value=>Math.max(.001,Math.min(limit,Math.max(.06,value)));
    if(uncertain)return {duration:bounded(nextPick-time),method:'until-next-pick'};
    const indices=[];
    for(let h=1;h<=5;h++){
      const p=Math.round(midi+12*Math.log2(h))-reference.min_midi;
      if(p>=0&&p<reference.pitches)indices.push({p,weight:1/(h*h)});
    }
    const rate=reference.sample_rate/reference.hop;
    const level=frame=>indices.reduce((sum,{p,weight})=>sum+(reference.bands[frame*reference.pitches+p]||0)*weight,0);
    const mean=(from,to)=>{let total=0,count=0;for(let i=Math.max(0,Math.floor(from*rate));i<Math.min(reference.rms.length,Math.ceil(to*rate));i++){total+=level(i);count++;}return total/Math.max(1,count);};
    const baseline=mean(time-.13,time-.045),early=mean(time-.22,time-.14);
    const decay=Math.max(-12,Math.min(0,Math.log((baseline+1e-8)/(early+1e-8))/.09));
    const signal=frame=>Math.max(0,level(frame)-baseline*Math.exp(decay*(frame/rate-time+.0875)));
    const start=Math.max(0,Math.ceil((time+.035)*rate)),end=Math.min(reference.rms.length,Math.ceil((time+limit)*rate));
    let peak=0;for(let i=start;i<Math.min(end,Math.ceil((time+.14)*rate));i++)peak=Math.max(peak,signal(i));
    if(!peak)return {duration:bounded(nextPick-time),method:'until-next-pick'};
    let quiet=0;
    for(let i=Math.ceil((time+.14)*rate);i<end;i++){
      const smoothed=(signal(i)+signal(Math.max(start,i-1))+signal(Math.max(start,i-2)))/3;
      quiet=smoothed<peak*.18?quiet+1:0;
      if(quiet>=4)return {duration:bounded((i-quiet+1)/rate-time),method:'harmonic-envelope'};
    }
    return {duration:limit,method:'harmonic-envelope'};
  }
  function dynamics(onset,pitches){
    // Reconstruct the simplified pick's loudness from the local source envelope,
    // independently of uncertain pitch coefficients. Never use a minimum gain.
    // The instrument's RMS calibration converts source amplitude into playback gain.
    const fit=fitPitches(onset.residual,pitches),maximum=Math.max(...fit.weights,0);
    const reliable=fit.error<.55&&maximum>0&&fit.weights.every(w=>w>=maximum*.25);
    const mixture=fitPitches(onset.after,pitches);
    const weights=reliable?fit.weights:Math.hypot(...mixture.weights)>0?mixture.weights:pitches.map(()=>1),norm=Math.hypot(...weights);
    return {gains:weights.map((w,i)=>onset.rms*w/(norm*V.instrumentRMS(pitches[i]))),
      method:reliable?'source-envelope-and-partials':'source-envelope-and-mixture-partials',inferred:!reliable};
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
    let inferredAttacks=0,omittedOffbeats=0,rejectedGrid=0,rejectedOnsets=0;
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
        let onset=excitation(reference,time);
        // An onset-detector candidate is not sufficient if the audio contains
        // only the predicted decay of a previously plucked string.
        if(config.arpeggio_rhythm==='auto'&&onset.ratio<.015){
          if(infer)rejectedGrid++;else rejectedOnsets++;continue;
        }
        if(beat%2&&config.arpeggio_rhythm==='auto'){
          if(attack.strength<barPeak*.25&&!fitted.some(n=>n.gain>.02&&V.pitchRise(reference,n.midi,time)>1.25))continue;
        }
        const novel=fit(reference,time,Math.min(time+step*.8,features.meta.duration),segment.sounding,analysisCapo,12,onset.residual);
        let pitches=novel.filter(note=>!lastPitches.has(note.midi)||V.pitchRise(reference,note.midi,time)>1.1).slice(0,3).map(n=>n.midi);
        let pitchSource='spectral-innovation';
        // The learned hand pattern is a prior, not an observation of a note.
        // Strong incompatible pitch evidence can override it; ambiguity is flagged.
        if(beat%2===0&&offbeats<2&&quarterHits/quarterTotal>=.75){
          pitches=rolePitches(segment.sounding,analysisCapo,(beat/2)%4,learned.style);pitchSource=segment.edited?'manual-chord':'hand-pattern';
          if(beat===0&&!segment.edited){const bass=fitted.find(n=>n.midi<=52&&n.strength>=fitted[0].strength*.4);if(bass)pitches=[bass.midi];}
          const expected=support(onset,pitches),alternative=novel[0];
          if(!segment.edited&&beat!==0&&alternative&&pitches.length===1&&alternative.midi%12!==pitches[0]%12&&
            novel.error<.4&&expected.error>.75&&V.pitchRise(reference,alternative.midi,time)>1.5&&
            (alternative.midi>52||!lastPitches.has(alternative.midi))){pitches=[alternative.midi];pitchSource='spectral-innovation';}
        }
        if(!pitches.length){
          pitches=rolePitches(segment.sounding,analysisCapo,Math.floor(beat/2)%4,learned.style);pitchSource='hand-pattern';
        }
        const evidence=support(onset,pitches);
        // A regular grid plus ringing audio is not evidence of another pick.
        if(infer&&onset.ratio<.025){rejectedGrid++;continue;}
        if(config.arpeggio_rhythm!=='auto'&&onset.rms<1e-5){
          const closest=attacks.reduce((best,a)=>Math.abs(a.time-time)<Math.abs(best.time-time)?a:best);
          onset=excitation(reference,closest.time);
        }
        if(onset.rms<1e-5)continue;
        const levels=dynamics(onset,pitches);
        const nextPick=attacks.find(a=>a.time>time+.075)?.time??Math.min(features.meta.duration,time+step);
        for(let i=0;i<pitches.length;i++){
          const pitchInferred=!segment.edited&&(evidence.confidence<.55||evidence.weights[i]<Math.max(...evidence.weights)*.15);
          const midi=pitches[i];let limit=Math.min(4,features.meta.duration-time);
          for(const future of sequence)if(future.start>time+.03&&future.start<time+limit){
            const [r,minor]=future.sounding==='N'?[-1,false]:E.parse(future.sounding);
            if(![r,(r+(minor?3:4))%12,(r+7)%12].includes(midi%12)){limit=future.start-time;break;}
          }
          const envelope=sustain(reference,time,midi,limit,pitchInferred,nextPick),gain=levels.gains[i];
          if(!Number.isFinite(gain)||gain<=0)continue;
          notes.push({midi,gain,time,duration:envelope.duration,inferred:infer||pitchInferred,attack_inferred:infer,pitch_inferred:pitchInferred,
            attack_source:config.arpeggio_rhythm!=='auto'?'manual-grid':infer?'spectral-grid':'detected',
            pitch_source:pitchSource,pitch_confidence:round(evidence.confidence),dynamics_method:levels.method,dynamics_inferred:levels.inferred,
            duration_method:envelope.method,amplitude:Math.min(1,gain),id:String(notes.length),bar:bar.number});
        }
        if(infer&&pitches.length)inferredAttacks++;
        for(const midi of pitches)lastPitches.set(midi,time);
      }
    }
    const mapped=T.finger(notes,config.capo,config.max_fret);
    for(const note of mapped.notes){
      const bar=measures[note.bar-1];let event=bar.events.find(e=>Math.abs(e.time-note.time)<.001);
      if(!event){event={time:note.time,beat:round(T.timeToBeat(bar.beat_times,note.time)),duration:.5,direction:null,notes:[]};bar.events.push(event);}
      event.inferred=event.inferred||note.inferred;event.attack_inferred=note.attack_inferred;event.pitch_inferred=event.pitch_inferred||note.pitch_inferred;event.attack_source=note.attack_source;
      event.notes.push({id:note.id,string:note.string,fret:note.fret,midi:note.midi,gain:note.gain,duration_seconds:note.duration,onset_offset:0,
        pitch_inferred:note.pitch_inferred,pitch_source:note.pitch_source,pitch_confidence:note.pitch_confidence,
        dynamics_method:note.dynamics_method,dynamics_inferred:note.dynamics_inferred,duration_method:note.duration_method});
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
    if(!M)throw new Error('伴奏编配组件未加载，请刷新页面。');
    return M.finalize({...base,config,offset:start,measures,chords:unique.map(name=>({name,frets:E.voicing(name),sounding:E.transpose(name,config.capo)})),beat_times:grid,performance_notes:mapped.notes,algorithm:VERSION,
      capo_suggestions:base.capo_suggestions.filter(s=>s.capo<=lowest-40),review_count:sequence.filter(s=>s.confidence<.55&&!s.edited&&s.sounding!=='N').length,
      accompaniment:{version:VERSION,dynamics:'onset-envelope-v1',mode:config.arpeggio_rhythm==='auto'?'audio-guided':'fixed-rhythm',right_hand_pattern:learned.style,analysis_capo:analysisCapo,inferred_attacks:inferredAttacks,
        inferred_pitch_events:measures.reduce((s,b)=>s+b.events.filter(e=>e.pitch_inferred).length,0),rejected_grid_picks:rejectedGrid,rejected_onsets:rejectedOnsets,
        omitted_offbeats:omittedOffbeats,attacks:measures.reduce((s,b)=>s+b.events.length,0),notes:mapped.notes.length,unmapped_notes:mapped.dropped},
      warnings:[config.arpeggio_rhythm==='auto'?'按原音的起音节奏与和弦音进行简化分解，未使用神经网络逐音转录。':'按手动选择的分解疏密重新编配节奏。','编配定稿不等于原音逐音还原，和弦仍可手动校对。']});
  }
  const api={VERSION,average,fit,chordCandidates,rolePitches,learnStyle,excitation,support,dynamics,sustain,arrange};root.StringspaceAccompaniment=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(globalThis);
