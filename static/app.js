'use strict';
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = {file: null, id: null, score: null, pattern: 'arpeggio', page: 0, busy: false, dirty: false, edit: null, chords: [], generation: 0};
const PAGE_SIZE = 12;
const BROWSER_MODE = window.STRINGSPACE_MODE === 'browser';
if (BROWSER_MODE) {
  state.pattern = 'transcribe';
  $('#generate span').textContent = '生成转录草稿';
  $('.hero p').textContent = '把一段吉他录音，整理成可试听、可校对的六线谱。先核对短片段，再开始练习。';
  $('.under-button').textContent = '识别实际音符与时间 · 生成待校对草稿';
  $('[data-pattern="transcribe"]').hidden = false;
  $('#max-fret-field').hidden = false;
  $$('[data-pattern]').forEach(button => {button.classList.toggle('selected',button.dataset.pattern === 'transcribe');button.setAttribute('aria-pressed',String(button.dataset.pattern === 'transcribe'));});
  $('#pattern-explanation').textContent = '适合清晰的吉他独奏音轨。转录结果是需校对的草稿，可能漏音或多音；普通歌曲混音不保证可用。';
  $('#processing-location').textContent = '浏览器处理 · 音频不上传';
  $('.help-note').insertAdjacentHTML('afterend', '<p class="field-hint">网页版直接在浏览器内分析音乐，无需安装软件。可用格式取决于浏览器；优先使用 MP3、WAV 或 M4A。关闭页面会中断正在进行的分析，已完成作品保存在当前浏览器。</p>');
}
const esc = (value) => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clock = value => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
let toastTimer, audioContext, playbackTimer, abTimer, playingNodes = [], playing = false, playheadTime = 0;
const renderedScores=new WeakMap();
const patternName = p => ({transcribe:'原伴奏转录',strum:'简化扫弦',arpeggio:'简化分解'}[p] || '伴奏');

function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 4500); }
async function api(url, options = {}) {
  if (BROWSER_MODE) return window.StringspaceBrowser.api(url, options);
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
  if(BROWSER_MODE){
    state.pattern='transcribe';
    $$('[data-pattern]').forEach(button=>{const selected=button.dataset.pattern==='transcribe';button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));});
    $('#rhythm-field').hidden=true;
    $('#max-fret-field').hidden=false;
    $('#pattern-explanation').textContent='适合清晰的吉他音轨。先试听短片段并校对；普通歌曲混音不保证可用。';
  }
  $('#generate span').textContent = BROWSER_MODE ? '生成转录草稿' : '生成我的吉他谱';
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
  $('#max-fret-field').hidden = state.pattern !== 'transcribe';
  $('#pattern-explanation').textContent = state.pattern === 'transcribe' ? '保留识别出的实际音高与起音时间；仍是实验草稿，请先用短片段对照。' : '简化模式会改写原演奏节奏，不用于还原录音。';
  if(!state.score)$('#generate span').textContent=state.pattern==='transcribe'?'生成转录草稿':'生成简化编配';
}));
$('#capo').addEventListener('input', () => { $('#capo-value').textContent = +$('#capo').value ? `第 ${$('#capo').value} 品` : '不使用'; changed(); });
['rhythm', 'meter', 'bpm', 'offset', 'changes', 'max-fret'].forEach(id => $(`#${id}`).addEventListener('change', changed));

