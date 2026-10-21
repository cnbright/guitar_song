const test=require('node:test');
const assert=require('node:assert/strict');
const engine=require('../static/engine.js');

function features(){
  const chroma=new Float32Array(400*12),rms=new Float32Array(400).fill(.1);
  ['C','Am','F','G'].forEach((chord,index)=>{
    const [root,minor]=engine.parse(chord);
    for(let frame=index*100;frame<(index+1)*100;frame++)for(const pitch of [root,(root+(minor?3:4))%12,(root+7)%12])chroma[frame*12+pitch]=1;
  });
  return {chroma,rms,meta:{duration:8,bpm:120,offset:0,sample_rate:100,hop:2,waveform:[.5]}};
}

test('all capo voicings preserve the sounding major/minor triad',()=>{
  for(const chord of engine.CHORDS)for(let capo=0;capo<=12;capo++){
    const [r,m]=engine.parse(chord),expected=new Set([r,(r+(m?3:4))%12,(r+7)%12]);
    const shape=engine.transpose(chord,-capo),actual=new Set(engine.voicing(shape).map((f,i)=>f===null?null:(engine.OPEN[i]+f+capo)%12).filter(x=>x!==null));
    assert.deepEqual(actual,expected);assert.equal(engine.transpose(shape,capo),chord);
  }
});
test('recognition, manual correction, and capo conversion',()=>{
  let score=engine.arrange(features(),{},'test');
  assert.deepEqual(score.measures.map(b=>b.segments[0].sounding),['C','Am','F','G']);
  score=engine.arrange(features(),{capo:2,overrides:{'0':'D'}},'test');
  assert.equal(score.measures[0].segments[0].shape,'C');
  assert.equal(score.measures[0].events[0].notes[0].midi,50);
});
test('split measures preserve the full strum rhythm',()=>{
  const full=engine.noteEvents('C',0,'strum','folk',4);
  const half=[...engine.noteEvents('C',0,'strum','folk',2),...engine.noteEvents('G',0,'strum','folk',2,2)];
  assert.deepEqual(full.map(e=>[e.beat,e.direction]),half.map(e=>[e.beat,e.direction]));
  assert.equal(full.length,6);
});
test('rests, 3/4 meter, and partial ending never exceed source audio',()=>{
  const score=engine.arrange(features(),{meter:3,bpm:100,offset:.4,overrides:{'0':'N'}},'test');
  assert.equal(score.measures[0].events.length,0);
  for(const bar of score.measures)for(const event of bar.events){
    assert.ok(event.beat<3);assert.ok(event.time+event.duration*.6<=score.duration+.002);
    assert.equal(new Set(event.notes.map(n=>n.string)).size,event.notes.length);
  }
});
test('exports contain real notes and escaped Unicode titles',()=>{
  const score=engine.arrange(features(),{capo:1,pattern:'strum'},'中文 & <乐谱>');
  const midi=engine.midiBytes(score),xml=engine.musicxml(score),txt=engine.textTab(score);
  assert.equal(new TextDecoder().decode(midi.slice(0,4)),'MThd');
  assert.ok(midi.includes(144));assert.ok(new TextDecoder().decode(midi).includes('中文'));
  assert.ok(xml.includes('中文 &amp; &lt;乐谱&gt;'));assert.ok(xml.includes('<capo>1</capo>'));
  assert.ok(txt.includes('e|')&&txt.includes('E|'));
});
test('invalid settings and quiet audio fail clearly',()=>{
  assert.throws(()=>engine.arrange(features(),{capo:13},'x'));
  assert.throws(()=>engine.arrange(features(),{bpm:0},'x'));
  assert.throws(()=>engine.arrange(features(),{offset:8},'x'));
  assert.throws(()=>engine.arrange(features(),{overrides:{'0':'<script>'}},'x'));
  assert.throws(()=>engine.analyze(new Float32Array(22050*3)),/静音/);
});
test('real harmonic audio is analyzed into the correct progression',()=>{
  const sr=22050,samples=new Float32Array(sr*8),chords=[[48,52,55],[45,48,52],[41,45,48],[43,47,50]];
  chords.forEach((notes,bar)=>{
    for(let i=0;i<sr*2;i++){
      const t=i/sr;let value=0;
      for(const note of notes)for(let h=1;h<=4;h++)value+=.08/h*Math.sin(2*Math.PI*440*2**((note-69)/12)*h*t);
      samples[bar*sr*2+i]=value*(.6+.4*Math.exp(-(t%.5)*10));
    }
  });
  const f=engine.analyze(samples,sr),score=engine.arrange(f,{bpm:120,offset:0},'audio test');
  assert.deepEqual(score.measures.map(b=>b.segments[0].sounding),['C','Am','F','G']);
  assert.ok(f.meta.bpm>=100&&f.meta.bpm<=140);
});
