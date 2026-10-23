const test=require('node:test');
const assert=require('node:assert/strict');
const G=require('../static/guitar.js');
require('../static/engine.js');
const V=require('../static/verification.js');

test('the bundled acoustic instrument loads without any external service',async()=>{
  await Promise.all([G.load(),G.load()]);
  assert.equal(G.ready,true);
  const audio=G.pluck(52,1);
  assert.equal(audio.length,22050);
  assert.ok(audio.some(x=>Math.abs(x)>.1));
  assert.equal(audio[0],0);assert.equal(audio.at(-1),0);
});

test('sample transposition preserves requested guitar pitches across the supported range',async()=>{
  await G.load();
  for(const midi of [40,41,44,56,60,68,74,81,88]){
    const sound=G.pluck(midi,1),fft=new StringspaceEngine.FFT(16384);
    fft.transform(sound,2000);
    const frequency=440*2**((midi-69)/12);let peak=0,bin=0;
    for(let i=Math.floor(frequency*.96*16384/22050);i<=Math.ceil(frequency*1.04*16384/22050);i++){
      const magnitude=Math.hypot(fft.real[i],fft.imag[i]);
      if(magnitude>peak){peak=magnitude;bin=i;}
    }
    assert.ok(Math.abs(1200*Math.log2(bin*22050/16384/frequency))<25,`out of tune: ${midi}`);
  }
});

test('recorded body and pick sound replace the additive analysis template',async()=>{
  await G.load();
  const real=G.pluck(52,.8),synthetic=V.pluck(52,.8);
  let dot=0,a2=0,b2=0;
  for(let i=0;i<real.length;i++){dot+=real[i]*synthetic[i];a2+=real[i]**2;b2+=synthetic[i]**2;}
  assert.ok(dot*dot/(a2*b2)<.5);
  for(const duration of [.01,.03,.5,6]){
    const sound=G.pluck(40,duration,44100);
    assert.ok(sound.length<=Math.ceil(44100*duration));
    assert.ok(sound.every(Number.isFinite));assert.ok(sound.at(-1)===0);
  }
});

test('playback and PCM export use the same sampled waveform without changing the score',async()=>{
  await V.prepare();
  const score={duration:2,bpm:120,measures:[{number:1,start:0,end:2,events:[
    {time:.2,duration_seconds:.8,notes:[{midi:44,gain:.4}]},
    {time:1,duration_seconds:.8,notes:[{midi:60,gain:.3},{midi:68,gain:.3}]}
  ]}]};
  const before=JSON.stringify(score),samples=V.render(score),view=new DataView(V.wav(samples));
  assert.equal(JSON.stringify(score),before);
  assert.deepEqual(V.performedAttacks(score),[{time:.2},{time:1}]);
  const note=G.pluck(44,.8);
  for(let i=0;i<note.length&&i<.7*22050;i+=127)assert.ok(Math.abs(samples[4410+i]-note[i]*.4)<1e-7);
  for(let i=0;i<samples.length;i+=127)assert.ok(Math.abs(view.getInt16(44+i*2,true)/32767-samples[i])<.00004);
  const report=V.verify(score,V.extract(samples));
  assert.equal(report.renderer_version,G.VERSION);
});

test('sampled playback still rejects doubled picks and octave mistakes',async()=>{
  await G.load();
  const make=(count,midi)=>({duration:2.5,bpm:120,measures:[{number:1,start:0,end:2.5,
    events:Array.from({length:count},(_,i)=>({time:.25+i*2/count,duration_seconds:.22,notes:[{midi}]}))}]});
  const source=make(4,45),reference=V.extract(V.render(source));
  reference.attacks=V.performedAttacks(source); // independent fixture annotation
  assert.equal(V.verify(source,reference).status,'passed');
  const doubled=V.verify(make(8,45),reference);
  assert.equal(doubled.status,'failed');assert.equal(doubled.overall.extra_attacks,4);
  const octave=V.verify(make(4,57),reference);
  assert.equal(octave.status,'failed');assert.ok(octave.overall.failures.includes('音高谱差异'));
});

test('a weak middle-string pick remains audible under a ringing bass in practice playback',async()=>{
  await G.load();
  const raw={duration:2,bpm:120,measures:[{number:1,start:0,end:2,events:[
    {time:.2,duration_seconds:1.5,notes:[{midi:44,gain:.451}]},
    {time:.653,duration_seconds:.94,notes:[{midi:56,gain:.066}]}
  ]}]};
  const balanced={...structuredClone(raw),accompaniment:{mode:'audio-guided'}};
  const snapshot=JSON.stringify(balanced),muted=structuredClone(balanced);
  muted.measures[0].events[1].notes[0].gain=0;
  const old=V.render(raw),fresh=V.render(balanced),bass=V.render(muted);
  let oldPower=0,newPower=0;
  for(let i=Math.round(.673*22050);i<Math.round(.803*22050);i++){
    oldPower+=(old[i]-bass[i])**2;newPower+=(fresh[i]-bass[i])**2;
  }
  const boostDB=10*Math.log10(newPower/oldPower);
  assert.ok(boostDB>7&&boostDB<10,`weak pick boost ${boostDB} dB`);
  assert.equal(JSON.stringify(balanced),snapshot);
  assert.deepEqual(V.performedAttacks(balanced),V.performedAttacks(raw));
  assert.equal(V.scoreNotes(balanced)[0].level,.451);
  assert.equal(V.scoreNotes(muted)[1].level,0);
  assert.notEqual(V.rendererVersion(balanced),V.rendererVersion(raw));
});

test('balancing keeps volume order and local phrasing, with a bounded boost',()=>{
  const make=gains=>({accompaniment:{},bpm:120,measures:[{events:gains.map((gain,i)=>({time:i,duration_seconds:.2,notes:[{midi:52,gain}]}))}]});
  const gains=[0,.001,.02,.066,.2,.45],levels=V.scoreNotes(make(gains)).map(n=>n.level);
  assert.ok(levels.every((x,i)=>x>=gains[i]&&x<=gains[i]*4));
  assert.ok(levels.every((x,i)=>!i||x>=levels[i-1]));
  const quieter=V.scoreNotes(make(gains.map(g=>g/2))).map(n=>n.level);
  for(let i=0;i<levels.length;i++)assert.ok(Math.abs(quieter[i]*2-levels[i])<1e-12);
});

test('new source-derived dynamics are rendered directly without the legacy playback boost',()=>{
  const score={bpm:120,accompaniment:{dynamics:'onset-envelope-v1'},measures:[{events:[
    {time:.1,duration_seconds:.5,notes:[{midi:44,gain:.4}]},
    {time:.6,duration_seconds:.3,notes:[{midi:56,gain:.02}]}
  ]}]};
  assert.deepEqual(V.scoreNotes(score).map(n=>n.level),[.4,.02]);
  assert.match(V.rendererVersion(score),/onset-envelope-v1$/);
});