function configFromControls() {
  const config = {capo: +$('#capo').value, pattern: state.pattern, rhythm: $('#rhythm').value,
    meter: +$('#meter').value, bpm: $('#bpm').value ? +$('#bpm').value : null,
    offset: $('#offset').value ? +$('#offset').value : null, changes: $('#changes').value,
    max_fret:+$('#max-fret').value, overrides: state.score ? {...state.score.config.overrides} : {}};
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
  $('#max-fret').value = config.max_fret??7;$('#max-fret-field').hidden = config.pattern !== 'transcribe';
  $('#pattern-explanation').textContent = config.pattern === 'transcribe' ? '保留识别出的实际音高与起音时间；仍是实验草稿，请先用短片段对照。' : '简化模式会改写原演奏节奏，不用于还原录音。';
}
function exportAllowed(){return !BROWSER_MODE||state.score?.comparison?.status==='passed'||$('#draft-consent').checked;}
function updateExportGate(){
  const allowed=exportAllowed();$('#print-button').disabled=!allowed;
  $$('[data-export]').forEach(link=>{
    link.setAttribute('aria-disabled',String(!allowed));link.tabIndex=allowed?0:-1;
    if(allowed&&link.dataset.downloadUrl)link.href=link.dataset.downloadUrl;else link.removeAttribute('href');
  });
}
$$('[data-export]').forEach(link=>link.addEventListener('click',event=>{
  if(!exportAllowed()){event.preventDefault();toast('未通过验收。请先查看差异；如需校对，请勾选“仅导出草稿”。');}
}));
$('#draft-consent').addEventListener('change',updateExportGate);
function showComparison(score){
  $('#comparison-panel').hidden=!BROWSER_MODE;
  if(!BROWSER_MODE)return;
  const report=score.comparison,passed=report?.status==='passed',overall=report?.overall;
  $('#draft-consent').checked=false;$('#draft-consent-row').hidden=passed;
  $('#comparison-summary').textContent=overall?(passed?'达到当前自动门槛，仍需试听校对。':'未通过验收：不可当作原曲谱使用。'):'这份旧结果没有原音验收记录，请点击更新，重新分析原文件。';
  $('#comparison-metrics').innerHTML=overall?[
    ['原音 / 生成起音',`${overall.reference_attacks} / ${overall.generated_attacks}`],
    ['多弹 / 漏弹',`${overall.extra_attacks} / ${overall.missing_attacks}`],
    ['查准 / 召回',`${Math.round(overall.precision*100)}% / ${Math.round(overall.recall*100)}%`],
    ['起音时间差 P95',overall.timing_p95===null?'无匹配':`${Math.round(overall.timing_p95*1000)}ms`],
    ['音高谱相似度',`${(overall.pitch_similarity*100).toFixed(1)}%`]
  ].map(([label,value])=>`<div><small>${label}</small><strong>${value}</strong></div>`).join(''):'';
  $('#comparison-rows').innerHTML=(report?.sections||[]).map(row=>`<tr class="${row.passed?'':'comparison-failed'}"><td><button data-compare-measure="${row.measure}">${row.measure} · 对照</button></td><td>${row.reference_attacks} / ${row.generated_attacks}</td><td>${row.extra_attacks} / ${row.missing_attacks}</td><td>${row.timing_p95===null?'—':Math.round(row.timing_p95*1000)+'ms'}</td><td>${(row.pitch_similarity*100).toFixed(1)}%</td><td>${row.passed?'达标':esc(row.failures.join('、'))}</td></tr>`).join('');
  $('#comparison-details-label').textContent=overall?`逐小节差异 · ${report.sections.filter(r=>!r.passed).length} / ${report.sections.length} 小节未达标`:'尚未验收';
  $$('[data-compare-measure]').forEach(button=>button.addEventListener('click',()=>{
    const row=report.sections.find(r=>r.measure===+button.dataset.compareMeasure);
    stopPlayback();$('#source-audio').pause();$('#ab-start').value=row.start;$('#ab-end').value=row.end;
    $('#ab-original').focus();
  }));
  $('#ab-start').value=0;$('#ab-end').value=Math.min(score.duration,score.measures[0]?.end??4).toFixed(3);
  $('#ab-start').max=score.duration;$('#ab-end').max=score.duration;
  $('#download-report').href=window.StringspaceBrowser.exportURL(score,'report');
  $('#download-audio').href=window.StringspaceBrowser.exportURL(score,'wav');
  updateExportGate();
}
function acceptScore(score) {
  state.score = score; state.dirty = false;
  $('#dirty-note').hidden = true;
  $('#generate span').textContent = score.config.pattern === 'transcribe' ? '更新转录草稿' : '更新简化编配';
  $('#bpm').placeholder = `${score.bpm}（已自动识别）`;
  $('#offset').placeholder = `${score.offset}（自动估计）`;
  $('#song-title').value = score.title; $('#song-title').disabled = true;
  syncControls(score.config);
  $('#capo-suggestions').hidden = false;
  $('#capo-suggestions').innerHTML = '试试更顺手的指型：<br>' + score.capo_suggestions.map(item => `<button data-capo="${item.capo}" title="常用开放和弦占比约 ${Math.round(item.easy_ratio * 100)}%">${item.capo ? `夹 ${item.capo} 品` : '不夹'}${item === score.capo_suggestions[0] ? ' · 推荐' : ''}</button>`).join('');
  $$('[data-capo]').forEach(button => button.addEventListener('click', () => { $('#capo').value = button.dataset.capo; $('#capo').dispatchEvent(new Event('input')); generate(); }));
  const comparisonPassed=score.comparison?.status==='passed';
  $('#workspace-state').textContent = BROWSER_MODE?(comparisonPassed?'达到自动门槛，仍需校对':'未通过原音验收'):score.quality?'转录草稿已生成，请先试听校对':'简化编配已生成'; $('#step-three').classList.add('active');
  $('#step-two').classList.add('active');
  $('#score-title').textContent = score.title;
  $('#score-meta').innerHTML = `<div><small>速度 · 估计</small><strong>${score.bpm} <i>BPM</i></strong></div><div><small>原调 · 估计</small><strong>${esc(score.key)}</strong></div><div><small>变调夹</small><strong>${score.config.capo ? score.config.capo + ' <i>品</i>' : '无'}</strong></div><div><small>出谱方式</small><strong><i>${patternName(score.config.pattern)} · ${score.config.meter}/4</i></strong></div>`;
  $('#quality-banner').textContent = BROWSER_MODE?`${comparisonPassed?'达到当前自动检查门槛，仍需人工校对。':'未通过原音验收。以下是用于定位问题的草稿，不是可靠的原曲谱。'} ${score.quality?`保留 ${score.quality.retained_notes} 个音符，${score.quality.unmapped_notes} 个未映射；合并 ${score.quality.unsupported_retriggers??0} 个缺少该音高起音支持的重复音。`:'固定节奏的简化编配会改写原演奏。'}`:'这是固定节奏的简化编配，不能还原原伴奏。';
  $('.success-tag').textContent = BROWSER_MODE?(comparisonPassed?'自动检查达标':'未通过验收'):'简化编配';
  const peak = Math.max(...score.waveform, 0.01);
  $('#waveform').innerHTML = score.waveform.filter((_, i) => i % 2 === 0).map(v => `<i style="height:${Math.max(3, v / peak * 38)}px"></i>`).join('');
  const audioUrl = BROWSER_MODE ? window.StringspaceBrowser.audioURL(state.id) : `/api/jobs/${state.id}/audio`;
  if ($('#source-audio').getAttribute('src') !== audioUrl) $('#source-audio').src = audioUrl;
  $('#chord-cards').innerHTML = score.chords.map(chordCard).join('');
  $('#score-count').textContent = `${score.measures.length} 小节 · ${clock(score.duration)}`;
  $('#review-text').textContent = score.quality ? '检测到的音符仍可能有漏音、泛音误识别或不便弹的指法。请先用“原音对照”检查短片段；点和弦只修改标注，逐音编辑可导出到打谱软件。' : `${score.review_count} 处和弦建议复核。点击和弦名称可修改；固定节奏不代表原曲演奏。`;
  $$('[data-export]').forEach(link => {
    const kind = link.dataset.export;
    link.dataset.downloadUrl = BROWSER_MODE ? window.StringspaceBrowser.exportURL(score, kind) : `/api/jobs/${state.id}/export/${kind}`;
    link.href=link.dataset.downloadUrl;
    link.setAttribute('download', `guitar-${BROWSER_MODE&&!comparisonPassed?'failed-draft':'score'}.${kind === 'midi' ? 'mid' : kind}`);
  });
  showComparison(score);
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
    let progressPoll;
    if (state.pattern === 'transcribe' && (!state.score.quality||!state.score.comparison?.version)) {
      setView('progress');
      $('#progress-message').textContent = '正在重新识别原音中的音符';
      progressPoll = setInterval(async () => {try {const job = await api(`/api/jobs/${state.id}`);$('#progress-message').textContent=job.message;$('#progress-fill').style.width=`${job.progress}%`;} catch {/* The main request handles errors. */}},1000);
    }
    try {
      const score = await api(`/api/jobs/${state.id}/arrange`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(config)});
      acceptScore(score); toast(BROWSER_MODE&&score.comparison?.status!=='passed'?'更新完成，但未通过原音验收，请查看差异。':'编配已更新，试听和导出已同步。');
    } catch (error) { setView('result'); toast(error.message); }
    finally { clearInterval(progressPoll); setBusy(false); }
    return;
  }
  if (!state.file) return;
  const generation = ++state.generation;
  setBusy(true); setView('progress');
  $('#progress-message').textContent = BROWSER_MODE ? '正在读取本机音乐' : '正在上传音乐'; $('#progress-fill').style.width = '1%'; $('#progress-percent').textContent = '1%';
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
  $('#edit-description').textContent = `${clock(state.edit.start)} — ${clock(state.edit.end)} · 实际响音 ${state.edit.sounding} · 变调夹 ${state.score.config.capo} 品${state.score.quality ? '。转录模式只修改和弦标注，不改写音符。' : ''}`;
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

