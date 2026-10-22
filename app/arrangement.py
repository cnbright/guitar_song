"""Chord estimation, capo-aware playable voicings, and real tab note events."""
import json
from pathlib import Path

import numpy as np

from .models import ArrangementConfig

PITCHES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
OPEN_MIDI = [40, 45, 50, 55, 59, 64]  # string 6 -> string 1
MAJOR = ['x32010', 'x46664', 'xx0232', 'x68886', '022100', '133211',
         '244322', '320003', '466544', 'x02220', 'x13331', 'x24442']
MINOR = ['x35543', 'x46654', 'xx0231', 'x68876', '022000', '133111',
         '244222', '355333', '466444', 'x02210', 'x13321', 'x24432']
CHORDS = [p + quality for quality in ['', 'm'] for p in PITCHES]
CHORDS_WITH_REST = CHORDS + ['N']


def parse_chord(chord: str) -> tuple[int, str]:
    if chord not in CHORDS:
        raise ValueError(f'不支持的和弦：{chord}')
    quality = 'm' if chord.endswith('m') else ''
    return PITCHES.index(chord[:-1] if quality else chord), quality


def transpose_chord(chord: str, semitones: int) -> str:
    if chord == 'N':
        return chord
    root, quality = parse_chord(chord)
    return PITCHES[(root + semitones) % 12] + quality


def voicing(chord: str) -> list[int | None]:
    if chord == 'N':
        return [None] * 6
    root, quality = parse_chord(chord)
    return [None if v == 'x' else int(v) for v in (MINOR if quality else MAJOR)[root]]


def templates() -> np.ndarray:
    result = []
    for chord in CHORDS:
        root, quality = parse_chord(chord)
        v = np.full(12, -0.12)
        v[root] = 1.0
        v[(root + (3 if quality else 4)) % 12] = 0.85
        v[(root + 7) % 12] = 0.8
        result.append(v / np.linalg.norm(v))
    return np.array(result)


