"""Local audio decoding and baseline chroma-based chord recognition.

This is deliberately an editable accompaniment estimate, not a claim of exact
transcription of a mixed recording or its original guitar performance.
"""
import json
import subprocess
from pathlib import Path
from typing import Callable

import librosa
import numpy as np
import soundfile as sf

SAMPLE_RATE = 22050
HOP = 512
MAX_SECONDS = 600


def decode(source: Path, destination: Path) -> float:
    try:
        probe = subprocess.run(
            ['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe',
             '-show_entries', 'format=duration:stream=codec_type,duration',
             '-of', 'json', str(source)],
            capture_output=True, timeout=30, check=True,
        )
        info = json.loads(probe.stdout)
        streams = info.get('streams', [])
        if not any(s.get('codec_type') == 'audio' for s in streams):
            raise ValueError('文件没有可用的音轨，请上传含有声音的音乐或视频。')
        raw_duration = info.get('format', {}).get('duration')
        if raw_duration and float(raw_duration) > MAX_SECONDS:
            raise ValueError('请上传 10 分钟以内的片段。')
        subprocess.run(
            ['ffmpeg', '-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file,pipe',
             '-i', str(source), '-map', '0:a:0', '-vn', '-t', str(MAX_SECONDS + 1),
             '-ac', '1', '-ar', str(SAMPLE_RATE), '-c:a', 'pcm_s16le', str(destination)],
            capture_output=True, timeout=90, check=True,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        raise ValueError('无法读取这个音频文件，请尝试 MP3、WAV、M4A 或 MP4。') from exc
    duration = sf.info(destination).duration
    if duration > MAX_SECONDS:
        destination.unlink(missing_ok=True)
        raise ValueError('请上传 10 分钟以内的片段。')
    if duration < 2:
        raise ValueError('音频太短，请上传至少 2 秒的片段。')
    return duration


def analyze(source: Path, folder: Path, progress: Callable[[int, str], None]) -> dict:
    progress(12, '正在提取音轨')
    duration = decode(source, folder / 'audio.wav')
    y, sr = sf.read(folder / 'audio.wav', dtype='float32')
    if np.max(np.abs(y)) < 0.0005:
        raise ValueError('音轨接近静音，无法识别和弦。')
    progress(28, '正在分析节拍与和声')
    # The percussive component is discarded for chord analysis, but retained for
    # onset/beat estimation. HPSS does not isolate a guitar from other instruments.
    spectrum = librosa.stft(y, n_fft=2048, hop_length=HOP)
    harmonic, _ = librosa.decompose.hpss(spectrum, margin=(2.0, 4.0))
    harmonic_audio = librosa.istft(harmonic, hop_length=HOP, length=len(y))
    chroma = librosa.feature.chroma_cqt(
        y=harmonic_audio, sr=sr, hop_length=HOP,
        fmin=librosa.note_to_hz('C2'), n_octaves=5, bins_per_octave=36,
    ).astype(np.float32)
    progress(58, '正在建立和弦时间线')
    onset = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP)
    tempo, beat_frames = librosa.beat.beat_track(onset_envelope=onset, sr=sr, hop_length=HOP)
    bpm = float(np.asarray(tempo).reshape(-1)[0])
    if not np.isfinite(bpm) or bpm < 40 or bpm > 220:
        bpm = 90.0
    beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=HOP)
    # A beat tracker does not determine the musical downbeat. Expose this as an
    # editable first-bar offset and label it as an estimate in the UI.
    offset = float(beat_times[0]) if len(beat_times) else 0.0
    offset = min(offset, 30.0, max(0.0, duration - 2))
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=HOP)[0]
    length = min(chroma.shape[1], len(rms))
    np.savez_compressed(folder / 'features.npz', chroma=chroma[:, :length], rms=rms[:length])
    peaks = [float(np.max(np.abs(part))) for part in np.array_split(y, min(240, len(y))) if len(part)]
    meta = {
        'duration': round(duration, 3), 'bpm': round(bpm, 1),
        'offset': round(offset, 3), 'sample_rate': sr, 'hop': HOP,
        'waveform': peaks, 'beat_count': len(beat_times),
        'algorithm': 'hpss-cqt-viterbi-v1',
    }
    (folder / 'analysis.json').write_text(json.dumps(meta), encoding='utf-8')
    return meta

