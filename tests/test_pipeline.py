"""Exercise real decoding, audio recognition, job API, and malformed input."""
import io
import json
import time

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from app import main
from app.audio import analyze, decode
from app.arrangement import arrange
from app.models import ArrangementConfig


def guitar_wav():
    sr = 22050
    result = []
    for notes in ([48, 52, 55], [45, 48, 52], [41, 45, 48], [43, 47, 50]):
        t = np.arange(2 * sr) / sr
        block = np.zeros(len(t))
        for midi in notes:
            freq = 440 * 2 ** ((midi - 69) / 12)
            for harmonic in range(1, 5):
                block += .08 / harmonic * np.sin(2 * np.pi * harmonic * freq * t)
        # Four audible pulse attacks per bar, not a pure continuous test tone.
        envelope = .6 + .4 * np.exp(-((t % .5) * 10))
        result.append(block * envelope)
    output = io.BytesIO()
    sf.write(output, np.concatenate(result), sr, format='WAV')
    return output.getvalue()


def test_real_audio_recognition(tmp_path):
    source = tmp_path / 'song.wav'
    source.write_bytes(guitar_wav())
    analyze(source, tmp_path, lambda *_: None)
    score = arrange(tmp_path, ArrangementConfig(bpm=120, offset=0), 'generated chord progression')
    assert [b['segments'][0]['sounding'] for b in score['measures']] == ['C', 'Am', 'F', 'G']


def test_api_upload_process_rearrange_export_delete(tmp_path, monkeypatch):
    monkeypatch.setattr(main, 'DATA', tmp_path)
    with TestClient(main.app) as client:
        assert client.get('/api/health').json()['ffmpeg']
        assert client.post('/api/jobs', files={'file':('empty.mp3',b'')}).status_code == 400
        assert client.post('/api/jobs', files={'file':('x.wav',b'x')}, data={'config':'{"capo": 99}'}).status_code == 422
        response = client.post('/api/jobs', files={'file': ('song.wav', guitar_wav(), 'audio/wav')},
                               data={'config':json.dumps({'bpm':120,'offset':0}), 'title':'API pipeline'})
        assert response.status_code == 202
        job_id = response.json()['id']
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            job = client.get('/api/jobs/' + job_id).json()
            if job['status'] in ['completed', 'failed']:
                break
            time.sleep(.1)
        assert job['status'] == 'completed', job
        assert len(job['score']['measures']) == 4
        result = client.post(f'/api/jobs/{job_id}/arrange', json={'capo':2, 'pattern':'strum','bpm':120,'offset':0,'overrides':{'0':'D'}})
        assert result.status_code == 200
        assert result.json()['measures'][0]['segments'][0]['shape'] == 'C'
        assert client.post(f'/api/jobs/{job_id}/arrange', json={'offset':20}).status_code == 422
        audio = client.get(f'/api/jobs/{job_id}/audio', headers={'Range':'bytes=0-43'})
        assert audio.status_code == 206 and audio.content.startswith(b'RIFF')
        for kind in ['midi','musicxml','txt','json']:
            exported = client.get(f'/api/jobs/{job_id}/export/{kind}')
            assert exported.status_code == 200 and len(exported.content) > 100
        assert client.get('/api/jobs/not-a-valid-id').status_code == 404
        assert client.delete('/api/jobs/' + job_id).status_code == 204
        assert client.get('/api/jobs/' + job_id).status_code == 404


def test_invalid_and_silent_audio(tmp_path):
    source = tmp_path / 'bad.mp3'
    source.write_text('not audio')
    with pytest.raises(ValueError, match='无法读取'):
        decode(source, tmp_path / 'audio.wav')
    sf.write(source.with_suffix('.wav'), np.zeros(22050 * 3), 22050)
    with pytest.raises(ValueError, match='静音'):
        analyze(source.with_suffix('.wav'), tmp_path, lambda *_: None)

