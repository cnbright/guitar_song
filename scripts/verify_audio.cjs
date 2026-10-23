/* Reproduce the browser's comparison without a browser or an inference model.
 * node scripts/verify_audio.cjs reference.wav score.json output-directory
 * Exit 2 means the actual generated audio failed the comparison thresholds.
 */
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
require('../static/engine.js');
require('../static/guitar.js');
const V=require('../static/verification.js');
const [referenceFile,scoreFile,directory]=process.argv.slice(2);
if(!referenceFile||!scoreFile||!directory){console.error('Usage: node scripts/verify_audio.cjs reference.wav score.json output-directory');process.exit(1);}
const data=execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-i',referenceFile,'-vn','-ac','1','-ar','22050','-f','f32le','pipe:1'],{maxBuffer:60*1024*1024});
const samples=new Float32Array(data.buffer,data.byteOffset,data.byteLength/4),score=JSON.parse(fs.readFileSync(scoreFile));
if(Math.abs(samples.length/22050-score.duration)>.1)throw new Error('Reference and score duration differ; the same complete time span is required.');
(async()=>{
await V.prepare();
const report=V.verify(score,V.extract(samples));
fs.mkdirSync(directory,{recursive:true});
fs.writeFileSync(path.join(directory,'comparison-report.json'),JSON.stringify(report,null,2));
fs.writeFileSync(path.join(directory,'generated.wav'),Buffer.from(V.wav(V.render(score))));
console.log(JSON.stringify({status:report.status,overall:report.overall,failed_sections:report.sections.filter(r=>!r.passed).length,sections:report.sections.length},null,2));
process.exitCode=report.status==='passed'?0:2;
})().catch(error=>{console.error(error.message);process.exitCode=1;});
