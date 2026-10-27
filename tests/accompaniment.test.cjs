const test=require('node:test'),assert=require('node:assert/strict');
const {Midi}=require('@tonejs/midi');
const E=require('../static/engine.js'),V=require('../static/verification.js'),T=require('../static/transcription.js');
require('../static/accompaniment.js');
const A=globalThis.StringspaceAccompaniment;
function recording(count=4,pitches=[[48],[55],[60,64],[55]],times=null){
  // An independent guitar-like fixture with annotated attacks, not the app's synth.
  const sr=22050,samples=new Float32Array(Math.round(sr*2.3));
  for(let pick=0;pick<count;pick++){
    const start=times?.[pick]??.1+pick*2/count,duration=count===8?.18:.36;
    for(let i=0;i<sr*duration;i++){
      const t=i/sr,envelope=Math.min(1,t/.004)*Math.exp(-3*t)*Math.min(1,(duration-t)/.02);
      for(const midi of pitches[pick%4]){
        const f=440*2**((midi-69)/12);
        samples[Math.round(start*sr)+i]+=.15*envelope*(Math.sin(2*Math.PI*f*t)+.4*Math.sin(4*Math.PI*f*t)+.2*Math.sin(6*Math.PI*f*t));
      }
    }
  }
  const f=E.analyze(samples);f.acoustic=V.extract(samples);return f;
}
test('manual quarter/eighth patterns are explicit, including half bars and 3/4',()=>{
  assert.equal(E.noteEvents('G',1,'arpeggio','folk',4).length,4);
  assert.equal(E.noteEvents('G',1,'arpeggio','folk',4,0,4,'eighth').length,8);
  for(const meter of [3,4])for(const rhythm of ['quarter','eighth']){
    const full=E.noteEvents('C',0,'arpeggio','folk',meter,0,meter,rhythm);
    const split=[...E.noteEvents('C',0,'arpeggio','folk',meter/2,0,meter,rhythm),...E.noteEvents('C',0,'arpeggio','folk',meter/2,meter/2,meter,rhythm)];
    assert.deepEqual(split.map(e=>e.beat),full.map(e=>e.beat));
  }
});
test('automatic simplified accompaniment preserves four source picks without a neural model',()=>{
  const f=recording(),s=E.arrange(f,{bpm:120,offset:.1},'four');
  assert.equal(s.config.pattern,'arpeggio');assert.equal(s.measures[0].events.length,4);
  assert.ok(s.accompaniment);assert.ok(!s.quality&&!s.source_notes&&!f.transcription);
  s.measures[0].events.forEach((event,i)=>assert.ok(Math.abs(event.time-(.1+i*.5))<.06));
  assert.equal(s.measures[0].segments[0].sounding,'C');
});
test('automatic simplified accompaniment also preserves a genuine eight-pick pattern',()=>{
  const s=E.arrange(recording(8),{bpm:120,offset:.1},'eight');
  assert.equal(s.measures[0].events.length,8);
});
test('automatic four-pick accompaniment distinguishes ascending from pinched patterns',()=>{
  const s=E.arrange(recording(4,[[48],[55],[60],[64]]),{bpm:120,offset:.1},'ascending');
  assert.equal(s.accompaniment.right_hand_pattern,'ascending');
  assert.deepEqual(s.measures[0].events.map(e=>e.notes.map(n=>n.midi)),[[48],[55],[60],[64]]);
});
test('a genuine two-pick pattern is not automatically filled into four picks',()=>{
  const s=E.arrange(recording(2),{bpm:120,offset:.1},'two');
  assert.equal(s.measures[0].events.length,2);assert.equal(s.accompaniment.inferred_attacks,0);
});
test('a syncopated four-pick pattern is not mistaken for a missing quarter note',()=>{
  const s=E.arrange(recording(4,undefined,[.1,.6,1.1,1.85]),{bpm:120,offset:.1},'syncopation');
  assert.equal(s.measures[0].events.length,4);assert.equal(s.accompaniment.inferred_attacks,0);
  assert.ok(Math.abs(s.measures[0].events.at(-1).time-1.85)<.06);
});
test('one masked weak beat in a regular pattern is completed and explicitly marked',()=>{
  const f=recording();f.attacks=f.attacks.filter(a=>Math.abs(a.time-.58)>.07);
  const s=E.arrange(f,{bpm:120,offset:.1},'masked');
  assert.equal(s.measures[0].events.length,4);assert.equal(s.accompaniment.inferred_attacks,1);
  assert.equal(s.measures[0].events.filter(e=>e.inferred).length,1);
});
test('manual density still uses the accompaniment harmony and not the old preset engine',()=>{
  const f=recording();
  for(const [arpeggio_rhythm,count]of [['quarter',4],['eighth',8]]){
    const s=E.arrange(f,{bpm:120,offset:.1,arpeggio_rhythm},'manual');
    assert.equal(s.measures[0].events.length,count);assert.equal(s.accompaniment.mode,'fixed-rhythm');
    assert.equal(s.measures[0].segments[0].sounding,'C');
  }
});
test('old neural-note caches cannot influence simplified accompaniment',()=>{
  const f=recording(),original=E.arrange(f,{bpm:120,offset:.1},'a');
  f.transcription={model:'irrelevant',notes:[{id:'bad',midi:99,time:.1,duration:1,amplitude:1}]};
  const cached=E.arrange(f,{bpm:120,offset:.1},'b');
  assert.deepEqual(cached.performance_notes,original.performance_notes);
});
test('chord edits change the simplified notes, rather than only changing a label',()=>{
  const f=recording(),s=E.arrange(f,{bpm:120,offset:.1,overrides:{'0':'D'}},'edit');
  const expected=new Set([2,6,9]);
  assert.equal(s.measures[0].segments[0].shape,'D');
  for(const e of s.measures[0].events)for(const n of e.notes)assert.ok(expected.has(n.midi%12));
});
test('capo changes fingering while keeping simplified pitches and onset times',()=>{
  const f=recording(),a=E.arrange(f,{bpm:120,offset:.1},'a'),b=E.arrange(f,{bpm:120,offset:.1,capo:1},'b');
  assert.deepEqual(a.performance_notes.map(n=>[n.midi,n.time]),b.performance_notes.map(n=>[n.midi,n.time]));
  for(const n of b.performance_notes)assert.equal(E.OPEN[6-n.string]+n.fret+1,n.midi);
});
test('MIDI retains real adaptive timing, durations and dynamics; XML stays labelled as simplified',()=>{
  const s=E.arrange(recording(),{bpm:120,offset:.1},'四次分解');
  const actual=new Midi(E.midiBytes(s)).tracks.flatMap(t=>t.notes).sort((a,b)=>a.time-b.time||a.midi-b.midi);
  const expected=[...s.performance_notes].sort((a,b)=>a.time-b.time||a.midi-b.midi);
  assert.equal(actual.length,expected.length);
  actual.forEach((n,i)=>{assert.equal(n.midi,expected[i].midi);assert.ok(Math.abs(n.time-(expected[i].time-s.offset))<.003);});
  assert.match(E.musicxml(s),/简化分解/);assert.doesNotMatch(E.musicxml(s),/逐音转录/);
  assert.match(E.textTab(s),/简化分解/);
});

