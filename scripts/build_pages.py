"""Build a self-contained GitHub Pages site without Python runtime dependencies."""
import argparse
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ['index.html', 'style.css', 'app.js', 'favicon.svg', 'engine.js', 'transcription.js', 'verification.js', 'guitar.js', 'accompaniment.js',
          'audio-worker.js', 'browser-backend.js', 'site-config.js']


def build(destination: Path):
    destination.mkdir(parents=True, exist_ok=True)
    for name in ASSETS:
        shutil.copyfile(ROOT / 'static' / name, destination / name)
    if not (ROOT / 'static/vendor/transcriber.js').exists():
        raise RuntimeError('Run npm ci and npm run build:model before building Pages.')
    shutil.copytree(ROOT / 'static/vendor', destination / 'vendor', dirs_exist_ok=True)
    shutil.copytree(ROOT / 'static/instruments', destination / 'instruments', dirs_exist_ok=True)
    (destination / 'site-config.js').write_text("window.STRINGSPACE_MODE='browser';\n", encoding='utf-8')
    (destination / '.nojekyll').touch()
    print(f'Built {len(ASSETS)} assets in {destination}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, default=ROOT / 'docs')
    build(parser.parse_args().out)
