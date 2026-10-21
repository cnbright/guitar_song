"""Validate the static site under a project subpath using a real local audio file.

Requires Playwright and Chromium. Run a static server before invoking this file.
This test does not upload the selected music to any server.
"""
import argparse
import json
from pathlib import Path

from playwright.sync_api import sync_playwright


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--file', type=Path, required=True)
    parser.add_argument('--base', default='http://127.0.0.1:8080/docs/')
    parser.add_argument('--browser')
    args = parser.parse_args()
    output = Path('artifacts/pages-check')
    output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        launch = {'headless': True, 'args': ['--no-sandbox']}
        if args.browser:
            launch['executable_path'] = args.browser
        browser = p.chromium.launch(**launch)
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        errors, requests = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('request', lambda request: requests.append(request.url))
        page.goto(args.base, wait_until='networkidle')
        assert page.evaluate('BROWSER_MODE'), 'The page is not configured for static hosting'
        page.locator('#file-input').set_input_files(str(args.file.resolve()))
        page.locator('#song-title').fill('网页版 · 音频测试')
        page.locator('#generate').click()
        page.wait_for_function("!document.querySelector('#result-state').hidden || !document.querySelector('#error-state').hidden", timeout=120000)
        assert page.locator('#error-state').is_hidden(), page.locator('#error-message').inner_text()
        page.wait_for_function('!state.busy')
        page.locator('#capo').evaluate("node=>{node.value=1;node.dispatchEvent(new Event('input'));}")
        page.locator('#generate').click()
        page.wait_for_function('!state.busy && state.score.config.capo === 1')
        score = page.evaluate('state.score')
        page.locator('#play-score').click()
        page.wait_for_timeout(800)
        assert page.evaluate('playing')
        page.locator('#play-score').click()
        page.reload(wait_until='networkidle')
        page.wait_for_function('state.score && !state.busy')
        assert page.evaluate('state.score.config.capo') == 1
        page.locator('#source-audio').evaluate('audio=>audio.play()')
        page.wait_for_timeout(1000)
        assert page.locator('#source-audio').evaluate('audio=>audio.currentTime>0')
        page.locator('#source-audio').evaluate('audio=>audio.pause()')
        page.locator('#tab-grid [data-segment="0"]').click()
        page.locator('#edit-chord').select_option('Am')
        page.locator('#save-chord').click()
        page.wait_for_function("!state.busy && state.score.measures[0].segments[0].shape === 'Am'")
        page.locator('#tab-grid [data-segment="0"]').click()
        page.locator('#reset-chord').click()
        page.wait_for_function('!state.busy && !state.score.measures[0].segments[0].edited')
        for kind in ['midi', 'musicxml', 'txt', 'json']:
            page.locator('#export-menu').evaluate('node=>node.open=true')
            with page.expect_download() as event:
                page.locator(f'[data-export="{kind}"]').click()
            event.value.save_as(str(output / event.value.suggested_filename))
        page.locator('[data-pattern="strum"]').click()
        page.locator('#generate').click()
        page.wait_for_function("!state.busy && state.score.config.pattern === 'strum'")
        assert page.evaluate('state.score.measures[0].events[0].notes.length') > 1
        page.evaluate('window.print=()=>{}')
        page.locator('#print-button').click()
        page.pdf(path=str(output / 'score.pdf'), format='A4', print_background=True)
        page.set_viewport_size({'width':390,'height':844})
        assert page.evaluate('document.body.scrollWidth') == 390
        page.screenshot(path=str(output / 'mobile.png'), full_page=True)
        assert not errors, errors
        assert not any('/api/' in url for url in requests), requests
        # Ensure delete removes the source Blob and saved score from IndexedDB.
        page.locator('#delete-button').click()
        page.locator('#confirm-delete').click()
        page.wait_for_function("!document.querySelector('#empty-state').hidden")
        assert not page.evaluate("localStorage.getItem('stringspace-job')")
        report = {'passed':True,'bpm':score['bpm'],'measures':len(score['measures']),
                  'api_requests':0,'browser_errors':errors,'checks':['decode','chord_analysis','capo',
                  'synthesis','original_audio','indexeddb_restore','edit_reset','strum','exports','pdf','mobile','delete']}
        (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps(report, ensure_ascii=False))
        browser.close()


if __name__ == '__main__':
    main()
