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
    parser.add_argument('--capo',type=int,default=0)
    parser.add_argument('--aihe',action='store_true',help='Check the supplied reference excerpt against its displayed chord sheet')
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
        page.locator('#capo').evaluate("(node,value)=>{node.value=value;node.dispatchEvent(new Event('input'));}",args.capo)
        page.locator('#generate').click()
        page.wait_for_function('(capo)=>!state.busy && state.score.config.capo === capo',arg=args.capo)
        score = page.evaluate('state.score')
        assert page.evaluate('StringspaceGuitar.ready')
        assert score['comparison']['renderer_version']=='iowa-acoustic-v1'
        assert any('/instruments/acoustic-guitar.bin' in url for url in requests)
        if score.get('accompaniment'):
            assert score['config']['pattern']=='arpeggio'
            assert not score.get('source_notes') and not score.get('quality')
            assert not any('/vendor/transcriber' in url or '/vendor/model/' in url for url in requests)
            if args.aihe:
                assert len(score['measures'][0]['events'])==4
                assert [[n['midi'] for n in e['notes']] for e in score['measures'][0]['events']]==[[44],[56],[60,68],[56]]
                assert [b['segments'][0]['shape'] for b in score['measures'][:8]]==['G','D','Em','C','G','Em','Am','D']
                assert score['measures'][1]['segments'][0]['display_shape']=='D/F#'
                assert score['measures'][1]['events'][0]['notes'][0]['midi']==43
                expected=[[[44],[56],[60,68],[56]],[[43],[58],[63,67],[58]],[[41],[56],[60,65],[56]],[[49],[56],[61,65],[56]],[[44],[56],[60,68],[56]],[[41],[56],[60,65],[56]],[[46],[58],[61,65],[58]],[[51],[58],[63,67],[58]]]
                assert [[[n['midi'] for n in e['notes']] for e in bar['events']] for bar in score['measures'][:8]]==expected
            for rhythm,count in [('quarter',4),('eighth',8)]:
                page.locator('#arpeggio-rhythm').select_option(rhythm)
                page.locator('#generate').click()
                page.wait_for_function('(r)=>!state.busy && state.score.config.arpeggio_rhythm===r',arg=rhythm)
                assert page.evaluate('state.score.measures[0].events.length')==count
            page.locator('#arpeggio-rhythm').select_option('auto')
            page.locator('#generate').click()
            page.wait_for_function("!state.busy && state.score.config.arpeggio_rhythm==='auto'")
        (output / 'score-initial.json').write_text(json.dumps(score,ensure_ascii=False))
        assert score['comparison']['status'] in ['failed','passed']
        if score['comparison']['status']=='failed':
            assert page.locator('#print-button').is_disabled()
            assert page.locator('[data-export="midi"]').get_attribute('aria-disabled')=='true'
            assert ('待校对' if score.get('accompaniment') else '未通过验收') in page.locator('.success-tag').inner_text()
        # Both sources restart at exactly the same bounded selection.
        page.locator('#ab-start').fill('0.75')
        page.locator('#ab-end').fill('1.4')
        page.locator('#ab-original').click()
        page.wait_for_timeout(1000)
        assert page.locator('#source-audio').evaluate('a=>a.paused && a.currentTime>=1.4 && a.currentTime<1.6')
        page.locator('#ab-generated').click()
        page.wait_for_timeout(250)
        assert page.evaluate('playing')
        page.wait_for_timeout(800)
        assert not page.evaluate('playing')
        page.locator('#play-score').click()
        page.wait_for_timeout(800)
        assert page.evaluate('playing')
        page.locator('#play-score').click()
        # Restored old comparisons must be recomputed for the new audible sound,
        # while the score's notes and actual timing stay unchanged.
        saved_events=page.evaluate('JSON.stringify(state.score.measures)')
        page.evaluate('''async()=>{
          const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('stringspace-browser-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=reject;});
          await new Promise((resolve,reject)=>{
            const t=db.transaction('jobs','readwrite'),store=t.objectStore('jobs'),r=store.get(state.id);
            r.onsuccess=()=>{const job=r.result;delete job.score.comparison.renderer_version;store.put(job);};
            t.oncomplete=resolve;t.onerror=reject;
          });db.close();
        }''')
        page.reload(wait_until='networkidle')
        page.wait_for_function('state.score && !state.busy')
        assert page.evaluate('StringspaceGuitar.ready')
        assert page.evaluate('state.score.comparison.renderer_version')=='iowa-acoustic-v1'
        assert page.evaluate('JSON.stringify(state.score.measures)')==saved_events
        page.reload(wait_until='networkidle')
        page.wait_for_function('state.score && !state.busy')
        assert page.evaluate('StringspaceGuitar.ready')
        assert page.evaluate('JSON.stringify(state.score.measures)')==saved_events
        assert page.evaluate('state.score.config.capo') == args.capo
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
        if score['comparison']['status']=='failed':
            page.locator('#draft-consent').check()
            assert page.locator('#print-button').is_enabled()
        with page.expect_download() as event:
            page.locator('#download-audio').click()
        event.value.save_as(str(output / 'sampled-guitar.wav'))
        assert page.evaluate('''async()=>{
          const pcm=new DataView(await (await fetch(document.querySelector('#download-audio').href)).arrayBuffer());
          const rendered=StringspaceVerification.render(state.score);
          if(pcm.getUint32(24,true)!==22050||pcm.byteLength!==44+rendered.length*2)return false;
          for(let i=0;i<rendered.length;i+=1021)if(Math.abs(pcm.getInt16(44+i*2,true)/32767-rendered[i])>.00004)return false;
          return true;
        }''')
        for kind in ['midi', 'musicxml', 'txt', 'json']:
            page.locator('#export-menu').evaluate('node=>node.open=true')
            with page.expect_download() as event:
                page.locator(f'[data-export="{kind}"]').click()
            event.value.save_as(str(output / event.value.suggested_filename))
        page.locator('[data-pattern="strum"]').click()
        page.locator('#generate').click()
        page.wait_for_function("!state.busy && state.score.config.pattern === 'strum'")
        assert page.evaluate('state.score.measures[0].events[0].notes.length') > 1
        if score['config']['pattern']!='strum':
            page.locator(f'[data-pattern="{score["config"]["pattern"]}"]').click()
            page.locator('#generate').click()
            page.wait_for_function('(pattern)=>!state.busy && state.score.config.pattern===pattern',arg=score['config']['pattern'])
        if page.locator('#draft-consent-row').is_visible():
            page.locator('#draft-consent').check()
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
                  'quality':score.get('quality'),'accompaniment':score.get('accompaniment'),'comparison':score['comparison']['overall'],
                  'api_requests':0,'browser_errors':errors,'checks':['decode','chord_analysis','capo',
                  'synthesis','original_audio','bounded_ab','comparison','export_gate','indexeddb_restore','edit_reset','strum','exports','pdf','mobile','delete']}
        (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps(report, ensure_ascii=False))
        browser.close()


if __name__ == '__main__':
    main()
