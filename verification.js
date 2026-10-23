/* Independent audio comparison. Neither neural notes nor chord labels are a reference. */
(function(root){
  'use strict';
  const E=root.StringspaceEngine,VERSION='audio-comparison-v1';
  const MIN=40,COUNT=49,HOP=256,SIZE=4096,RATE=22050;
  // Conservative engineering limits, not calibrated probabilities of musical accuracy.
  const LIMITS=Object.freeze({precision:.9,recall:.9,count_error:.1,timing_p95:.08,pitch_similarity:.9,matching_tolerance:.15});
  const round=n=>Math.round(n*10000)/10000;
  function extract(samples,sampleRate=RATE){
    if(sampleRate!==RATE)throw new Error('声学对照需要 22050 Hz 音轨。');
    const frames=Math.ceil(samples.length/HOP),bands=new Float32Array(frames*COUNT),rms=new Float32Array(frames);
    const fft=new E.FFT(SIZE),bins=Array.from({length:COUNT},(_,i)=>{
      const frequency=440*2**((MIN+i-69)/12),center=frequency*SIZE/sampleRate;
      return {lo:Math.max(1,Math.floor(center*2**(-.4/12))),hi:Math.ceil(center*2**(.4/12))};
    });
    for(let frame=0;frame<frames;frame++){
      fft.transform(samples,frame*HOP);
      for(let p=0;p<COUNT;p++){
        let peak=0;for(let b=bins[p].lo;b<=bins[p].hi;b++)peak=Math.max(peak,Math.hypot(fft.real[b],fft.imag[b]));
        bands[frame*COUNT+p]=peak;
      }
      let energy=0;for(let j=frame*HOP;j<Math.min(samples.length,(frame+1)*HOP);j++)energy+=samples[j]**2;
      rms[frame]=Math.sqrt(energy/HOP);
    }
    return {version:VERSION,sample_rate:sampleRate,hop:HOP,min_midi:MIN,pitches:COUNT,
      duration:samples.length/sampleRate,bands,rms,attacks:E.detectAttacks(samples,sampleRate)};
  }
  // Only a rise in this pitch's acoustic band can support a same-pitch retrigger.
  // A different string being plucked is insufficient evidence to pluck a ringing note again.
  function pitchRise(reference,midi,time){
    const p=midi-reference.min_midi;if(p<0||p>=reference.pitches)return null;
    const mean=(from,to)=>{
      let total=0,count=0;
      for(let i=Math.max(0,Math.floor(from*reference.sample_rate/reference.hop));i<Math.min(reference.rms.length,Math.ceil(to*reference.sample_rate/reference.hop));i++){
        total+=reference.bands[i*reference.pitches+p];count++;
      }
      return total/Math.max(1,count);
    };
    const before=mean(time-.14,time-.055),after=mean(time+.025,time+.11);
    return after/Math.max(before,1e-8);
  }
  // Stable analysis dictionary. Keep it separate from the audible instrument:
  // changing playback timbre must not change already recognized notes/chords.
  function pluck(midi,duration,sampleRate=RATE){
    const length=Math.ceil(sampleRate*Math.min(Math.max(.01,duration),6)),out=new Float32Array(length);
    const frequency=440*2**((midi-69)/12),harmonics=[1,.42,.24,.16,.12,.08];
    // Explicit fundamental avoids random noise excitation occasionally producing
    // a barely audible fundamental and an overwhelmingly loud overtone.
    for(let h=1;h<=harmonics.length&&frequency*h<sampleRate*.48;h++){
      const angle=2*Math.PI*frequency*h/sampleRate,ca=Math.cos(angle),sa=Math.sin(angle);
      const decay=Math.exp(-(1.8+h*.55)/sampleRate);let x=1,y=0;
      for(let i=0;i<length;i++){
        out[i]+=y*harmonics[h-1]*.35;
        const next=(x*ca-y*sa)*decay;y=(x*sa+y*ca)*decay;x=next;
      }
    }
    for(let i=0;i<length;i++)out[i]*=Math.min(1,i/(sampleRate*.003))*Math.min(1,Math.max(0,(duration-i/sampleRate)/.04));
    return out;
  }
  function scoreNotes(score){
    return score.measures.flatMap(bar=>{
      const notes=bar.events.flatMap(event=>event.notes.map((note,index)=>({
        midi:note.midi,time:event.time+(note.onset_offset??(event.direction?index*.012:0)),
        duration:note.duration_seconds??event.duration_seconds??event.duration*60/score.bpm,
        level:note.gain??.35/Math.sqrt(event.notes.length)})));
      if(score.accompaniment){
        // Harmonic fitting can severely underestimate a middle string under a
        // ringing bass. Compress the practice playback's dynamic range rather
        // than turning those visible notes into almost inaudible attacks.
        // Keep the strongest note, explicit silence, and the raw score intact.
        const anchor=Math.max(0,...notes.map(note=>note.level));
        for(const note of notes)if(note.level>0)note.level=Math.min(note.level*4,Math.sqrt(note.level*anchor));
      }
      return notes;
    });
  }
  const rendererVersion=score=>(root.StringspaceGuitar?.VERSION??'additive-v1')+(score.accompaniment?'-balanced-v1':'');
  function render(score,sampleRate=RATE){
    const audio=new Float32Array(Math.ceil(score.duration*sampleRate));
    for(const note of scoreNotes(score)){
      const sound=(root.StringspaceGuitar?.pluck??pluck)(note.midi,note.duration,sampleRate),start=Math.round(note.time*sampleRate);
      for(let i=Math.max(0,-start);i<sound.length&&start+i<audio.length;i++)audio[start+i]+=sound[i]*note.level;
    }
    let peak=0;for(const sample of audio)peak=Math.max(peak,Math.abs(sample));
    if(peak>.98)for(let i=0;i<audio.length;i++)audio[i]*=.98/peak;
    return audio;
  }
  function performedAttacks(score){
    // These are the renderer's actual excitation times. Do not rediscover them
    // from synthetic audio: a note release can otherwise be counted as a pick.
    const times=scoreNotes(score).map(n=>n.time).sort((a,b)=>a-b),attacks=[];
    for(const time of times)if(!attacks.length||time-attacks.at(-1).time>.075)attacks.push({time});
    return attacks;
  }
  function matchAttacks(reference,generated,tolerance=LIMITS.matching_tolerance){
    const used=new Set(),errors=[];let hits=0;
    for(const a of reference){
      let best=-1,distance=tolerance+1e-9;
      for(let j=0;j<generated.length;j++)if(!used.has(j)){
        const delta=Math.abs(a.time-generated[j].time);if(delta<distance){distance=delta;best=j;}
      }
      if(best>=0){used.add(best);hits++;errors.push(distance);}
    }
    errors.sort((a,b)=>a-b);
    const precision=generated.length?hits/generated.length:reference.length?0:1;
    const recall=reference.length?hits/reference.length:generated.length?0:1;
    return {reference_attacks:reference.length,generated_attacks:generated.length,matched_attacks:hits,
      extra_attacks:generated.length-hits,missing_attacks:reference.length-hits,
      precision:round(precision),recall:round(recall),count_error:round(Math.abs(generated.length-reference.length)/Math.max(1,reference.length)),
      timing_p95:errors.length?round(errors[Math.ceil(errors.length*.95)-1]):null};
  }
  function compare(reference,generated,ranges){
    const peak=Math.max(...reference.rms),floor=Math.max(.0001,peak*.025);
    function section(start,end){
      // A large FFT window is used for pitch bands; onset comparison uses its own short-window detector.
      const attacks=matchAttacks(reference.attacks.filter(a=>a.time>=start&&a.time<end),generated.attacks.filter(a=>a.time>=start&&a.time<end));
      let sum=0,weight=0,active=0;
      const lo=Math.max(0,Math.floor(start*RATE/HOP)),hi=Math.min(reference.rms.length,Math.ceil(end*RATE/HOP));
      for(let frame=lo;frame<hi;frame++){
        if(reference.rms[frame]<floor&&generated.rms[frame]<floor)continue;
        let dot=0,a2=0,b2=0;
        for(let p=0;p<COUNT;p++){
          // Square root limits the dominance of a loud bass; octave bins stay separate.
          const a=Math.sqrt(reference.bands[frame*COUNT+p]||0),b=Math.sqrt(generated.bands[frame*COUNT+p]||0);
          dot+=a*b;a2+=a*a;b2+=b*b;
        }
        const w=Math.sqrt(Math.max(reference.rms[frame],floor));
        sum+=(dot*dot/(a2*b2||1e-20))*w;weight+=w;active++;
      }
      const pitch=weight?sum/weight:0;
      const failures=[];
      if(attacks.precision<LIMITS.precision)failures.push('多余起音');
      if(attacks.recall<LIMITS.recall)failures.push('漏掉起音');
      if(attacks.count_error>LIMITS.count_error)failures.push('起音数量不符');
      if(attacks.timing_p95===null||attacks.timing_p95>LIMITS.timing_p95)failures.push('起音未对齐');
      if(pitch<LIMITS.pitch_similarity)failures.push('音高谱差异');
      return {start:round(start),end:round(end),...attacks,pitch_similarity:round(pitch),compared_frames:active,failures,passed:failures.length===0};
    }
    const overall=section(0,reference.duration);
    const sections=ranges.map(range=>({...range,...section(range.start,range.end)}));
    // Silent sections need no timing match but still cannot contain generated attacks.
    for(const row of sections)if(!row.reference_attacks&&!row.generated_attacks&&!row.compared_frames){row.failures=[];row.passed=true;}
    return {version:VERSION,status:overall.passed&&sections.every(s=>s.passed)?'passed':'failed',musical_accuracy:'unverified',
      thresholds:{...LIMITS},overall,sections,
      onset_method:'原音：独立频谱起音检测（估计）；生成音：共享合成器的实际激励时刻，75ms 内视为同一次拨弦。',
      pitch_method:'40–88 MIDI 半音频带，幅值平方根压缩，逐帧平方余弦，按原音能量加权；保留原时间轴。',
      scope:'原音与实际合成音逐段声学对照；音高谱相似度不是音符准确率，也不能保证听感还原。'};
  }
  function verify(score,reference){
    const generated=extract(render(score));
    generated.attacks=performedAttacks(score);
    // Include the first attack, which a centered onset detector places slightly before the note timestamp.
    const ranges=score.measures.map((bar,i)=>({measure:bar.number,start:i?bar.start-.08:0,
      end:i+1<score.measures.length?score.measures[i+1].start-.08:score.duration}));
    const comparison=compare(reference,generated,ranges);
    comparison.renderer_version=rendererVersion(score);
    if(score.accompaniment)comparison.estimation_note='简化分解使用原音起音检测作节奏输入，起音对比核验编配是否额外加密或错位，不是独立的识别准确率评估。';
    return comparison;
  }
  function wav(samples,sampleRate=RATE){
    const bytes=new ArrayBuffer(44+samples.length*2),view=new DataView(bytes);
    const text=(at,value)=>[...value].forEach((c,i)=>view.setUint8(at+i,c.charCodeAt(0)));
    text(0,'RIFF');view.setUint32(4,36+samples.length*2,true);text(8,'WAVE');text(12,'fmt ');
    view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,sampleRate,true);
    view.setUint32(28,sampleRate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,samples.length*2,true);
    for(let i=0;i<samples.length;i++)view.setInt16(44+i*2,Math.max(-32767,Math.min(32767,Math.round(samples[i]*32767))),true);
    return bytes;
  }
  const prepare=()=>root.StringspaceGuitar?.load()??Promise.resolve();
  const api={VERSION,LIMITS,extract,pitchRise,pluck,prepare,rendererVersion,scoreNotes,render,performedAttacks,matchAttacks,compare,verify,wav};
  root.StringspaceVerification=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(globalThis);