test('missing fundamental energy cannot turn a visible middle-string pick into a minimum-gain placeholder',()=>{
  const normal=recording(),masked=structuredClone(normal);
  for(let frame=0;frame<masked.acoustic.rms.length;frame++)masked.acoustic.bands[frame*masked.acoustic.pitches+55-masked.acoustic.min_midi]=0;
  const before=E.arrange(normal,{bpm:120,offset:.1,overrides:{'0':'C'}},'clear');
  const after=E.arrange(masked,{bpm:120,offset:.1,overrides:{'0':'C'}},'masked');
  const a=before.measures[0].events[1].notes[0],b=after.measures[0].events[1].notes[0];
  assert.equal(a.midi,55);assert.equal(b.midi,55);
  assert.ok(b.gain/a.gain>.8&&b.gain/a.gain<1.2);
  assert.equal(after.accompaniment.dynamics,'onset-envelope-v1');
  assert.ok(after.performance_notes.every(n=>Number.isFinite(n.gain)&&n.gain>0&&n.gain!==.02));
});

test('generated dynamics follow source amplitude without a minimum loudness floor',()=>{
  const normal=recording(),quiet=structuredClone(normal),factor=.02;
  quiet.acoustic.rms=Float32Array.from(quiet.acoustic.rms,x=>x*factor);
  quiet.acoustic.bands=Float32Array.from(quiet.acoustic.bands,x=>x*factor);
  const a=E.arrange(normal,{bpm:120,offset:.1},'normal'),b=E.arrange(quiet,{bpm:120,offset:.1},'quiet');
  assert.deepEqual(a.performance_notes.map(n=>n.midi),b.performance_notes.map(n=>n.midi));
  for(let i=0;i<a.performance_notes.length;i++)assert.ok(Math.abs(b.performance_notes[i].gain/a.performance_notes[i].gain-factor)<.001);
});

