'use strict';
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = {file: null, id: null, score: null, pattern: 'arpeggio', page: 0, busy: false, dirty: false, edit: null, chords: [], generation: 0};
const PAGE_SIZE = 12;
const esc = (value) => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clock = value => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
let toastTimer, audioContext, playbackTimer, playingNodes = [], playing = false;

function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 4500); }
async function api(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    let detail;
    try { detail = (await response.json()).detail; } catch { /* non-JSON upstream error */ }
    throw new Error(typeof detail === 'string' ? detail : `请求失败（${response.status}），请稍后重试。`);
  }
  return response.status === 204 ? null : response.json();
}
function setView(name) { ['empty', 'progress', 'error', 'result'].forEach(id => $(`#${id}-state`).hidden = id !== name); }
function setBusy(value) {
  state.busy = value;
  $('#generate').disabled = value || (!state.file && !state.score);
  $$('.config-panel input, .config-panel select, .pattern-select button, .capo-suggestions button').forEach(node => node.disabled = value);
  $('#replace-file').disabled = value;
  $('#file-input').disabled = value;
  $('#song-title').disabled = value || Boolean(state.score);
}
function chooseFile(file) {
  if (!file || state.busy) return;
  if (file.size > 100 * 1024 * 1024) return toast('文件超过 100 MB，请先截取需要练习的片段。');
  if (!file.size) return toast('这个文件是空的，请重新选择。');
  stopPlayback();
  $('#source-audio').pause();
  state.generation++;
  state.file = file; state.id = null; state.score = null; state.page = 0; state.dirty = false;
  localStorage.removeItem('stringspace-job');
  $('#file-card').hidden = false; $('#dropzone').hidden = true;
  $('#file-name').textContent = file.name;
  $('#file-size').textContent = `${(file.size / 1024 / 1024).toFixed(1)} MB · 已准备好`;
  $('#song-title').disabled = false;
  $('#song-title').value = file.name.replace(/\.[^.]+$/, '').slice(0, 120);
  $('#generate span').textContent = '生成我的吉他谱';
  $('#generate').disabled = false;
  $('#dirty-note').hidden = true; $('#capo-suggestions').hidden = true;
  $('#workspace-state').textContent = '音乐已就绪'; $('#step-two').classList.add('active'); $('#step-three').classList.remove('active');
  setView('empty');
}
$('#file-input').addEventListener('change', event => chooseFile(event.target.files[0]));
$('#replace-file').addEventListener('click', () => $('#file-input').click());
$('#dropzone').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('#file-input').click(); } });
['dragenter', 'dragover'].forEach(type => $('#dropzone').addEventListener(type, event => { event.preventDefault(); $('#dropzone').classList.add('dragging'); }));
['dragleave', 'drop'].forEach(type => $('#dropzone').addEventListener(type, event => { event.preventDefault(); $('#dropzone').classList.remove('dragging'); }));
$('#dropzone').addEventListener('drop', event => chooseFile(event.dataTransfer.files[0]));
function changed() { if (state.score) { state.dirty = true; $('#dirty-note').hidden = false; } }
$$('[data-pattern]').forEach(button => button.addEventListener('click', () => {
  state.pattern = button.dataset.pattern;
  $$('[data-pattern]').forEach(node => { node.classList.toggle('selected', node === button); node.setAttribute('aria-pressed', String(node === button)); });
  $('#rhythm-field').hidden = state.pattern !== 'strum'; changed();
}));
$('#capo').addEventListener('input', () => { $('#capo-value').textContent = +$('#capo').value ? `第 ${$('#capo').value} 品` : '不使用'; changed(); });
['rhythm', 'meter', 'bpm', 'offset', 'changes'].forEach(id => $(`#${id}`).addEventListener('change', changed));

