/* Reproduce the default browser accompaniment and its actual sampled playback.
 * node scripts/analyze_accompaniment.cjs input.wav output-directory
 * Exit 2 means generation completed but acoustic acceptance failed.
 * The source audio is read locally and is never uploaded.
 */
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const E=require('../static/engine.js');
require('../static/guitar.js');
const V=require('../static/verification.js');
require('../static/transcription.js');
require('../static/accompaniment.js');
const [source,directory]=process.argv.slice(2);
if(!source||!directory){console.error('Usage: node scripts/analyze_accompaniment.cjs input.wav output-directory');process.exit(1);}
(async()=>{
  const bytes=execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-i',source,'-vn','-ac','1','-ar','22050','-f','f32le','pipe:1'],{maxBuffer:64*1024*1024});
  const samples=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4);
  const features=E.analyze(samples);features.acoustic=V.extract(samples);
  await V.prepare();
  const score=E.arrange(features,{},path.parse(source).name);
  score.comparison=V.verify(score,features.acoustic);
  fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'score.json'),JSON.stringify(score,null,2));
  fs.writeFileSync(path.join(directory,'comparison-report.json'),JSON.stringify(score.comparison,null,2));
  fs.writeFileSync(path.join(directory,'generated-draft.wav'),Buffer.from(V.wav(V.render(score))));
  console.log(JSON.stringify({status:score.comparison.status,overall:score.comparison.overall,accompaniment:score.accompaniment},null,2));
  process.exitCode=score.comparison.status==='passed'?0:2;
})().catch(error=>{console.error(error.message);process.exitCode=1;});
