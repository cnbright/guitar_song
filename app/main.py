import json
import logging
import os
import re
import shutil
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from .arrangement import CHORDS_WITH_REST, arrange
from .audio import analyze
from .exports import midi_bytes, musicxml_bytes, text_tab
from .models import ArrangementConfig

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get('GUITAR_DATA_DIR', ROOT / '.data' / 'jobs'))
DATA.mkdir(parents=True, exist_ok=True)
MAX_BYTES = 100 * 1024 * 1024
executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='audio-analysis')
capacity = threading.BoundedSemaphore(4)
state_lock = threading.RLock()
logger = logging.getLogger('guitar')


def save(folder: Path, name: str, value: dict):
    with state_lock:
        temp = folder / (name + '.tmp')
        temp.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
        temp.replace(folder / name)


def read(folder: Path, name: str) -> dict:
    with state_lock:
        return json.loads((folder / name).read_text(encoding='utf-8'))


@asynccontextmanager
async def lifespan(app):
    for status_file in DATA.glob('*/status.json'):
        status = read(status_file.parent, 'status.json')
        if status['status'] in ('queued', 'processing'):
            save(status_file.parent, 'status.json', {**status, 'status': 'failed',
                 'message': '上一次分析被服务重启中断，请重新上传。'})
    yield


app = FastAPI(title='弦间 · 吉他伴奏制谱', lifespan=lifespan)


def job_folder(job_id: str) -> Path:
    if not re.fullmatch(r'[a-f0-9]{32}', job_id):
        raise HTTPException(404, '找不到这份乐谱。')
    folder = DATA / job_id
    if not (folder / 'status.json').exists():
        raise HTTPException(404, '找不到这份乐谱。')
    return folder


def completed(job_id: str) -> Path:
    folder = job_folder(job_id)
    if read(folder, 'status.json')['status'] != 'completed':
        raise HTTPException(409, '乐谱还没有生成完成。')
    return folder


def process(folder: Path, config: ArrangementConfig, title: str):
    def progress(value, message):
        save(folder, 'status.json', {'id': folder.name, 'status': 'processing', 'progress': value, 'message': message})
    try:
        analyze(folder / 'source', folder, progress)
        progress(85, '正在编配指法与六线谱')
        result = arrange(folder, config, title)
        save(folder, 'score.json', result)
        save(folder, 'status.json', {'id': folder.name, 'status': 'completed', 'progress': 100, 'message': '乐谱已生成'})
    except Exception as exc:
        logger.exception('Analysis failed for %s', folder.name)
        message = str(exc) if isinstance(exc, ValueError) else '分析遇到问题，请换一段音频重试。详细原因已记录在服务日志。'
        save(folder, 'status.json', {'id': folder.name, 'status': 'failed', 'progress': 0, 'message': message})
    finally:
        (folder / 'source').unlink(missing_ok=True)
        capacity.release()


@app.get('/api/health')
def health():
    return {'status': 'ok', 'ffmpeg': bool(shutil.which('ffmpeg')), 'version': '1.0.0', 'mode': 'accompaniment'}


@app.get('/api/chords')
def chords():
    return {'chords': CHORDS_WITH_REST}


@app.post('/api/jobs', status_code=202)
async def upload(file: UploadFile = File(...), config: str = Form('{}'), title: str = Form('')):
    try:
        options = ArrangementConfig.model_validate_json(config)
    except ValidationError as exc:
        raise HTTPException(422, '配置不正确，请检查速度、变调夹和拍号。') from exc
    if not capacity.acquire(blocking=False):
        raise HTTPException(429, '正在处理较多文件，请稍后再试。')
    job_id = uuid.uuid4().hex
    folder = DATA / job_id
    folder.mkdir()
    submitted = False
    try:
        length = 0
        with (folder / 'source').open('wb') as target:
            while chunk := await file.read(1024 * 1024):
                length += len(chunk)
                if length > MAX_BYTES:
                    raise HTTPException(413, '文件超过 100 MB，请先截取需要练习的片段。')
                target.write(chunk)
        if not length:
            raise HTTPException(400, '上传的文件是空的。')
        clean_title = (title.strip() or Path(file.filename or '我的乐谱').stem)[:120]
        save(folder, 'status.json', {'id': job_id, 'status': 'queued', 'progress': 3, 'message': '音频已收到，等待分析'})
        executor.submit(process, folder, options, clean_title)
        submitted = True
    finally:
        await file.close()
        if not submitted:
            capacity.release()
            shutil.rmtree(folder, ignore_errors=True)
    return {'id': job_id}


@app.get('/api/jobs/{job_id}')
def status(job_id: str):
    folder = job_folder(job_id)
    result = read(folder, 'status.json')
    if result['status'] == 'completed':
        result['score'] = read(folder, 'score.json')
    return result


@app.post('/api/jobs/{job_id}/arrange')
def rearrange(job_id: str, config: ArrangementConfig):
    folder = completed(job_id)
    with state_lock:
        previous = read(folder, 'score.json')
        try:
            score = arrange(folder, config, previous['title'])
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        save(folder, 'score.json', score)
    return score


@app.get('/api/jobs/{job_id}/audio')
def original_audio(job_id: str):
    folder = completed(job_id)
    return FileResponse(folder / 'audio.wav', media_type='audio/wav')


@app.get('/api/jobs/{job_id}/export/{kind}')
def export(job_id: str, kind: str):
    score = read(completed(job_id), 'score.json')
    formats = {'midi': (midi_bytes, 'audio/midi', 'mid'),
               'musicxml': (musicxml_bytes, 'application/vnd.recordare.musicxml+xml', 'musicxml'),
               'txt': (lambda data: text_tab(data).encode('utf-8'), 'text/plain; charset=utf-8', 'txt'),
               'json': (lambda data: json.dumps(data, ensure_ascii=False, indent=2).encode('utf-8'), 'application/json', 'json')}
    if kind not in formats:
        raise HTTPException(404, '不支持的导出格式。')
    renderer, media_type, extension = formats[kind]
    return Response(renderer(score), media_type=media_type,
                    headers={'Content-Disposition': f'attachment; filename="guitar-score.{extension}"'})


@app.delete('/api/jobs/{job_id}', status_code=204)
def delete(job_id: str):
    folder = job_folder(job_id)
    with state_lock:
        if read(folder, 'status.json')['status'] in ('queued', 'processing'):
            raise HTTPException(409, '请等待分析结束后再删除。')
        shutil.rmtree(folder)
    return Response(status_code=204)


app.mount('/', StaticFiles(directory=ROOT / 'static', html=True), name='static')
