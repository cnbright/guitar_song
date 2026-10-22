import io
import json
import xml.etree.ElementTree as ET
from pathlib import Path

import mido
import numpy as np
import pytest

from app.arrangement import CHORDS, OPEN_MIDI, arrange, note_events, parse_chord, transpose_chord, voicing
from app.exports import midi_bytes, musicxml_bytes, text_tab
from app.models import ArrangementConfig


@pytest.fixture
def features(tmp_path):
    # Four exact, independent chord regions: C, Am, F, G at 120 BPM.
    chroma = np.zeros((12, 400), dtype=np.float32)
    for index, chord in enumerate(['C', 'Am', 'F', 'G']):
        root, quality = parse_chord(chord)
        for pitch in [root, (root + (3 if quality else 4)) % 12, (root + 7) % 12]:
            chroma[pitch, index * 100:(index + 1) * 100] = 1
    np.savez(tmp_path / 'features.npz', chroma=chroma, rms=np.full(400, .1))
    (tmp_path / 'analysis.json').write_text(json.dumps({'duration': 8, 'bpm': 120, 'offset': 0,
          'sample_rate': 100, 'hop': 2, 'waveform': [.5] * 10}))
    return tmp_path


@pytest.mark.parametrize('capo', [0, 1, 2, 5, 7, 12])
def test_capo_voicings_preserve_actual_chord(capo):
    for chord in CHORDS:
        root, quality = parse_chord(chord)
        expected = {root, (root + (3 if quality else 4)) % 12, (root + 7) % 12}
        shape = transpose_chord(chord, -capo)
        frets = voicing(shape)
        actual = {(OPEN_MIDI[i] + fret + capo) % 12 for i, fret in enumerate(frets) if fret is not None}
        assert actual == expected
        assert transpose_chord(shape, capo) == chord


def test_recognition_and_manual_override(features):
    score = arrange(features, ArrangementConfig(), 'test')
    assert [bar['segments'][0]['sounding'] for bar in score['measures']] == ['C', 'Am', 'F', 'G']
    score = arrange(features, ArrangementConfig(capo=2, overrides={'0': 'D'}), 'test')
    segment = score['measures'][0]['segments'][0]
    assert segment['sounding'] == 'D' and segment['shape'] == 'C' and segment['edited']
    assert score['measures'][0]['events'][0]['notes'][0]['midi'] == 50  # C-shape bass + capo 2 = D3


@pytest.mark.parametrize('pattern', ['arpeggio', 'strum'])
def test_note_constraints_and_exports(features, pattern):
    score = arrange(features, ArrangementConfig(capo=1, pattern=pattern), '中文 & <乐谱>')
    for bar in score['measures']:
        for event in bar['events']:
            assert 0 <= event['beat'] < 4
            assert event['time'] < score['duration']
            assert len({note['string'] for note in event['notes']}) == len(event['notes'])
            for note in event['notes']:
                assert note['midi'] == OPEN_MIDI[6-note['string']] + note['fret'] + 1
    midi = mido.MidiFile(file=io.BytesIO(midi_bytes(score)), charset='utf8')
    assert midi.tracks[0][0].name == score['title']
    assert sum(message.type == 'note_on' for message in midi.tracks[0]) == sum(len(e['notes']) for b in score['measures'] for e in b['events'])
    assert 7.5 <= midi.length <= 8.1
    xml = ET.fromstring(musicxml_bytes(score))
    assert xml.findtext('work/work-title') == score['title']
    assert xml.findtext('.//capo') == '1'
    for measure in xml.findall('.//measure'):
        assert sum(int(note.findtext('duration')) for note in measure.findall('note') if note.find('chord') is None) == 1920
    assert 'e|' in text_tab(score) and 'E|' in text_tab(score)


def test_half_measure_keeps_folk_strum_pattern(features):
    full = note_events('C', 0, 'strum', 'folk', 4)
    half = note_events('C', 0, 'strum', 'folk', 2) + note_events('G', 0, 'strum', 'folk', 2, 2)
    assert [(e['beat'], e['direction']) for e in full] == [(e['beat'], e['direction']) for e in half]
    score = arrange(features, ArrangementConfig(changes='half', pattern='strum'), 'test')
    assert len(score['measures'][0]['segments']) == 2
    assert len(score['measures'][0]['events']) == 6


def test_simplified_arpeggio_density_is_explicit(features):
    for rhythm, count in [('auto', 4), ('quarter', 4), ('eighth', 8)]:
        score = arrange(features, ArrangementConfig(arpeggio_rhythm=rhythm), 'density')
        assert len(score['measures'][0]['events']) == count
    assert len(note_events('G', 1, 'arpeggio', 'folk', 3, meter=3)) == 3


def test_three_four_and_last_partial_measure(features):
    score = arrange(features, ArrangementConfig(meter=3, bpm=100, offset=.4), 'test')
    for bar in score['measures']:
        for event in bar['events']:
            assert event['beat'] < 3
            assert event['time'] + event['duration'] * .6 <= score['duration'] + .002
    xml = ET.fromstring(musicxml_bytes(score))
    assert xml.findtext('.//beats') == '3'
    for measure in xml.findall('.//measure'):
        assert sum(int(n.findtext('duration')) for n in measure.findall('note') if n.find('chord') is None) == 1440


def test_silence_and_rest_override(features):
    np.savez(features / 'features.npz', chroma=np.zeros((12, 400)), rms=np.zeros(400))
    score = arrange(features, ArrangementConfig(), 'silence')
    assert not any(bar['events'] for bar in score['measures'])
    assert all(s['sounding'] == 'N' for b in score['measures'] for s in b['segments'])


def test_invalid_configuration(features):
    with pytest.raises(ValueError):
        ArrangementConfig(capo=13)
    with pytest.raises(ValueError):
        ArrangementConfig(bpm=0)
    with pytest.raises(ValueError):
        arrange(features, ArrangementConfig(offset=8), 'test')
    with pytest.raises(ValueError):
        arrange(features, ArrangementConfig(overrides={'0':'<script>'}), 'test')

