"""Optional browser integration check against a running local application."""
import argparse
import json
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


def main():
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--file', type=Path)
    source.add_argument('--job')
    parser.add_argument('--browser', help='Optional path to an existing Chromium executable')
    parser.add_argument('--base', default='http://127.0.0.1:8000')
    parser.add_argument('--aihe', action='store_true', help='Assert chords for the provided Aihe video')
    args = parser.parse_args()
    output = Path('artifacts')
    output.mkdir(exist_ok=True)
    with sync_playwright() as p:
        options = {'headless': True, 'args': ['--no-sandbox']}
        if args.browser:
            options['executable_path'] = args.browser
        browser = p.chromium.launch(**options)
        page = browser.new_page(viewport={'width': 1440, 'height': 1100}, device_scale_factor=1)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(args.base, wait_until='networkidle')
        started = time.monotonic()
        if args.job:
            page.evaluate('(id) => localStorage.setItem("stringspace-job", id)', args.job)
            page.reload(wait_until='networkidle')
        else:
            page.locator('#file-input').set_input_files(str(args.file.resolve()))
            page.locator('#song-title').fill('爱河 · 伴奏练习谱' if args.aihe else '浏览器测试 · 练习谱')
            page.locator('#generate').click()
        page.wait_for_function("!document.querySelector('#result-state').hidden || !document.querySelector('#error-state').hidden", timeout=180000)
        assert page.locator('#error-state').is_hidden(), page.locator('#error-message').inner_text()
        page.wait_for_function('!state.busy')
        page.locator('#capo').evaluate("element => {element.value=1; element.dispatchEvent(new Event('input'));}")
        page.locator('[data-pattern="arpeggio"]').click()
        page.locator('#generate').click()
        page.wait_for_function("!state.busy && state.score.config.capo === 1 && state.score.config.pattern === 'arpeggio'")
        score = page.evaluate('state.score')
        job_id = page.evaluate('state.id')
        (output / 'test-job-id.txt').write_text(job_id)
        (output / 'aihe-score.json').write_text(json.dumps(score, ensure_ascii=False, indent=2))
        if args.aihe:
            assert [bar['segments'][0]['shape'] for bar in score['measures'][:8]] == ['G', 'D', 'Em', 'C', 'G', 'Em', 'Am', 'D']
        page.screenshot(path=str(output / 'desktop-result.png'), full_page=True)
        assert len(page.locator('#tab-grid').evaluate('node => getComputedStyle(node).gridTemplateColumns').split()) == 3
        page.locator('#play-score').click()
        page.wait_for_timeout(1000)
        assert page.evaluate('playing'), 'Playback did not start'
        assert page.locator('.measure.playing').count() == 1, 'Playback did not follow the score'
        page.locator('#play-score').click()
        original = score['measures'][0]['segments'][0]['shape']
        alternate = 'Am' if original != 'Am' else 'C'
        page.locator('#tab-grid [data-segment="0"]').click()
        page.locator('#edit-chord').select_option(alternate)
        page.locator('#save-chord').click()
        page.wait_for_function('(expected) => !state.busy && state.score.measures[0].segments[0].shape === expected', arg=alternate)
        page.locator('#tab-grid [data-segment="0"]').click()
        page.locator('#reset-chord').click()
        page.wait_for_function('(expected) => !state.busy && state.score.measures[0].segments[0].shape === expected', arg=original)
        page.locator('[data-pattern="strum"]').click()
        page.locator('#generate').click()
        page.wait_for_function("!state.busy && state.score.config.pattern === 'strum'")
        assert page.evaluate('state.score.measures[0].events[0].notes.length') > 1
        if len(score['measures']) > 12:
            page.locator('#next-page').click()
            assert page.locator('#page-label').inner_text().startswith('2 /')
        page.reload(wait_until='networkidle')
        page.wait_for_function('!!state.score && !state.busy')
        assert page.evaluate('state.score.config.pattern') == 'strum'
        page.locator('[data-pattern="arpeggio"]').click()
        page.locator('#generate').click()
        page.wait_for_function("!state.busy && state.score.config.pattern === 'arpeggio'")
        page.evaluate('window.print = () => {}')
        page.locator('#print-button').click()
        page.pdf(path=str(output / '爱河-伴奏六线谱.pdf'), format='A4', print_background=True)
        for kind, extension in [('musicxml', 'musicxml'), ('midi', 'mid'), ('txt', 'txt'), ('json', 'json')]:
            response = page.request.get(f'{args.base}/api/jobs/{job_id}/export/{kind}')
            assert response.status == 200, f'{kind}: {response.status}'
            (output / f'爱河-伴奏六线谱.{extension}').write_bytes(response.body())
        page.locator('#source-audio').evaluate('audio => audio.play()')
        page.wait_for_timeout(1500)
        assert page.locator('#source-audio').evaluate('audio => audio.currentTime > 0'), 'Original audio did not play'
        page.locator('#source-audio').evaluate('audio => audio.pause()')
        page.set_viewport_size({'width':390,'height':844})
        page.screenshot(path=str(output / 'mobile-result.png'), full_page=True)
        assert page.evaluate('document.body.scrollWidth') == 390, 'Mobile layout overflows'
        # Validate a small mobile screen in the initial, empty state too.
        mobile = browser.new_page(viewport={'width':390,'height':844})
        mobile.goto(args.base, wait_until='networkidle')
        mobile.screenshot(path=str(output / 'mobile-empty.png'), full_page=True)
        assert mobile.evaluate('document.body.scrollWidth') == 390
        assert not errors, errors
        report = {'job_id':job_id, 'elapsed_seconds':round(time.monotonic()-started, 1),
                  'bpm':score['bpm'], 'key':score['key'], 'measures':len(score['measures']),
                  'first_shapes':[bar['segments'][0]['shape'] for bar in score['measures'][:8]],
                  'browser_errors':errors, 'status':'passed',
                  'checks':['capo', 'playback', 'original_audio', 'chord_edit_reset', 'strum',
                            'persistence', 'pdf', 'musicxml', 'midi', 'txt', 'json', 'mobile_layout']}
        (output / 'browser-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps(report, ensure_ascii=False), flush=True)
        browser.close()


if __name__ == '__main__':
    main()