// Playback uses exactly the deterministic audio measured by the comparison worker.
function renderedAudio(score){
  if(!renderedScores.has(score))renderedScores.set(score,window.StringspaceVerification.render(score));
  return renderedScores.get(score);
}
function abRange(){
  const start=+$('#ab-start').value,end=+$('#ab-end').value;
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>state.score.duration+.001)throw new Error('请设置有效的对照片段起止时间。');
  return {start,end};
}
function stopPlayback() {
  clearInterval(abTimer);
  playing=false; clearInterval(playbackTimer);
  playingNodes.forEach(node=>{try{node.stop();}catch{/* already ended */}}); playingNodes=[];
  $('#play-score').innerHTML='<svg><use href="#i-play"/></svg>'; $('#play-score').setAttribute('aria-label','试听生成的伴奏');
  $('#playback-label').textContent=state.score?.quality?'试听转录草稿':'试听简化编配';
  $$('.measure.playing').forEach(node=>node.classList.remove('playing'));
}
async function startPlayback(range=null) {
  if(playing&&!range){stopPlayback();return;}
  if(!state.score)return;
  stopPlayback();clearInterval(abTimer);
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();await audioContext.resume();
    const originalTime=!$('#source-audio').paused?$('#source-audio').currentTime:null;
    $('#source-audio').pause();
    const speed=+$('#playback-speed').value,start=range?.start??originalTime??state.score.measures[state.page*PAGE_SIZE].start;
    const end=range?.end??state.score.duration,samples=renderedAudio(state.score);
    const buffer=audioContext.createBuffer(1,samples.length,22050);buffer.copyToChannel(samples,0);
    const source=audioContext.createBufferSource();source.buffer=buffer;source.playbackRate.value=speed;source.connect(audioContext.destination);
    const beginning=audioContext.currentTime+.1;source.start(beginning,start,end-start);playingNodes.push(source);playing=true;
    source.onended=()=>{source.disconnect();if(playing&&playingNodes.includes(source))stopPlayback();};
    $('#play-score').textContent='Ⅱ';$('#play-score').setAttribute('aria-label','停止试听');$('#playback-label').textContent='正在试听生成音';
    playbackTimer=setInterval(()=>{playheadTime=start+(audioContext.currentTime-beginning)*speed;highlight(playheadTime);},40);
  }catch(error){stopPlayback();toast(error.message||'浏览器未能播放音频。');}
}
$('#play-score').addEventListener('click', () => startPlayback());
$('#playback-speed').addEventListener('change', stopPlayback);
$('#compare-source').addEventListener('click', async () => {
  if(!state.score)return;
  const time=playing?playheadTime:state.score.measures[state.page*PAGE_SIZE].start;
  stopPlayback();$('#source-audio').currentTime=time;$('#source-audio').playbackRate=+$('#playback-speed').value;
  try{await $('#source-audio').play();}catch{toast('原音无法播放，请重新选择文件。');}
});
$('#ab-generated').addEventListener('click',()=>{
  try{startPlayback(abRange());}catch(error){toast(error.message);}
});
$('#ab-original').addEventListener('click',async()=>{
  try{
    const range=abRange();stopPlayback();const audio=$('#source-audio');audio.pause();audio.currentTime=range.start;audio.playbackRate=+$('#playback-speed').value;
    await audio.play();abTimer=setInterval(()=>{if(audio.currentTime>=range.end){audio.pause();clearInterval(abTimer);}},20);
  }catch(error){toast(error.message||'原音无法播放。');}
});
$('#print-button').addEventListener('click', () => {
  if(!state.score||!exportAllowed()) return;
  const s=state.score;
  $('#print-score').innerHTML=`<h1>${esc(s.title)}${BROWSER_MODE&&s.comparison?.status!=='passed'?' · 未通过验收草稿':''}</h1><p>${s.bpm} BPM · ${s.config.meter}/4 · 变调夹 ${s.config.capo} 品 · ${patternName(s.config.pattern)} · 和弦名为指型，数字相对变调夹</p><p>${s.quality?'逐音转录草稿，可能漏音、多音或选错弦位，请逐段校对。':'固定节奏的简化编配，不代表原伴奏。'} 起拍：${s.offset.toFixed(3)} 秒。</p><div class="chord-cards">${s.chords.map(chordCard).join('')}</div><div class="tab-grid">${s.measures.map(bar=>measureHTML(bar,true)).join('')}</div>`;
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
