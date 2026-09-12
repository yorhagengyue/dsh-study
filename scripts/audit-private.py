"""Check tracked/staged files without printing credential values or course contents."""
from pathlib import Path
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode('utf-8').split('\0')
    secrets = []
    env = ROOT / '.env'
    if env.exists():
        for line in env.read_text(encoding='utf-8-sig').splitlines():
            if '=' not in line or line.lstrip().startswith('#'):
                continue
            key, value = line.split('=', 1)
            value = value.strip().strip(chr(34)).strip(chr(39))
            if any(part in key.upper() for part in ('TOKEN', 'KEY', 'PASSWORD', 'SECRET')) and len(value) >= 8:
                secrets.append(value.encode('utf-8'))
    failures = []
    forbidden = {'state', 'runtime', 'work', 'student', 'raw', 'content', 'node_modules', '.venv', '.git'}
    files = [item for item in tracked if item]
    for name in files:
        path = Path(name)
        if path.parts[0] in forbidden or path.name in {'.env', 'sources.local.json'} or (path.name.startswith('.env.') and path.name != '.env.example'):
            failures.append({'path': name, 'reason': 'private_path_tracked'})
        disk = ROOT / path
        if disk.is_file() and any(secret in disk.read_bytes() for secret in secrets):
            failures.append({'path': name, 'reason': 'credential_value_present'})
        staged = subprocess.run(['git', 'show', ':' + name], cwd=ROOT, capture_output=True)
        if staged.returncode == 0 and any(secret in staged.stdout for secret in secrets):
            failures.append({'path': name, 'reason': 'credential_value_staged'})
    print(json.dumps({'passed': not failures, 'tracked_files': len(files), 'credential_fields_checked': len(secrets), 'failures': failures}, ensure_ascii=False))
    return bool(failures)


if __name__ == '__main__':
    sys.exit(main())
