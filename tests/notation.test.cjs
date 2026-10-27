const test=require('node:test'),assert=require('node:assert/strict');
const E=require('../static/engine.js'),T=require('../static/transcription.js'),N=require('../static/notation.js');
function score(notes,meter=4,bars=2){
 const result={title:'规范记谱',bpm:120,duration:meter*.5*bars,config:E.configOptions({meter}),arrangement:{version:'test'},accompaniment:{},
   performance_notes:notes.map((n,i)=>({id:String(i),midi:64,string:1,fret:0,gain:.3,...n})),measures:[]};
 for(let i=0;i<bars;i++)result.measures.push({number:i+1,start:i*meter*.5,end:(i+1)*meter*.5,beat_times:Array.from({length:meter+1},(_,b)=>(i*meter+b)*.5),segments:[],events:[]});
 return result;
}
test('straight sixteenth and triplet notation keep their grids and expose excessive errors',()=>{
 assert.equal(N.rhythm(.27).beat,.25);assert.equal(N.rhythm(1/3).triplet,true);
 assert.ok(N.rhythm(.12).error>.08);
});
test('every voice fills each bar exactly, with rests, readable types, and cross-bar ties',()=>{
 const s=score([{time:1.75,duration:1}]),snapshot=JSON.stringify(s),plan=N.plan(s);
 for(const b of plan.bars)for(const v of b.voices){
  assert.equal(v.items.reduce((sum,n)=>sum+n.ticks,0),1920);
  let position=0;for(const n of v.items){assert.equal(n.start,position);assert.ok(n.ticks>0);assert.ok(n.type);position+=n.ticks;}
 }
 const a=plan.bars[0].voices[0].items.filter(n=>!n.rest),b=plan.bars[1].voices[0].items.filter(n=>!n.rest);
 assert.ok(a.at(-1).tie_start);assert.ok(b[0].tie_stop);assert.ok(!b.at(-1).tie_start);
 assert.equal(JSON.stringify(s),snapshot);
});
test('tuplets use integral MusicXML ticks and three quarter bars remain complete',()=>{
 const s=score([{time:0,duration:1/6},{time:1/6,duration:1/6},{time:1/3,duration:1/6}],3,1);
 const plan=N.plan(s),items=plan.bars[0].voices[0].items.filter(n=>!n.rest);
 assert.deepEqual(items.map(n=>n.ticks),[160,160,160]);assert.ok(items.every(n=>n.triplet));
 assert.equal(plan.bars[0].voices[0].items.reduce((a,n)=>a+n.ticks,0),1440);
});
test('a release rounding to the barline creates no artificial next-bar fragment',()=>{
 const p=N.plan(score([{time:1.75,duration:.26}]));
 assert.ok(!p.bars[0].voices[0].items.filter(n=>!n.rest).at(-1).tie_start);
 assert.ok(p.bars[1].voices[0].items.every(n=>n.rest));
});
test('quantization collisions are counted instead of silently marked as accepted notation',()=>{
 const p=N.plan(score([{time:.001,duration:.04},{time:.04,duration:.1}],4,1));
 assert.equal(p.collapsed_notes,1);assert.ok(p.review_events>=1);
});
test('MusicXML encodes notation types, rests, beams, ties and tuplet time modification',()=>{
 const s=score([{time:0,duration:1/6},{time:1/6,duration:1/6},{time:1/3,duration:.2},{time:1.75,duration:1}]);
 s.notation=N.plan(s);s.measures[0].phrase={id:1,start:true,dynamic:'mp'};
 const xml=T.musicxml(s);
 for(const element of ['<type>','<rest/>','<beam','<time-modification>','<tuplet type="start"','<tuplet type="stop"','<tie type="start"','<tie type="stop"','<rehearsal>乐句 1','<dynamics><mp/>'])assert.ok(xml.includes(element),element);
 for(const voice of s.notation.bars.flatMap(b=>b.voices))assert.equal(voice.items.reduce((sum,n)=>sum+n.ticks,0),1920);
});

test('sixteenth beaming includes both beam levels and quantized holds remain ties',()=>{
 const s=score([{time:0,duration:.125},{time:.125,duration:.125},{time:.25,duration:.5}],4,1);
 s.notation=N.plan(s);const xml=T.musicxml(s);
 assert.ok(xml.includes('<beam number="2">begin</beam>'));
 assert.ok(xml.includes('<beam number="2">end</beam>'));
});