test('a ringing bass alone cannot create a missing pick on the regular grid',()=>{
  const sr=22050,samples=new Float32Array(Math.round(sr*2.3));
  for(const [time,midi,duration] of [[.1,48,1.7],[1.1,60,.3],[1.6,64,.3]]){
    for(let i=0;i<duration*sr;i++){
      const t=i/sr,f=440*2**((midi-69)/12);
      samples[Math.round(time*sr)+i]+=.15*Math.min(1,t/.004)*Math.exp(-3*t)*Math.min(1,(duration-t)/.02)*(Math.sin(2*Math.PI*f*t)+.4*Math.sin(4*Math.PI*f*t));
    }
  }
  const features=E.analyze(samples);features.acoustic=V.extract(samples);
  const result=E.arrange(features,{bpm:120,offset:.1},'rest under bass');
  assert.equal(result.measures[0].events.length,3);
  assert.equal(result.accompaniment.inferred_attacks,0);
  assert.ok(result.accompaniment.rejected_grid_picks>=1);
  // Even an upstream false positive cannot bypass the decay check.
  features.attacks.push({time:.575,strength:.5});features.attacks.sort((a,b)=>a.time-b.time);
  const falseOnset=E.arrange(features,{bpm:120,offset:.1},'false onset under bass');
  assert.equal(falseOnset.measures[0].events.length,3);
  assert.ok(falseOnset.accompaniment.rejected_onsets>=1);
});

test('clear alternative chord-tone evidence overrides the middle-string hand pattern',()=>{
  const score=E.arrange(recording(4,[[48],[52],[60],[64]]),{bpm:120,offset:.1},'different middle string');
  assert.equal(score.measures[0].events[1].notes[0].midi,52);
  assert.equal(score.measures[0].events[1].notes[0].pitch_source,'spectral-innovation');
});

test('a clearly ended source note does not get a fixed 1.5-second sustain',()=>{
  const score=E.arrange(recording(),{bpm:120,offset:.1},'short source notes');
  const first=score.measures[0].events[0].notes[0];
  assert.equal(first.duration_method,'harmonic-envelope');
  assert.ok(first.duration_seconds>.15&&first.duration_seconds<.7,first.duration_seconds);
});

test('uncertain source pitch and onset have separate provenance',()=>{
  const features=recording(),time=.6;
  // An upstream candidate with no new acoustic content is rejected.
  const lo=Math.floor((time+.015)*22050/256),hi=Math.ceil((time+.14)*22050/256);
  features.acoustic.bands.fill(0,lo*49,hi*49);
  const empty=E.arrange(features,{bpm:120,offset:.1},'no excitation');
  assert.ok(!empty.measures[0].events.some(e=>Math.abs(e.time-time)<.07));
  // A broadband excitation supports an attack, without confirming a guitar pitch.
  features.acoustic.bands.fill(.5,lo*49,hi*49);
  const score=E.arrange(features,{bpm:120,offset:.1},'known onset uncertain pitch');
  const event=score.measures[0].events[1];
  assert.equal(event.attack_inferred,false);assert.equal(event.pitch_inferred,true);assert.equal(event.inferred,true);
  assert.equal(event.notes[0].duration_method,'until-next-pick');
  assert.ok(event.notes[0].gain>0);
});

test('auto accompaniment keeps attacks outside the eighth-note grid',()=>{
  const times=[.1,.48,1.28,1.76],score=E.arrange(recording(4,undefined,times),{bpm:120,offset:.1},'off-grid');
  const events=score.measures[0].events;
  assert.equal(events.length,times.length);
  events.forEach((event,i)=>assert.ok(Math.abs(event.time-times[i])<.04));
  assert.equal(score.accompaniment.inferred_attacks,0);
  assert.deepEqual(events.map(e=>e.notes.map(n=>n.midi)),[[48],[55],[60,64],[55]]);
});

test('an incomplete triad label cannot delete clear non-chord source pitches',()=>{
  const score=E.arrange(recording(4,[[48,52,55],[55],[59],[64]]),{bpm:120,offset:.1},'extended harmony');
  // C major plus B is not representable by the existing major/minor labels.
  // Keep the played notes even when the best triad label is Em.
  assert.deepEqual(score.measures[0].events.map(e=>e.notes.map(n=>n.midi)),[[48,52,55],[55],[59],[64]]);
  assert.equal(score.measures[0].events[0].notes[0].pitch_source,'spectral-innovation');
});

test('chromatic fitting only proposes pitches playable within the chosen fret range',()=>{
  const f=recording(4,[[48,52,55],[55],[59],[64]]);
  const onset=A.excitation(f.acoustic,.1);
  const notes=A.fit(f.acoustic,.1,.4,null,0,3,onset.residual);
  assert.ok(notes.length);
  for(const note of notes)assert.ok(E.OPEN.some(open=>note.midi-open>=0&&note.midi-open<=3));
});
