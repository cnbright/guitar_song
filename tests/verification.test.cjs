const test=require('node:test');
const assert=require('node:assert/strict');
const E=require('../static/engine.js');
const V=require('../static/verification.js');
const T=require('../static/transcription.js');
function score(notes,duration=2.5){
  return {duration,bpm:120,measures:[{number:1,start:0,end:duration,events:notes.map(n=>({time:n.time,duration_seconds:n.duration??.25,
    notes:(n.pitches||[n.midi??45]).map(midi=>({midi}))}))}]};
}
const four=[.25,.75,1.25,1.75].map(time=>({time}));
function compare(a,b,ranges=[{measure:1,start:0,end:a.duration}]){
  const reference=V.extract(V.render(a));
  // Controlled reference fixtures have known annotated attacks, unlike real recordings.
  reference.attacks=V.performedAttacks(a);
  const generated=V.extract(V.render(b));generated.attacks=V.performedAttacks(b);
  return V.compare(reference,generated,ranges);
}
test('identical actual audio passes the quantitative comparison',()=>{
  const report=compare(score(four),score(four));
  assert.equal(report.status,'passed');assert.equal(report.overall.pitch_similarity,1);
  assert.equal(report.overall.reference_attacks,4);assert.equal(report.overall.generated_attacks,4);
});
test('four performed attacks turned into eight fail, even with the correct chord',()=>{
  const eight=Array.from({length:8},(_,i)=>({time:.25+i*.25}));
  const report=compare(score(four),score(eight));
  assert.equal(report.status,'failed');assert.equal(report.overall.reference_attacks,4);
  assert.equal(report.overall.generated_attacks,8);assert.equal(report.overall.extra_attacks,4);
  assert.equal(report.overall.precision,.5);assert.equal(report.overall.count_error,1);
});
test('an independent four-note recording also rejects eight generated attacks',()=>{
  // This fixture does not use the application's renderer or its detected notes.
  const samples=new Float32Array(22050*2.5),frequency=110;
  for(const {time} of four)for(let i=0;i<22050*.22;i++){
    const t=i/22050,envelope=Math.min(1,t/.006)*Math.exp(-4*t)*Math.min(1,(.22-t)/.015);
    samples[Math.round(time*22050)+i]+=.2*envelope*(Math.sin(2*Math.PI*frequency*t)+.3*Math.sin(4*Math.PI*frequency*t));
  }
  const generated=score(Array.from({length:8},(_,i)=>({time:.25+i*.25})));
  const reference=V.extract(samples);reference.attacks=four; // independently known fixture annotation
  const synthesized=V.extract(V.render(generated));synthesized.attacks=V.performedAttacks(generated);
  const report=V.compare(reference,synthesized,[{start:0,end:2.5}]);
  assert.equal(report.overall.reference_attacks,4);assert.equal(report.overall.generated_attacks,8);
  assert.equal(report.status,'failed');assert.equal(report.overall.extra_attacks,4);
});
test('the same number of attacks at the wrong times cannot pass',()=>{
  const report=compare(score(four),score(four.map(n=>({...n,time:n.time+.12}))));
  assert.equal(report.overall.reference_attacks,4);assert.equal(report.overall.generated_attacks,4);
  assert.equal(report.status,'failed');assert.ok(report.overall.failures.includes('起音未对齐'));
});
test('octave mistakes fail the pitch check despite perfect attack alignment',()=>{
  const report=compare(score(four),score(four.map(n=>({...n,midi:57}))));
  assert.equal(report.status,'failed');assert.equal(report.overall.precision,1);
  assert.ok(report.overall.pitch_similarity<V.LIMITS.pitch_similarity);
});
test('a missing independent chord voice is checked even when attack counts match',()=>{
  const report=compare(score(four.map(n=>({...n,pitches:[48,60,65]}))),score(four.map(n=>({...n,pitches:[48,60]}))));
  assert.equal(report.overall.reference_attacks,report.overall.generated_attacks);
  assert.equal(report.status,'failed');assert.ok(report.overall.failures.includes('音高谱差异'));
});
test('a bad local section cannot be hidden by a good global average',()=>{
  const a=score(four),b=score([...four.slice(0,3),{time:1.75,midi:69}]);
  const report=compare(a,b,[{measure:1,start:0,end:1.5},{measure:2,start:1.5,end:2.5}]);
  assert.equal(report.sections[0].passed,true);assert.equal(report.sections[1].passed,false);assert.equal(report.status,'failed');
});
test('one generated attack cannot count as two reference attacks',()=>{
  const result=V.matchAttacks([{time:1},{time:1.1}],[{time:1.05}]);
  assert.equal(result.matched_attacks,1);assert.equal(result.recall,.5);
});
test('a weak duplicate on a different string attack does not retrigger sustained bass',()=>{
  const original=score([{time:.2,midi:45,duration:1.8},{time:1,midi:64,duration:.3}]);
  const reference=V.extract(V.render(original));
  const raw=[{id:'bass',midi:45,time:.2,duration:.8,amplitude:.8},{id:'false',midi:45,time:1,duration:.8,amplitude:.4},
    {id:'treble',midi:64,time:1,duration:.3,amplitude:.8}];
  const cleaned=T.cleanNotes(raw,[{time:.2},{time:1}],2.5,reference);
  assert.equal(cleaned.notes.filter(n=>n.midi===45).length,1);assert.equal(cleaned.unsupportedRetriggers,1);
});
test('real repeated bass notes survive the pitch-specific retrigger check',()=>{
  const original=score([{time:.2,midi:45,duration:.7},{time:1,midi:45,duration:.7}]);
  const reference=V.extract(V.render(original));
  const raw=[{id:'a',midi:45,time:.2,duration:.8,amplitude:.8},{id:'b',midi:45,time:1,duration:.7,amplitude:.8}];
  assert.equal(T.cleanNotes(raw,[{time:.2},{time:1}],2.5,reference).notes.length,2);
});
test('WAV contains the exact measured renderer samples as 16-bit PCM',()=>{
  const samples=V.render(score(four)),bytes=V.wav(samples),view=new DataView(bytes);
  assert.equal(bytes.byteLength,44+samples.length*2);assert.equal(view.getUint32(24,true),22050);
  for(let i=0;i<samples.length;i+=127)assert.ok(Math.abs(view.getInt16(44+i*2,true)/32767-samples[i])<.00004);
});
