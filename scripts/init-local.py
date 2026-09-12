"""Initialize ignored local configuration; never replace existing credentials."""
from pathlib import Path
import secrets
import json

root = Path(__file__).resolve().parents[1]
created, preserved = [], []
files = {
    '.env': '# Local credentials only; never commit this file.\n'
            'CANVAS_BASE_URL=\nCANVAS_API_TOKEN=\nSTUDY_API_TOKEN=' + secrets.token_urlsafe(40) + '\n',
    'sources.local.json': (root / 'sources.example.json').read_text(encoding='utf-8'),
}
for name, data in files.items():
    try:
        with (root / name).open('x', encoding='utf-8', newline='\n') as file:
            file.write(data)
        created.append(name)
    except FileExistsError:
        preserved.append(name)
print(json.dumps({'created': created, 'preserved': preserved, 'credentials_printed': False}))
