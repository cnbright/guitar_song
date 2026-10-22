const test=require('node:test'),assert=require('node:assert/strict');
const {Midi}=require('@tonejs/midi');
const E=require('../static/engine.js'),V=require('../static/verification.js'),T=require('../static/transcription.js');
require('../static/accompaniment.js');
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
