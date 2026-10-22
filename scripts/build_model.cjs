const fs=require('node:fs'),path=require('node:path'),esbuild=require('esbuild');
const root=path.resolve(__dirname,'..'),out=path.join(root,'static/vendor');
fs.mkdirSync(out,{recursive:true});
esbuild.buildSync({entryPoints:[path.join(root,'browser/transcriber.js')],outfile:path.join(out,'transcriber.js'),
  bundle:true,minify:true,format:'iife',globalName:'StringspaceTranscriber',platform:'browser',target:['es2020'],legalComments:'linked'});
for(const dir of ['model','wasm','licenses'])fs.mkdirSync(path.join(out,dir),{recursive:true});
const basic=path.dirname(require.resolve('@spotify/basic-pitch/package.json'));
for(const file of ['model.json','group1-shard1of1.bin'])fs.copyFileSync(path.join(basic,'model',file),path.join(out,'model',file));
fs.copyFileSync(path.join(basic,'LICENSE'),path.join(out,'licenses','basic-pitch-LICENSE.txt'));
const wasm=path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm/package.json'));
for(const file of fs.readdirSync(path.join(wasm,'dist')).filter(f=>f.endsWith('.wasm')))fs.copyFileSync(path.join(wasm,'dist',file),path.join(out,'wasm',file));
for(const name of ['@tensorflow/tfjs','@tensorflow/tfjs-backend-wasm','@tonejs/midi']){
  const location=path.dirname(require.resolve(name+'/package.json'));
  for(const license of fs.readdirSync(location).filter(f=>/^(LICENSE|NOTICE)/i.test(f))){
    if(fs.statSync(path.join(location,license)).isFile())fs.copyFileSync(path.join(location,license),path.join(out,'licenses',name.replaceAll('/','-')+'-'+license));
  }
}
fs.writeFileSync(path.join(out,'NOTICE.txt'),'Spotify Basic Pitch: Copyright 2022 Spotify AB, Apache-2.0.\nTensorFlow.js: Copyright Google LLC, Apache-2.0.\nThis application bundles unmodified pretrained model weights and a browser runtime. See licenses/ and transcriber.js.LEGAL.txt.\n');
console.log('Built local Basic Pitch runtime, model and WASM assets.');
