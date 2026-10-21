import io
import xml.etree.ElementTree as ET

import mido

from .arrangement import OPEN_MIDI, parse_chord


def midi_bytes(score: dict) -> bytes:
    midi = mido.MidiFile(ticks_per_beat=480, charset='utf8')
    track = mido.MidiTrack()
    midi.tracks.append(track)
    track.append(mido.MetaMessage('track_name', name=score['title']))
    track.append(mido.MetaMessage('set_tempo', tempo=mido.bpm2tempo(score['bpm'])))
    track.append(mido.MetaMessage('time_signature', numerator=score['config']['meter'], denominator=4))
    track.append(mido.Message('program_change', program=24))
    events = []
    for measure in score['measures']:
        for event in measure['events']:
            onset = round(((measure['number'] - 1) * score['config']['meter'] + event['beat']) * 480)
            for i, note in enumerate(event['notes']):
                delay = i * 9 if event['direction'] else 0
                events.append((onset + delay, True, note['midi']))
                events.append((onset + delay + max(1, round(event['duration'] * 480 * 0.92)), False, note['midi']))
    previous = 0
    for tick, on, pitch in sorted(events, key=lambda item: (item[0], item[1])):
        track.append(mido.Message('note_on' if on else 'note_off', note=pitch,
                                  velocity=76 if on else 0, time=tick - previous))
        previous = tick
    output = io.BytesIO()
    midi.save(file=output)
    return output.getvalue()


def _el(parent, name, text=None, **attributes):
    element = ET.SubElement(parent, name, attributes)
    if text is not None:
        element.text = str(text)
    return element


def _pitch(parent, midi, tag='pitch'):
    element = _el(parent, tag)
    names = [('C', 0), ('C', 1), ('D', 0), ('E', -1), ('E', 0), ('F', 0),
             ('F', 1), ('G', 0), ('A', -1), ('A', 0), ('B', -1), ('B', 0)]
    step, alter = names[midi % 12]
    _el(element, 'step', step)
    if alter:
        _el(element, 'alter', alter)
    _el(element, 'octave', midi // 12 - 1)


def musicxml_bytes(score: dict) -> bytes:
    root = ET.Element('score-partwise', version='4.0')
    _el(_el(root, 'work'), 'work-title', score['title'])
    identification = _el(root, 'identification')
    _el(identification, 'creator', '弦间 · 自动伴奏编配', type='arranger')
    part_list = _el(root, 'part-list')
    score_part = _el(part_list, 'score-part', id='P1')
    _el(score_part, 'part-name', 'Guitar')
    part = _el(root, 'part', id='P1')
    meter = score['config']['meter']
    for bar in score['measures']:
        measure = _el(part, 'measure', number=str(bar['number']))
        if bar['number'] == 1:
            attrs = _el(measure, 'attributes')
            _el(attrs, 'divisions', 480)
            time = _el(attrs, 'time')
            _el(time, 'beats', meter)
            _el(time, 'beat-type', 4)
            clef = _el(attrs, 'clef')
            _el(clef, 'sign', 'TAB')
            _el(clef, 'line', 5)
            details = _el(attrs, 'staff-details')
            _el(details, 'staff-lines', 6)
            for index, pitch in enumerate(OPEN_MIDI):
                tuning = _el(details, 'staff-tuning', line=str(index + 1))
                _el(tuning, 'tuning-step', ['E', 'A', 'D', 'G', 'B', 'E'][index])
                _el(tuning, 'tuning-octave', pitch // 12 - 1)
            _el(details, 'capo', score['config']['capo'])
            direction = _el(measure, 'direction')
            _el(_el(direction, 'direction-type'), 'words',
                f"Capo {score['config']['capo']} · 和弦名为指型 · 自动伴奏编配")
            _el(direction, 'sound', tempo=str(score['bpm']))
        for segment in bar['segments']:
            if segment['shape'] == 'N':
                continue
            chord_root, quality = parse_chord(segment['shape'])
            harmony = _el(measure, 'harmony')
            chord = _el(harmony, 'root')
            name = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'][chord_root]
            _el(chord, 'root-step', name[0])
            if len(name) > 1:
                _el(chord, 'root-alter', 1 if name[1] == '#' else -1)
            _el(harmony, 'kind', 'minor' if quality else 'major')
            _el(harmony, 'offset', round((segment['start'] - bar['start']) * score['bpm'] / 60 * 480))
        position = 0

        def rest(ticks):
            if ticks > 0:
                n = _el(measure, 'note')
                _el(n, 'rest')
                _el(n, 'duration', ticks)

        for event in bar['events']:
            onset = round(event['beat'] * 480)
            rest(onset - position)
            ticks = max(1, round(event['duration'] * 480))
            for i, data in enumerate(event['notes']):
                note = _el(measure, 'note')
                if i:
                    _el(note, 'chord')
                _pitch(note, data['midi'])
                _el(note, 'duration', ticks)
                if ticks in (240, 480):
                    _el(note, 'type', 'eighth' if ticks == 240 else 'quarter')
                technical = _el(_el(note, 'notations'), 'technical')
                _el(technical, 'string', data['string'])
                _el(technical, 'fret', data['fret'])
            position = onset + ticks
        rest(meter * 480 - position)
    ET.indent(root)
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)


def text_tab(score: dict) -> str:
    config = score['config']
    lines = [score['title'], f"{score['bpm']} BPM | {config['meter']}/4 | Capo {config['capo']}",
             '和弦为指型；0 表示变调夹后的空弦。自动伴奏编配，请对照原音校对。', '']
    for bar in score['measures']:
        lines.append(f"第 {bar['number']} 小节 ({bar['start']:.2f}s)  " + ' → '.join(s['shape'] for s in bar['segments']))
        width = config['meter'] * 2
        rows = [['---' for _ in range(width)] for _ in range(6)]
        rhythm = ['   ' for _ in range(width)]
        for event in bar['events']:
            slot = round(event['beat'] * 2)
            if slot >= width:
                continue
            if event['direction']:
                rhythm[slot] = ' ↓ ' if event['direction'] == 'down' else ' ↑ '
            for note in event['notes']:
                rows[note['string'] - 1][slot] = str(note['fret']).center(3, '-')
        lines.append('  ' + ''.join(rhythm))
        for label, row in zip(['e', 'B', 'G', 'D', 'A', 'E'], rows):
            lines.append(label + '|' + ''.join(row) + '|')
        lines.append('')
    return '\n'.join(lines)

