const test=require('node:test'),assert=require('node:assert/strict');
const {Midi}=require('@tonejs/midi');
const E=require('../static/engine.js'),V=require('../static/verification.js'),T=require('../static/transcription.js');
const R=require('../static/arrangement.js');
function fixture(pitches=[[43],[55],[59,67],[55]],options={}){
  const config=E.configOptions(options),meter=config.meter,capo=config.capo,duration=meter*.5;
  const performance=pitches.flatMap((group,i)=>group.map((midi,j)=>({id:i+'-'+j,midi,time:i*duration/pitches.length,duration:.4,gain:.3,amplitude:.3,bar:1,inferred:true,pitch_inferred:true,attack_inferred:false})));
  const mapped=T.finger(performance,capo,config.max_fret).notes;
  const shape=options.shape??'G',segment={id:'0',start:0,end:duration,shape,sounding:E.transpose(shape,capo),bass_midi:pitches[0][0]};
  return {title:'编配测试',config,bpm:120,offset:0,duration,accompaniment:{analysis_capo:capo,right_hand_pattern:'pinch',dynamics:'onset-envelope-v1',unmapped_notes:0},
    performance_notes:mapped,measures:[{number:1,start:0,end:duration,beat_times:Array.from({length:meter+1},(_,i)=>i*.5),segments:[segment],events:pitches.map((_,i)=>({time:i*duration/pitches.length,beat:i*meter/pitches.length,duration:meter/pitches.length,inferred:true,pitch_inferred:true,attack_inferred:false,
      notes:mapped.filter(n=>n.time===i*duration/pitches.length).map(n=>({...n,duration_seconds:n.duration}))}))}]};
}
test('valid chord-based hand roles are deliberately retained, with source uncertainty kept',()=>{
  const source=fixture(),snapshot=JSON.stringify(source),score=R.finalize(source);
  assert.equal(score.arrangement.status,'ready');assert.equal(score.arrangement.resolved_source_events,4);
  assert.equal(score.arrangement.changed_events,0);assert.equal(score.arrangement.pending_events,0);
  assert.ok(score.measures[0].events.every(e=>e.inferred&&e.arrangement.status==='resolved'));
  assert.equal(JSON.stringify(source),snapshot);assert.deepEqual(score.analysis_performance_notes,source.performance_notes);
  assert.equal(R.finalize(score),score);
});
test('unresolved non-chord inner voices are rewritten into a consistent accompaniment pattern',()=>{
  const score=R.finalize(fixture([[43],[57],[59,67],[54]]));
  assert.deepEqual(score.measures[0].events.map(e=>e.notes.map(n=>n.midi)),[[43],[55],[59,67],[55]]);
  assert.equal(score.arrangement.changed_events,2);assert.equal(score.arrangement.status,'ready');
  assert.equal(score.arrangement.audit[1].source.notes[0].midi,57);
});
test('inversion bass is retained instead of being replaced by the chord root',()=>{
  const source=fixture([[42],[57],[62,66],[57]],{shape:'D'});source.measures[0].segments[0].display_shape='D/F#';
  const score=R.finalize(source);assert.equal(score.measures[0].events[0].notes[0].midi,42);
  assert.equal(score.measures[0].segments[0].display_shape,'D/F#');
});
test('capo-aware chord roles and final six-string fingering agree',()=>{
  const score=R.finalize(fixture([[44],[57],[60,68],[57]],{capo:1}));
  assert.equal(score.measures[0].events[1].notes[0].midi,56);
  for(const event of score.measures[0].events){
    assert.equal(new Set(event.notes.map(n=>n.string)).size,event.notes.length);
    for(const n of event.notes)assert.equal(E.OPEN[6-n.string]+n.fret+1,n.midi);
  }
});
test('authoring decisions preserve the number and time of picks, including sparse and dense patterns',()=>{
  for(const groups of [[[43],[55]],Array.from({length:8},()=>[55]),[[43],[55],[59,67]]]){
    const source=fixture(groups,groups.length===3?{meter:3}:{}),score=R.finalize(source);
    assert.deepEqual(score.measures[0].events.map(e=>e.time),source.measures[0].events.map(e=>e.time));
    assert.equal(score.measures[0].events.length,groups.length);
  }
});
test('unresolved rhythmic conflicts remain visible and are never labelled ready',()=>{
  const source=fixture();source.measures[0].events[1].beat=.27;
  const score=R.finalize(source);
  assert.equal(score.arrangement.status,'needs-review');
  assert.equal(score.measures[0].events[1].arrangement.status,'needs-review');assert.equal(score.arrangement.pending_events,1);
});
test('MIDI, playback and text export use the corrected notes and disclose accompaniment authorship',()=>{
  const score=R.finalize(fixture([[43],[57],[59,67],[54]]));
  const midi=new Midi(E.midiBytes(score)).tracks.flatMap(t=>t.notes).map(n=>n.midi).sort((a,b)=>a-b);
  assert.deepEqual(midi,score.performance_notes.map(n=>n.midi).sort((a,b)=>a-b));
  assert.deepEqual(V.scoreNotes(score).map(n=>n.midi).sort((a,b)=>a-b),midi);
  assert.match(E.musicxml(score),/伴奏编配/);assert.match(E.textTab(score),/不代表原音逐音还原/);
});
