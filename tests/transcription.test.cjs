const test=require('node:test');
const assert=require('node:assert/strict');
const {Midi}=require('@tonejs/midi');
const E=require('../static/engine.js');
const T=require('../static/transcription.js');

function fixture(){
  const notes=[
    {id:'a',midi:44,time:.12,duration:.6,amplitude:.8},
    {id:'b',midi:60,time:.595,duration:.3,amplitude:.8},
    {id:'c',midi:68,time:.605,duration:.45,amplitude:.7},
    {id:'d',midi:43,time:1.14,duration:.7,amplitude:.9},
    {id:'e',midi:65,time:2.27,duration:.7,amplitude:.8},
    {id:'f',midi:60,time:3.01,duration:.4,amplitude:.8},
  ];
  return {meta:{duration:4,bpm:120,offset:0,sample_rate:100,hop:2,waveform:[.8]},
    chroma:new Float32Array(200*12).fill(.1),rms:new Float32Array(200).fill(.1),
    attacks:notes.map(n=>({time:n.time,strength:.8})),transcription:{model:'test model',notes}};
}
test('actual pitches and irregular onset times survive tab generation',()=>{
  const f=fixture(),score=E.arrange(f,{pattern:'transcribe',capo:1},'test');
  assert.equal(score.quality.needs_review,true);
  assert.equal(score.source_notes.length,f.transcription.notes.length);
  for(const original of f.transcription.notes){
    const note=score.source_notes.find(n=>n.id===original.id);
    assert.equal(note.midi,original.midi);assert.equal(note.time,original.time);
    assert.equal(E.OPEN[6-note.string]+note.fret+1,note.midi);
  }
  assert.equal(score.source_notes.find(n=>n.id==='d').fret,2);
  const played=score.measures.flatMap(b=>b.events.flatMap(e=>e.notes.map(n=>({id:n.id,time:e.time+n.onset_offset}))));
  for(const original of f.transcription.notes)assert.ok(Math.abs(played.find(n=>n.id===original.id).time-original.time)<.000001);
});
test('MIDI preserves onset seconds, individual durations, and pitch',()=>{
  const score=E.arrange(fixture(),{pattern:'transcribe',capo:1},'中文原音');
  const midi=new Midi(E.midiBytes(score)),notes=midi.tracks.flatMap(t=>t.notes).sort((a,b)=>a.time-b.time||a.midi-b.midi);
  const expected=[...score.source_notes].sort((a,b)=>a.time-b.time||a.midi-b.midi);
  assert.equal(notes.length,expected.length);
  notes.forEach((note,i)=>{assert.equal(note.midi,expected[i].midi);assert.ok(Math.abs(note.time-(expected[i].time-score.offset))<.002);assert.ok(Math.abs(note.duration-expected[i].duration)<.003);});
});
test('capo changes fingering without transposing the original recording',()=>{
  const a=E.arrange(fixture(),{pattern:'transcribe',capo:0},'x'),b=E.arrange(fixture(),{pattern:'transcribe',capo:1},'x');
  assert.deepEqual(a.source_notes.map(n=>n.midi),b.source_notes.map(n=>n.midi));
  assert.throws(()=>E.arrange(fixture(),{pattern:'transcribe',capo:5},'x'),/低音/);
});
test('chord labels never replace the recorded notes with a preset pattern',()=>{
  const a=E.arrange(fixture(),{pattern:'transcribe'},'x'),b=E.arrange(fixture(),{pattern:'transcribe',overrides:{'0':'Am'}},'x');
  assert.deepEqual(a.source_notes,b.source_notes);
  assert.equal(b.measures[0].segments[0].sounding,'Am');
});
test('fragmented sustain is merged but real repeated attacks are kept',()=>{
  const notes=[{id:'a',midi:44,time:1,duration:.2,amplitude:.8},{id:'b',midi:44,time:1.2,duration:.3,amplitude:.8},{id:'c',midi:44,time:1.5,duration:.3,amplitude:.8}];
  const result=T.cleanNotes(notes,[{time:1},{time:1.5}],3);
  assert.equal(result.notes.length,2);assert.equal(result.notes[0].duration,.5);assert.equal(result.notes[1].time,1.5);
});
test('one guitar string cannot play overlapping independent pitches',()=>{
  const score=E.arrange(fixture(),{pattern:'transcribe'},'x');
  for(let string=1;string<=6;string++){
    const notes=score.source_notes.filter(n=>n.string===string).sort((a,b)=>a.time-b.time);
    for(let i=1;i<notes.length;i++)assert.ok(notes[i-1].time+notes[i-1].duration<=notes[i].time+.000001);
  }
  const xml=E.musicxml(score);
  assert.ok(xml.includes('<voice>6</voice>'));assert.ok(xml.includes('<backup>'));assert.ok(xml.includes('逐音转录草稿'));
});
test('legacy cached analysis cannot silently masquerade as a transcription',()=>{
  const f=fixture();delete f.transcription;
  assert.throws(()=>E.arrange(f,{pattern:'transcribe'},'old'),/旧作品/);
});
test('fret limits are explicit and never fold high pitches into another octave',()=>{
  const f=fixture();f.transcription.notes.push({id:'high',midi:80,time:1.8,duration:.2,amplitude:.8});
  const limited=E.arrange(f,{pattern:'transcribe',max_fret:7},'x');
  assert.ok(limited.source_notes.every(n=>n.fret<=7));
  assert.ok(limited.quality.unmapped_notes>0);
  const full=E.arrange(f,{pattern:'transcribe',max_fret:20},'x');
  assert.equal(full.source_notes.find(n=>n.id==='high').midi,80);
});
