/* Musical decisions for simplified accompaniment; not confirmation of source notes. */
(function(root){
  'use strict';
  const VERSION='musical-arrangement-v1',E=root.StringspaceEngine,T=root.StringspaceTranscription;
  const same=(a,b)=>a.length===b.length&&[...a].sort((x,y)=>x-y).every((x,i)=>x===[...b].sort((x,y)=>x-y)[i]);
  function tones(chord){const [r,minor]=E.parse(chord);return [r,(r+(minor?3:4))%12,(r+7)%12];}
  function playable(midi,config){return E.OPEN.some(open=>midi-open-config.capo>=0&&midi-open-config.capo<=config.max_fret);}
  function role(score,segment,beat,dense){
    const capo=score.accompaniment.analysis_capo??score.config.capo,shape=E.transpose(segment.sounding,-capo),frets=E.voicing(shape);
    const active=frets.flatMap((f,i)=>f===null?[]:[E.OPEN[i]+f+capo]);
    if(Math.abs(beat)<.18&&segment.bass_midi!==undefined)return [segment.bass_midi];
    if(dense){
      const event=E.noteEvents(shape,capo,'arpeggio','folk',score.config.meter,0,score.config.meter,'eighth')
        .find(e=>Math.abs(e.beat-Math.round(beat*2)/2)<.01);
      return event?.notes.map(n=>n.midi)??[active[0]];
    }
    const phase=Math.round(beat)%4,middle=frets[3]===null?(active[1]??active[0]):E.OPEN[3]+frets[3]+capo;
    if(phase===0)return [active[0]];
    if(score.accompaniment.right_hand_pattern==='ascending')return [phase===1?middle:active.at(phase===2?-2:-1)];
    return phase===2?active.slice(-2):[middle];
  }
  function fitRole(pitches,segment,config,previous){
    const pcs=tones(segment.sounding),available=[];
    for(let midi=40+config.capo;midi<=64+config.capo+config.max_fret;midi++)if(pcs.includes(midi%12)&&playable(midi,config))available.push(midi);
    const chosen=[];
    for(const target of pitches){
      const candidates=available.filter(m=>!chosen.includes(m));
      candidates.sort((a,b)=>{
        const cost=m=>Math.abs(m-target)+(m%12===target%12?0:5)+Math.min(12,Math.abs(m-(previous??target)))*.03;
        return cost(a)-cost(b);
      });
      if(candidates.length)chosen.push(candidates[0]);
    }
    return chosen;
  }
  function finalize(input){
    if(!input.accompaniment)return input;
    if(input.arrangement?.version===VERSION)return input;
    const score=structuredClone(input),original=structuredClone(input.performance_notes),audit=[];
    const config=score.config;let previous=null;
    for(const bar of score.measures){
      const dense=bar.events.length>config.meter||bar.events.filter(e=>Math.abs(e.beat-Math.round(e.beat))>.18).length>=2;
      for(const event of bar.events){
        const source={time:event.time,beat:event.beat,notes:structuredClone(event.notes)},reasons=[],issues=[];
        const segment=bar.segments.findLast(s=>event.time>=s.start-.03)??bar.segments[0];
        if(!segment||segment.sounding==='N')issues.push('此处和弦或休止需要确认');
        let pcs=[];try{if(segment&&segment.sounding!=='N')pcs=tones(segment.sounding);}catch{issues.push('不支持的和弦');}
        const inTime=event.time>=bar.start-.001&&event.time<bar.end&&event.beat>=-.01&&event.beat<config.meter&&
          Math.abs(event.beat-Math.round(event.beat*2)/2)<=.18;
        if(!inTime)issues.push('节奏位置不适合当前八分音符织体');
        const harmonic=pcs.length&&event.notes.every(n=>pcs.includes(n.midi%12));
        const uncertain=!!event.inferred;
        let intended=event.notes.map(n=>n.midi);
        if(!issues.length&&(uncertain||!harmonic)){
          intended=fitRole(role(score,segment,event.beat,dense),segment,config,previous);
          reasons.push(dense?'按八次分解的弦序编配':score.accompaniment.right_hand_pattern==='ascending'?'按低音至高音的逐弦型编配':'按低音—中弦—高双音—中弦编配');
        }
        if(!intended.length)issues.push('当前品位范围无法安排和弦音');
        const changed=!same(intended,event.notes.map(n=>n.midi));
        if(!issues.length&&changed){
          const power=event.notes.reduce((sum,n)=>sum+(n.gain*root.StringspaceVerification.instrumentRMS(n.midi))**2,0);
          const duration=Math.min(...event.notes.map(n=>n.duration_seconds)),base=event.notes[0];
          event.notes=intended.map((midi,i)=>({...base,id:base.id+'-arr-'+i,midi,
            gain:Math.sqrt(power/intended.length)/root.StringspaceVerification.instrumentRMS(midi),duration_seconds:duration}));
          reasons.push('调整和弦音与音区，使重复织体和指法一致');
        }else if(!issues.length)reasons.push('保留符合和弦与织体的现有音符');
        if(!issues.length&&Math.abs(event.beat)<.18&&segment.bass_midi!==undefined)reasons.push('保留转位低音走向');
        if(!issues.length)reasons.push('保持原有拨弦次数与时间');
        event.arrangement={status:issues.length?'needs-review':'resolved',basis:reasons,issues,changed,
          source_uncertain:uncertain,source_attack_inferred:!!event.attack_inferred,source_pitch_inferred:!!event.pitch_inferred};
        if(uncertain||changed)audit.push({measure:bar.number,time:event.time,source,decision:structuredClone(event.arrangement),pitches:event.notes.map(n=>n.midi)});
        previous=event.notes.at(-1)?.midi??previous;
      }
    }
    // Re-finger the actual edited notes, then use this same performance for TAB,
    // browser audio, MIDI and MusicXML. Source diagnostics stay in separate fields.
    const performance=[];
    for(const bar of score.measures)for(const event of bar.events)for(const note of event.notes){
      const before=input.performance_notes.find(n=>n.id===note.id)??input.performance_notes.find(n=>Math.abs(n.time-event.time)<.001);
      performance.push({...before,...note,time:event.time,duration:note.duration_seconds,amplitude:Math.min(1,note.gain),bar:bar.number});
    }
    const mapped=T.finger(performance,config.capo,config.max_fret),byId=new Map(mapped.notes.map(n=>[n.id,n]));
    if(mapped.dropped){
      // Never leave TAB/audio playing a note that MIDI/XML silently dropped.
      const safe=structuredClone(input);
      for(const bar of safe.measures)for(const event of bar.events)event.arrangement={status:'needs-review',changed:false,
        source_uncertain:!!event.inferred,basis:[],issues:['当前指法范围无法完整安排这些音符，请扩大品位范围']};
      safe.arrangement={version:VERSION,type:'simplified-accompaniment',status:'needs-review',resolved_events:0,
        pending_events:safe.measures.reduce((n,b)=>n+b.events.length,0),source_uncertain_events:audit.filter(a=>a.decision.source_uncertain).length,
        resolved_source_events:0,changed_events:0,unmapped_notes:mapped.dropped,audit:[],scope:'编配未完成，保留原结果供校对。'};
      return safe;
    }
    let pending=0,resolved=0,sourceUncertain=0,changedEvents=0;
    for(const bar of score.measures)for(const event of bar.events){
      for(const note of event.notes){
        const assigned=byId.get(note.id);
        if(assigned)Object.assign(note,{string:assigned.string,fret:assigned.fret,duration_seconds:assigned.duration});
        else event.arrangement.issues.push('有音符无法分配到六根琴弦');
      }
      const frets=event.notes.map(n=>n.fret).filter(f=>f>0),strings=event.notes.map(n=>n.string);
      if(new Set(strings).size!==strings.length||frets.length&&Math.max(...frets)-Math.min(...frets)>4)event.arrangement.issues.push('同拍指法跨度需要校对');
      if(event.notes.some(n=>!playable(n.midi,config)||E.OPEN[6-n.string]+n.fret+config.capo!==n.midi))event.arrangement.issues.push('指法与响音不一致');
      if(event.notes.some(n=>!Number.isFinite(n.gain)||n.gain<=0||n.duration_seconds<=0||event.time+n.duration_seconds>score.duration+.001))event.arrangement.issues.push('音量或时值需要校对');
      event.arrangement.status=event.arrangement.issues.length?'needs-review':'resolved';
      if(event.arrangement.status==='needs-review')pending++;else resolved++;
      if(event.inferred)sourceUncertain++;
      if(event.arrangement.changed)changedEvents++;
    }
    // Finish the audit after physical string assignment, so its decisions match the score.
    for(const row of audit){const event=score.measures.find(b=>b.number===row.measure).events.find(e=>e.time===row.time);row.decision=structuredClone(event.arrangement);row.notes=structuredClone(event.notes);}
    score.analysis_performance_notes=original;score.performance_notes=mapped.notes;
    score.arrangement={version:VERSION,type:'simplified-accompaniment',status:pending||mapped.dropped||score.accompaniment.unmapped_notes?'needs-review':'ready',
      resolved_events:resolved,pending_events:pending,source_uncertain_events:sourceUncertain,resolved_source_events:sourceUncertain-audit.filter(a=>a.decision.source_uncertain&&a.decision.status!=='resolved').length,
      changed_events:changedEvents,unmapped_notes:mapped.dropped,audit,
      scope:'按给定和弦、节奏织体与可弹指法作出的伴奏编配决定，不表示原音中的音符已经确认。'};
    return score;
  }
  const api={VERSION,finalize};root.StringspaceArrangement=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(globalThis);
