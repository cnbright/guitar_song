/* Readable notation is a separate view of the performance, never a timing edit. */
(function(root){
  'use strict';
  const T=root.StringspaceTranscription??require('./transcription.js'),VERSION='guitar-notation-v1',DIVISIONS=480;
  function quantize(beat){
    const straight=Math.round(beat*4)/4,triplet=Math.round(beat*3)/3;
    // Prefer straight notation when both are essentially equally close.
    return Math.abs(beat-triplet)+.012<Math.abs(beat-straight)?triplet:straight;
  }
  function rhythm(beat){const value=quantize(beat);return {beat:value,tick:Math.round(value*DIVISIONS),error:Math.abs(value-beat),triplet:Math.abs(value*4-Math.round(value*4))>.001};}
  const TYPES=[{ticks:480,type:'quarter'},{ticks:360,type:'eighth',dots:1},{ticks:240,type:'eighth'},
    {ticks:160,type:'eighth',triplet:true},{ticks:120,type:'16th'},{ticks:80,type:'16th',triplet:true},{ticks:40,type:'32nd',triplet:true}];
  function split(start,end,rest=false){
    const output=[];let at=start;
    while(at<end){
      const room=Math.min(end-at,480-at%480),triplet=at%120!==0||room%120!==0;
      const value=TYPES.find(v=>v.ticks<=room&&(!triplet||v.triplet))??TYPES.at(-1);
      const ticks=Math.min(value.ticks,room);
      output.push({...value,ticks,start:at,rest});at+=ticks;
    }
    return output;
  }
  function plan(score){
    const meter=score.config.meter,barTicks=meter*DIVISIONS,notes=score.performance_notes??score.source_notes??[];
    const beats=score.beat_times??[...score.measures.flatMap(b=>b.beat_times.slice(0,-1)),score.measures.at(-1).beat_times.at(-1)];
    let collapsed=0;
    const strings=Array.from({length:6},(_,i)=>notes.filter(n=>n.string===i+1).map(note=>{
      const start=rhythm(T.timeToBeat(beats,note.time)).tick;
      return {note,start,end:Math.max(start+40,rhythm(T.timeToBeat(beats,note.time+note.duration)).tick)};
    }).sort((a,b)=>a.start-b.start));
    for(const rows of strings)for(let i=0;i<rows.length;i++){
      if(rows[i+1])rows[i].end=Math.min(rows[i].end,rows[i+1].start);
      if(rows[i].end<=rows[i].start)collapsed++;
    }
    const bars=score.measures.map((bar,index)=>{
      const voices=[],base=index*barTicks;
      for(let string=1;string<=6;string++){
        const output=[];let cursor=0;
        const relevant=strings[string-1].filter(n=>n.end>n.start&&n.start<base+barTicks&&n.end>base);
        for(const row of relevant){
          const note=row.note,start=Math.max(0,row.start-base),end=Math.min(barTicks,row.end-base);
          output.push(...split(cursor,start,true));
          const parts=split(start,end);
          parts.forEach((part,j)=>output.push({...part,id:note.id,midi:note.midi,string,fret:note.fret,
            tie_stop:j>0||row.start<base,tie_start:j<parts.length-1||row.end>base+barTicks}));
          cursor=end;
        }
        output.push(...split(cursor,barTicks,true));voices.push({string,items:output});
      }
      const events=bar.events.map(e=>({time:e.time,...rhythm(e.beat)}));
      return {number:bar.number,ticks:barTicks,voices,events};
    });
    return {version:VERSION,divisions:DIVISIONS,grid:'sixteenth-and-eighth-triplet',performance_timing_preserved:true,bars,
      collapsed_notes:collapsed,review_events:collapsed+bars.reduce((n,b)=>n+b.events.filter(e=>e.error>.08).length,0)};
  }
  const api={VERSION,quantize,rhythm,split,plan};root.StringspaceNotation=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(globalThis);
