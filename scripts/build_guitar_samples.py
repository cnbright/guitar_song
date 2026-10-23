"""Build the checked-in, self-hosted acoustic guitar bank (requires FFmpeg).

Run manually to reproduce it; normal builds use the bank already in the repo.
Source recordings: Iowa, distributed by tonejs-instruments under CC BY 3.0.
"""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import urllib.request

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
REVISION = '622c2f1c32c8cfce4158ddc3eb26e518ddef37e5'
RATE = 22050
PITCHES = ('C', 'Cs', 'D', 'Ds', 'E', 'F', 'Fs', 'G', 'Gs', 'A', 'As', 'B')


def sample(midi):
    name = f'{PITCHES[midi % 12]}{midi // 12 - 1}.wav'
    url = f'https://raw.githubusercontent.com/nbrosowsky/tonejs-instruments/{REVISION}/samples/guitar-acoustic/{name}'
    with urllib.request.urlopen(url, timeout=60) as response:
        source = response.read()
    decoded = subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
                              '-ac', '1', '-ar', str(RATE), '-f', 'f32le', 'pipe:1'],
                             input=source, capture_output=True, check=True).stdout
    audio = np.frombuffer(decoded, dtype='<f4').copy()
    # Remove only leading recording silence; keep the real pick transient.
    active = np.flatnonzero(np.abs(audio) > np.max(np.abs(audio)) * .015)
    start = max(0, int(active[0]) - int(RATE * .004))
    audio = audio[start:start + RATE * 4]
    audio -= np.mean(audio)
    rms = np.sqrt(np.mean(audio[int(RATE * .035):int(RATE * .2)] ** 2))
    audio *= min(.18 / max(rms, 1e-6), .9 / max(np.max(np.abs(audio)), 1e-6))
    fade = min(len(audio), int(RATE * .05))
    audio[-fade:] *= np.linspace(1, 0, fade)
    pcm = np.round(audio * 32767).astype('<i2').tobytes()
    return {'midi': midi, 'source': name, 'source_sha256': hashlib.sha256(source).hexdigest(),
            'trim_start': start, 'length': len(audio)}, pcm


def main():
    entries, payload = [], bytearray()
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for entry, pcm in pool.map(sample, range(40, 75, 2)):
            entry['offset'] = len(payload)
            entries.append(entry)
            payload.extend(pcm)
    header = json.dumps({'version': 'iowa-acoustic-v1', 'sample_rate': RATE,
                         'source_revision': REVISION, 'samples': entries}, separators=(',', ':')).encode()
    destination = ROOT / 'static/instruments/acoustic-guitar.bin'
    destination.parent.mkdir(exist_ok=True)
    destination.write_bytes(b'SGS1' + struct.pack('<I', len(header)) + header + payload)
    print(f'Built {len(entries)} acoustic guitar samples, {destination.stat().st_size:,} bytes')


if __name__ == '__main__':
    main()