function configFromControls() {
  const config = {capo: +$('#capo').value, pattern: state.pattern, rhythm: $('#rhythm').value,
    meter: +$('#meter').value, bpm: $('#bpm').value ? +$('#bpm').value : null,
    offset: $('#offset').value ? +$('#offset').value : null, changes: $('#changes').value,
    overrides: state.score ? {...state.score.config.overrides} : {}};
  for (const id of ['bpm', 'offset']) if (!$(`#${id}`).reportValidity()) throw new Error('请检查节拍设置中的数值。');
  if (state.score && ['meter', 'bpm', 'offset', 'changes'].some(key => config[key] !== state.score.config[key])) config.overrides = {};
  return config;
}
function syncControls(config) {
  state.pattern = config.pattern;
  $$('[data-pattern]').forEach(node => { const selected = node.dataset.pattern === config.pattern; node.classList.toggle('selected', selected); node.setAttribute('aria-pressed', String(selected)); });
  ['capo', 'rhythm', 'meter', 'bpm', 'offset', 'changes'].forEach(id => $(`#${id}`).value = config[id] ?? '');
  $('#capo-value').textContent = config.capo ? `第 ${config.capo} 品` : '不使用';
  $('#rhythm-field').hidden = config.pattern !== 'strum';
}
function acceptScore(score) {
  state.score = score; state.dirty = false;
  $('#dirty-note').hidden = true;
  $('#generate span').textContent = '更新我的编配';
  $('#bpm').placeholder = `${score.bpm}（已自动识别）`;
  $('#offset').placeholder = `${score.offset}（自动估计）`;
  $('#song-title').value = score.title; $('#song-title').disabled = true;
  syncControls(score.config);
  $('#capo-suggestions').hidden = false;
  $('#capo-suggestions').innerHTML = '试试更顺手的指型：<br>' + score.capo_suggestions.map(item => `<button data-capo="${item.capo}" title="常用开放和弦占比约 ${Math.round(item.easy_ratio * 100)}%">${item.capo ? `夹 ${item.capo} 品` : '不夹'}${item === score.capo_suggestions[0] ? ' · 推荐' : ''}</button>`).join('');
  $$('[data-capo]').forEach(button => button.addEventListener('click', () => { $('#capo').value = button.dataset.capo; $('#capo').dispatchEvent(new Event('input')); generate(); }));
  $('#workspace-state').textContent = '编配完成，开始练习'; $('#step-three').classList.add('active');
  $('#step-two').classList.add('active');
  $('#score-title').textContent = score.title;
  $('#score-meta').innerHTML = `<div><small>速度 · 估计</small><strong>${score.bpm} <i>BPM</i></strong></div><div><small>原调 · 估计</small><strong>${esc(score.key)}</strong></div><div><small>变调夹</small><strong>${score.config.capo ? score.config.capo + ' <i>品</i>' : '无'}</strong></div><div><small>演奏方式</small><strong><i>${score.config.pattern === 'strum' ? '扫弦伴奏' : '分解和弦'} · ${score.config.meter}/4</i></strong></div>`;
  const peak = Math.max(...score.waveform, 0.01);
  $('#waveform').innerHTML = score.waveform.filter((_, i) => i % 2 === 0).map(v => `<i style="height:${Math.max(3, v / peak * 38)}px"></i>`).join('');
  const audioUrl = `/api/jobs/${state.id}/audio`;
  if ($('#source-audio').getAttribute('src') !== audioUrl) $('#source-audio').src = audioUrl;
  $('#chord-cards').innerHTML = score.chords.map(chordCard).join('');
  $('#score-count').textContent = `${score.measures.length} 小节 · ${clock(score.duration)}`;
  $('#review-text').textContent = score.review_count ? `${score.review_count} 处和弦建议复核（橙色圆点）。点击和弦名称可修改；试听原音时，小节会跟随高亮。` : '点击和弦名称可修改指型。试听原音时，小节会跟随高亮；建议校对节奏和起拍。';
  $$('[data-export]').forEach(link => { link.href = `/api/jobs/${state.id}/export/${link.dataset.export}`; link.setAttribute('download', ''); });
  state.page = Math.min(state.page, Math.max(0, Math.ceil(score.measures.length / PAGE_SIZE) - 1));
  renderPage(); setView('result');
  localStorage.setItem('stringspace-job', state.id);
}
async function generate() {
  if (state.busy) return;
  let config;
  try { config = configFromControls(); } catch (error) { return toast(error.message); }
  stopPlayback(); $('#source-audio').pause();
  if (state.score) {
    setBusy(true);
    try {
      const score = await api(`/api/jobs/${state.id}/arrange`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(config)});
      acceptScore(score); toast('编配已更新，试听和导出已同步。');
    } catch (error) { toast(error.message); }
    finally { setBusy(false); }
    return;
  }
  if (!state.file) return;
  const generation = ++state.generation;
  setBusy(true); setView('progress');
  $('#progress-message').textContent = '正在上传音乐'; $('#progress-fill').style.width = '1%'; $('#progress-percent').textContent = '1%';
  $('#workspace-state').textContent = '正在生成你的乐谱';
  try {
    const form = new FormData(); form.append('file', state.file); form.append('config', JSON.stringify(config)); form.append('title', $('#song-title').value);
    const result = await api('/api/jobs', {method:'POST', body:form}); state.id = result.id;
    localStorage.setItem('stringspace-job', state.id);
    await pollJob(generation);
  } catch (error) { showError(error.message); }
  finally { setBusy(false); }
}
async function pollJob(generation) {
  let failures = 0;
  while (generation === state.generation) {
    let result;
    try { result = await api(`/api/jobs/${state.id}`); failures = 0; }
    catch (error) { if (++failures >= 3) throw error; await new Promise(resolve => setTimeout(resolve, 1500)); continue; }
    if (result.status === 'completed') { acceptScore(result.score); return; }
    if (result.status === 'failed') throw new Error(result.message);
    $('#progress-message').textContent = result.message;
    $('#progress-fill').style.width = `${result.progress}%`; $('#progress-percent').textContent = `${result.progress}%`;
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
}
function showError(message) { $('#error-message').textContent = message; $('#workspace-state').textContent = '请检查文件或设置后重试'; setView('error'); }
$('#generate').addEventListener('click', generate);
$('#retry-button').addEventListener('click', () => state.file ? generate() : $('#file-input').click());

function chordCard(chord) {
  const positive = chord.frets.filter(v => v > 0);
  const start = positive.length && Math.max(...positive) > 4 ? Math.min(...positive) : 1;
  let svg = `<svg viewBox="0 0 76 90" aria-label="${esc(chord.name)} 和弦指型" role="img"><g stroke="#becbb4" stroke-width=".8">`;
  for (let i=0;i<6;i++) svg += `<path d="M${14+i*9} 20V76"/>`;
  for (let i=0;i<5;i++) svg += `<path d="M14 ${20+i*14}H59"/>`;
  svg += `</g><path d="M14 20H59" stroke="#739164" stroke-width="${start === 1 ? 2.5 : .8}"/>`;
  if (start > 1) svg += `<text x="5" y="30" fill="#a2ad96" font-size="8">${start}</text>`;
  chord.frets.forEach((fret, i) => {
    const x = 14 + i*9;
    if (fret === null) svg += `<text x="${x}" y="12" text-anchor="middle" fill="#a3ad97" font-size="9">×</text>`;
    else if (!fret) svg += `<circle cx="${x}" cy="9" r="2.3" stroke="#89a275" fill="none" stroke-width=".8"/>`;
    else svg += `<circle cx="${x}" cy="${27+(fret-start)*14}" r="3.4" fill="#678454"/>`;
  });
  svg += `<text x="38" y="88" text-anchor="middle" fill="#a9b29e" font-size="6.5">6　5　4　3　2　1</text></svg>`;
  return `<div class="chord-card"><strong>${esc(chord.name)}</strong>${svg}<small>实际响音 ${esc(chord.sounding)}</small></div>`;
}
function measureHTML(bar, print = false) {
  const meter = state.score.config.meter;
  const slots = meter * 2, x0 = 26, width = 221;
  const xpos = beat => x0 + 11 + beat / meter * (width - 7);
  let svg = '<svg viewBox="0 0 270 135" role="img" aria-label="第 '+bar.number+' 小节六线谱"><g stroke="#c5cdbd" stroke-width=".65">';
  for(let i=0;i<6;i++) svg += `<path d="M25 ${27+i*14}H262"/>`;
  svg += '<path d="M25 27V97M262 27V97"/></g>';
  ['e','B','G','D','A','E'].forEach((string,i) => svg += `<text x="10" y="${30+i*14}" fill="#a6b19c" font-size="8" font-family="monospace">${string}</text>`);
  for(let i=0;i<slots;i++) svg += `<text x="${xpos(i/2)}" y="128" text-anchor="middle" fill="#acb69f" font-size="7">${i%2 ? '&' : 1+i/2}</text>`;
  bar.events.forEach(event => {
    const x = xpos(event.beat);
    if (event.direction) svg += `<text x="${x}" y="14" text-anchor="middle" fill="#9eac8f" font-size="12">${event.direction === 'down' ? '↓' : '↑'}</text>`;
    // Each column is an eighth-note slot, with stems showing playable rhythm.
    svg += `<path d="M${x} 100V113" stroke="#9aa98b" stroke-width=".8"/>`;
    if(event.duration <= .51) svg += `<path d="M${x} 112l6 -3" stroke="#9aa98b" stroke-width="1.3"/>`;
    event.notes.forEach(note => { const y=27+(note.string-1)*14; svg += `<rect x="${x-5}" y="${y-6}" width="10" height="12" rx="2" fill="white"/><text x="${x}" y="${y+3.7}" text-anchor="middle" fill="#3d5735" font-size="10.5" font-family="monospace">${note.fret}</text>`; });
  });
  if(!bar.events.length) svg += '<text x="140" y="65" text-anchor="middle" fill="#9ca88f" font-size="11">休止</text>';
  svg += '</svg>';
  return `<article class="measure" data-measure="${bar.number}"><div class="measure-header"><span class="measure-number">${String(bar.number).padStart(2,'0')}</span>${bar.segments.map(segment => `<${print ? 'span' : 'button'} class="chord-button ${segment.edited ? 'edited' : segment.confidence < .55 && segment.sounding !== 'N' ? 'review' : ''}" data-segment="${segment.id}" title="${esc(segment.sounding)} · 点击校对">${segment.shape === 'N' ? '休止' : esc(segment.shape)}</${print ? 'span' : 'button'}>`).join('<span style="font-size:9px;color:#c2cbb9">→</span>')}<span class="measure-time">${clock(bar.start)}</span></div>${svg}</article>`;
}
function renderPage() {
  if (!state.score) return;
  const bars=state.score.measures.slice(state.page*PAGE_SIZE,(state.page+1)*PAGE_SIZE);
  $('#tab-grid').innerHTML = bars.map(bar => measureHTML(bar)).join('');
  $('#page-label').textContent = `${state.page+1} / ${Math.ceil(state.score.measures.length/PAGE_SIZE)}`;
  $('#previous-page').disabled = !state.page;
  $('#next-page').disabled = (state.page+1)*PAGE_SIZE >= state.score.measures.length;
  $$('#tab-grid [data-segment]').forEach(button => button.addEventListener('click', () => editChord(button.dataset.segment)));
}
function pageBy(delta) { stopPlayback(); state.page += delta; renderPage(); }
$('#previous-page').addEventListener('click', () => pageBy(-1));
$('#next-page').addEventListener('click', () => pageBy(1));
function highlight(time, follow = true) {
  if(!state.score) return;
  const index=state.score.measures.findIndex(bar => time >= bar.start && time < bar.end);
  if(index >= 0 && follow && Math.floor(index/PAGE_SIZE) !== state.page){ state.page=Math.floor(index/PAGE_SIZE); renderPage(); }
  $$('#tab-grid .measure').forEach(node => node.classList.toggle('playing', +node.dataset.measure === index+1));
}
$('#source-audio').addEventListener('timeupdate', () => { if(!$('#source-audio').paused) highlight($('#source-audio').currentTime); });
$('#source-audio').addEventListener('play', stopPlayback);
$('#source-audio').addEventListener('ended', () => highlight(-1));

async function editChord(id) {
  if(state.busy) return;
  if(state.dirty) return toast('请先更新编配，再修改和弦。');
  state.edit = state.score.measures.flatMap(bar => bar.segments).find(segment => segment.id === id);
  $('#edit-description').textContent = `${clock(state.edit.start)} — ${clock(state.edit.end)} · 实际响音 ${state.edit.sounding} · 变调夹 ${state.score.config.capo} 品`;
  $('#edit-chord').innerHTML = state.chords.map(chord => `<option value="${esc(chord)}">${chord === 'N' ? '休止 / 无和弦' : esc(chord)}</option>`).join('');
  $('#edit-chord').value = state.edit.shape;
  $('#chord-dialog').showModal();
}
function transpose(chord, semitones) {
  if(chord === 'N') return chord;
  const pitches=['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B'];
  const minor=chord.endsWith('m');
  const root=pitches.indexOf(minor ? chord.slice(0,-1) : chord);
  return pitches[(root+semitones+120)%12]+(minor?'m':'');
}
async function saveChord(reset = false) {
  if(state.busy) return;
  const config=structuredClone(state.score.config);
  if(reset) delete config.overrides[state.edit.id];
  else config.overrides[state.edit.id] = transpose($('#edit-chord').value, config.capo);
  setBusy(true); $('#save-chord').disabled = true; $('#reset-chord').disabled = true;
  stopPlayback(); $('#source-audio').pause();
  try {
    const score=await api(`/api/jobs/${state.id}/arrange`, {method:'POST', headers:{'Content-Type':'application/json'},body:JSON.stringify(config)});
    acceptScore(score); $('#chord-dialog').close(); toast(reset ? '已恢复自动识别结果。' : '和弦已修改。');
  } catch(error) { toast(error.message); }
  finally { setBusy(false); $('#save-chord').disabled = false; $('#reset-chord').disabled = false; }
}
$('#save-chord').addEventListener('click', () => saveChord());
$('#reset-chord').addEventListener('click', () => saveChord(true));

// Plucked-string synthesis with Karplus–Strong decay. No soundfonts or third-party audio requests.
function pluck(pitch, when, duration, level) {
  const rate=audioContext.sampleRate, frequency=440*2**((pitch-69)/12), period=Math.max(2,Math.round(rate/frequency));
  const length=Math.ceil(rate*Math.min(duration+0.12,2.5));
  const buffer=audioContext.createBuffer(1,length,rate), data=buffer.getChannelData(0);
  for(let i=0;i<period && i<length;i++) data[i]=(Math.random()*2-1)*.6;
  for(let i=period;i<length;i++) data[i]=.496*(data[i-period]+data[i-period+1]);
  const source=audioContext.createBufferSource(); source.buffer=buffer;
  const gain=audioContext.createGain(); gain.gain.setValueAtTime(level,when); gain.gain.setValueAtTime(level,when+Math.max(.01,duration-.04)); gain.gain.linearRampToValueAtTime(0,when+duration+.1);
  source.connect(gain); gain.connect(audioContext.destination); source.start(when);
  playingNodes.push(source);
  source.onended=()=>{ source.disconnect(); gain.disconnect(); playingNodes=playingNodes.filter(node=>node!==source); };
}
function stopPlayback() {
  playing=false; clearInterval(playbackTimer);
  playingNodes.forEach(node=>{try{node.stop();}catch{/* already ended */}}); playingNodes=[];
  $('#play-score').innerHTML='<svg><use href="#i-play"/></svg>'; $('#play-score').setAttribute('aria-label','试听生成的伴奏');
  $('#playback-label').textContent='试听编配';
  $$('.measure.playing').forEach(node=>node.classList.remove('playing'));
}
async function startPlayback() {
  if(playing){stopPlayback();return;}
  if(!state.score) return;
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)(); await audioContext.resume();
    $('#source-audio').pause();
    const speed=+$('#playback-speed').value;
    const bars=state.score.measures.slice(state.page*PAGE_SIZE), start=bars[0].start;
    const events=bars.flatMap(bar=>bar.events);
    const beginning=audioContext.currentTime+.1;
    let cursor=0;
    playing=true;
    $('#play-score').textContent='Ⅱ'; $('#play-score').setAttribute('aria-label','停止试听'); $('#playback-label').textContent='正在试听编配';
    function schedule(){
      const sourceTime=start+(audioContext.currentTime-beginning)*speed;
      while(cursor<events.length && events[cursor].time<sourceTime+.25*speed){
        const event=events[cursor++], onset=beginning+(event.time-start)/speed;
        event.notes.forEach((note,index)=>pluck(note.midi,Math.max(audioContext.currentTime,onset)+(event.direction ? index*.012:0),event.duration*60/state.score.bpm/speed,.35/Math.sqrt(event.notes.length)));
      }
      highlight(sourceTime);
      if(sourceTime>state.score.duration+.2) stopPlayback();
    }
    schedule(); playbackTimer=setInterval(schedule,40);
  } catch(error){ stopPlayback(); toast('浏览器未能播放音频，请检查音频权限或换用其他浏览器。'); }
}
$('#play-score').addEventListener('click', startPlayback);
$('#playback-speed').addEventListener('change', stopPlayback);
$('#print-button').addEventListener('click', () => {
  if(!state.score) return;
  const s=state.score;
  $('#print-score').innerHTML=`<h1>${esc(s.title)}</h1><p>${s.bpm} BPM · ${s.config.meter}/4 · 变调夹 ${s.config.capo} 品 · ${s.config.pattern === 'strum' ? '扫弦伴奏' : '分解和弦'} · 和弦名为指型，数字相对变调夹</p><p>自动伴奏编配，请对照原音校对。起拍：${s.offset} 秒。↓ 下扫，↑ 上扫。</p><div class="chord-cards">${s.chords.map(chordCard).join('')}</div><div class="tab-grid">${s.measures.map(bar=>measureHTML(bar,true)).join('')}</div>`;
  window.print();
});
$('#help-button').addEventListener('click', () => $('#help-dialog').showModal());
$('#delete-button').addEventListener('click', () => { if(!state.busy) $('#delete-dialog').showModal(); });
$('#confirm-delete').addEventListener('click', async () => {
  try { await api(`/api/jobs/${state.id}`,{method:'DELETE'}); stopPlayback(); $('#source-audio').pause(); localStorage.removeItem('stringspace-job'); window.location.reload(); }
  catch(error){toast(error.message);}
});
document.addEventListener('click', event => { if(!$('#export-menu').contains(event.target)) $('#export-menu').open=false; });
async function initialize() {
  try {state.chords=(await api('/api/chords')).chords;} catch {toast('无法连接制谱服务，请确认服务已启动。');return;}
  const id=localStorage.getItem('stringspace-job');
  if(!id) return;
  state.id=id; const generation=++state.generation;
  setBusy(true); setView('progress');
  try { await pollJob(generation); $('#file-name').textContent=state.score.title; $('#file-size').textContent='已恢复本机保存的作品'; $('#file-card').hidden=false; $('#dropzone').hidden=true; }
  catch(error){localStorage.removeItem('stringspace-job');showError(error.message);}
  finally {setBusy(false);}
}
initialize();