def estimate_key(chroma: np.ndarray) -> str:
    average = np.mean(chroma, axis=1)
    major = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
    minor = np.array([6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
    average = average - np.mean(average)
    scores = []
    for profile in [major, minor]:
        profile = profile - profile.mean()
        for root in range(12):
            scores.append(float(average @ np.roll(profile, root) / (np.linalg.norm(average) * np.linalg.norm(profile) + 1e-9)))
    best = int(np.argmax(scores))
    return PITCHES[best % 12] + ('m' if best >= 12 else '')


def recognize(chroma: np.ndarray, rms: np.ndarray, ranges: list[tuple[int, int]]) -> list[dict]:
    vectors, energy = [], []
    for lo, hi in ranges:
        hi = max(lo + 1, hi)
        part = chroma[:, lo:hi]
        vector = np.mean(part, axis=1) if part.size else np.zeros(12)
        vectors.append(vector / (np.linalg.norm(vector) + 1e-9))
        energy.append(float(np.mean(rms[lo:hi])) if len(rms[lo:hi]) else 0.0)
    scores = np.array(vectors) @ templates().T
    # Viterbi discourages spurious rapid chord changes, but cannot prove accuracy.
    transitions = np.full((24, 24), -0.13)
    np.fill_diagonal(transitions, 0)
    dp = scores[0].copy()
    history = []
    for row in scores[1:]:
        options = dp[:, None] + transitions
        history.append(np.argmax(options, axis=0))
        dp = options.max(axis=0) + row
    path = [int(np.argmax(dp))]
    for back in reversed(history):
        path.append(int(back[path[-1]]))
    path.reverse()
    threshold = max(0.0005, float(np.percentile(rms, 75)) * 0.045)
    output = []
    for index, state in enumerate(path):
        if energy[index] < threshold:
            output.append({'chord': 'N', 'confidence': 0.0})
            continue
        row = scores[index]
        margin = max(0.0, float(row[state] - np.max(np.delete(row, state))))
        # A relative fit indicator, not a calibrated probability.
        fit = float(np.clip(0.35 + margin * 3 + (row[state] - 0.65) * 0.65, 0.1, 0.95))
        output.append({'chord': CHORDS[state], 'confidence': round(fit, 2)})
    return output


def note_events(shape: str, capo: int, pattern: str, rhythm: str, beats: float, beat_offset: float = 0, meter: int = 4, arpeggio_rhythm: str = 'quarter') -> list[dict]:
    frets = voicing(shape)
    active = [i for i, f in enumerate(frets) if f is not None]
    if not active:
        return []
    bass = active[0]
    events = []
    slots = int(round(beats * 2))
    for slot in range(slots):
        global_slot = round(beat_offset * 2) + slot
        if pattern == 'strum':
            # Familiar 4/4 folk pattern: down, down-up, (rest)-up, down-up.
            if rhythm == 'steady':
                if global_slot % 2:
                    continue
                direction = 'down'
            else:
                if global_slot in ((1, 4) if meter == 4 else (1,)):
                    continue
                direction = 'up' if global_slot % 2 else 'down'
            indices = active if direction == 'down' else list(reversed([i for i in active if i >= 2]))
        else:
            if arpeggio_rhythm != 'eighth' and global_slot % 2:
                continue
            if arpeggio_rhythm == 'eighth':
                pattern_indices = [bass, 3, 4, 5, 4, 3] if meter == 3 else [bass, 3, 4, 3, 5, 3, 4, 3]
                index = pattern_indices[global_slot % len(pattern_indices)]
            else:
                pattern_indices = [bass, 3, 4] if meter == 3 else [bass, 3, 4, 5]
                index = pattern_indices[(global_slot // 2) % len(pattern_indices)]
            indices = [index if index in active else active[-1]]
            direction = None
        notes = [{'string': 6 - i, 'fret': frets[i], 'midi': OPEN_MIDI[i] + int(frets[i]) + capo} for i in indices]
        events.append({'beat': round(beat_offset + slot / 2, 3),
                       'duration': 1.0 if (pattern == 'strum' and rhythm == 'steady') or (pattern == 'arpeggio' and arpeggio_rhythm != 'eighth') else 0.5,
                       'direction': direction, 'notes': notes})
    return events


def arrange(folder: Path, config: ArrangementConfig, title: str) -> dict:
    meta = json.loads((folder / 'analysis.json').read_text())
    with np.load(folder / 'features.npz') as features:
        chroma, rms = features['chroma'], features['rms']
    bpm = config.bpm or meta['bpm']
    offset = config.offset if config.offset is not None else meta['offset']
    duration = meta['duration']
    if offset >= duration:
        raise ValueError('起拍时间必须早于音频结束。')
    beat_seconds = 60 / bpm
    bar_seconds = config.meter * beat_seconds
    step = bar_seconds / (2 if config.changes == 'half' else 1)
    starts = np.arange(offset, duration - 0.05, step)
    if not len(starts):
        raise ValueError('起拍时间后没有足够的音乐，请提前起拍时间。')
    ends = np.minimum(starts + step, duration)
    frame_rate = meta['sample_rate'] / meta['hop']
    ranges = [(min(chroma.shape[1] - 1, int(a * frame_rate)), min(chroma.shape[1], int(b * frame_rate))) for a, b in zip(starts, ends)]
    detected = recognize(chroma, rms, ranges)
    for value in config.overrides.values():
        if value not in CHORDS_WITH_REST:
            raise ValueError(f'不支持的和弦：{value}')
    segments = []
    for index, (start, end, detection) in enumerate(zip(starts, ends, detected)):
        chord = config.overrides.get(str(index), detection['chord'])
        segments.append({
            'id': str(index), 'start': round(float(start), 3), 'end': round(float(end), 3),
            'sounding': chord, 'shape': transpose_chord(chord, -config.capo),
            'confidence': detection['confidence'], 'edited': str(index) in config.overrides,
        })
    measures = []
    per_bar = 2 if config.changes == 'half' else 1
    for i in range(0, len(segments), per_bar):
        group = segments[i:i + per_bar]
        events = []
        for position, segment in enumerate(group):
            requested_beats = config.meter / per_bar
            available_beats = (segment['end'] - segment['start']) / beat_seconds
            new_events = note_events(segment['shape'], config.capo, config.pattern, config.rhythm,
                                     requested_beats, position * requested_beats, config.meter, config.arpeggio_rhythm)
            # Do not generate notes beyond the source's final partial measure.
            for event in new_events:
                local = event['beat'] - position * requested_beats
                if local >= available_beats - 0.015:
                    continue
                event['duration'] = round(min(event['duration'], available_beats - local), 3)
                event['time'] = round(segment['start'] + local * beat_seconds, 3)
                events.append(event)
        measures.append({'number': len(measures) + 1, 'start': group[0]['start'],
                         'end': group[-1]['end'], 'segments': group, 'events': events})
    unique = list(dict.fromkeys(s['shape'] for s in segments if s['shape'] != 'N'))
    chord_library = [{'name': shape, 'frets': voicing(shape),
                      'sounding': transpose_chord(shape, config.capo)} for shape in unique]
    recommendations = []
    for capo in range(0, 8):
        shapes = [transpose_chord(s['sounding'], -capo) for s in segments if s['sounding'] != 'N']
        easy = {'C', 'D', 'E', 'G', 'A', 'Am', 'Dm', 'Em'}
        score = sum(s in easy for s in shapes) / max(1, len(shapes))
        recommendations.append({'capo': capo, 'easy_ratio': round(score, 2)})
    recommendations.sort(key=lambda item: (-item['easy_ratio'], item['capo']))
    return {
        'title': title, 'duration': duration, 'bpm': round(bpm, 1), 'offset': round(offset, 3),
        'key': estimate_key(chroma), 'config': config.model_dump(),
        'measures': measures, 'chords': chord_library, 'waveform': meta['waveform'],
        'capo_suggestions': recommendations[:3],
        'review_count': sum(s['confidence'] < 0.55 and not s['edited'] and s['sounding'] != 'N' for s in segments),
        'warnings': ['这是自动识别和弦后的伴奏编配，不是原录音逐音扒谱。',
                     '速度与起拍为估计值；低把握和弦建议对照原音试听并修改。',
                     '当前支持大、小三和弦；七和弦、转位及装饰音可能被简化。'],
    }

