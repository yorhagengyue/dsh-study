"""Explicit live acceptance: one configured Canvas course and synthetic local files.

Requires the backend to be running. Does not print credentials or material bodies.
Results stay in ignored runtime/. No model calls or browser interaction.
"""
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import argparse
import base64
import hashlib
import json
import time
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8766)
    parser.add_argument('--canvas-source', default='sydney-example')
    parser.add_argument('--local-source', default='personal-example')
    parser.add_argument('--skip-refresh', action='store_true')
    args = parser.parse_args()
    env = {}
    for line in (ROOT / '.env').read_text(encoding='utf-8-sig').splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            env[key.strip()] = value.strip().strip(chr(34)).strip(chr(39))
    headers = {'Authorization': 'Bearer ' + env['STUDY_API_TOKEN'], 'Content-Type': 'application/json'}
    origin = 'http://127.0.0.1:' + str(args.port)

    def call(operation, arguments):
        request = Request(origin + '/api/call', data=json.dumps({'operation': operation, 'arguments': arguments}).encode(), headers=headers)
        with urlopen(request, timeout=120) as response:
            value = json.load(response)
        if not value.get('ok'):
            raise RuntimeError('Backend returned failure for ' + operation)
        return value['result']

    def wait(job):
        deadline = time.monotonic() + 1500
        reported = 0
        while job.get('status') == 'running':
            if time.monotonic() > deadline:
                raise RuntimeError('Acceptance timed out; job can be inspected through status')
            if time.monotonic() > reported:
                print(json.dumps({'waiting_for_source': job['source_id'], 'status': job['status']}, ensure_ascii=False), flush=True)
                reported = time.monotonic() + 45
            time.sleep(1)
            job = call('status', {'job_id': job['job_id']})
        if job.get('status') not in ('completed', 'partial'):
            raise RuntimeError('Acceptance job failed; inspect ignored state/jobs')
        return job

    record = {'at': datetime.now(timezone.utc).isoformat(), 'model_call': False, 'sources': []}
    try:
        urlopen(Request(origin + '/api/call', data=b'{"operation":"sources","arguments":{}}', headers={'Content-Type': 'application/json'}), timeout=10)
        raise AssertionError('Unauthenticated material operation succeeded')
    except HTTPError as error:
        assert error.code == 401
        record['unauthenticated_request'] = 401
    record['registered_sources'] = [s['source_id'] for s in call('sources', {})['sources']]
    for source_id, source_type in ((args.local_source, 'local'), (args.canvas_source, 'canvas')):
        if not source_id:
            continue
        row = {'source_id': source_id, 'type': source_type}
        course_result = call('courses', {'source_id': source_id, 'live': source_type == 'canvas'})
        row['visible_configured_courses'] = len(course_result['courses'])
        assert row['visible_configured_courses'] > 0
        if not args.skip_refresh:
            job = wait(call('import_local' if source_type == 'local' else 'refresh', {'source_id': source_id}))
            row['refresh'] = {k: job.get(k) for k in ('status', 'api_requests', 'course_count', 'resource_count', 'change_count')}
        catalog = call('catalog', {'source_id': source_id, 'limit': 500})
        resources = catalog['resources']
        row['resources'] = catalog['total']
        row['errors'] = catalog.get('errors', [])
        row['status_counts'] = {s: sum(r.get('status') == s for r in resources) for s in sorted({str(r.get('status')) for r in resources})}
        row['new_count'] = sum(bool(r.get('new')) for r in resources)
        file = next(r for r in resources if r.get('has_file') and r.get('available'))
        ident = {'source_id': source_id, 'course_id': file['course_id'], 'resource_id': file['resource_id']}
        read = call('read', {**ident, 'max_bytes': 65536})
        chunk = base64.b64decode(read['base64'], validate=True)
        assert len(chunk) == read['bytes_returned'] and len(chunk) > 0
        with urlopen(Request(origin + '/api/file?' + urlencode(ident), headers={**headers, 'Range': 'bytes=0-31'}), timeout=30) as response:
            sample = response.read()
            assert response.status == 206 and sample == chunk[:32]
            row['range'] = {'http_status': response.status, 'bytes': len(sample)}
        digest, length = hashlib.sha256(), 0
        with urlopen(Request(origin + '/api/file?' + urlencode(ident), headers=headers), timeout=60) as response:
            while data := response.read(65536):
                digest.update(data)
                length += len(data)
        assert length == read['size']
        assert digest.hexdigest() == file['checksum']
        row['file_read'] = {**ident, 'size': length, 'sha256': digest.hexdigest(), 'representation': read.get('representation'), 'text_available': read.get('text_available'), 'extraction_status': read.get('extraction_status')}
        body = next((r for r in resources if r.get('has_body') and r.get('available')), None)
        if body:
            body_read = call('read', {'source_id': source_id, 'course_id': body['course_id'], 'resource_id': body['resource_id'], 'max_bytes': 65536})
            assert body_read.get('bytes_returned', 0) > 0
            row['body_read'] = {'resource_id': body['resource_id'], 'bytes': body_read['bytes_returned'], 'text_available': body_read.get('text_available'), 'representation': body_read.get('representation')}
        record['sources'].append(row)
        print(json.dumps({'source_id': source_id, 'resource_count': row['resources'], 'file_bytes_verified': length, 'range_verified': True, 'error_count': len(row['errors'])}), flush=True)
    record['passed'] = True
    (ROOT / 'runtime').mkdir(exist_ok=True)
    (ROOT / 'runtime/backend-acceptance.json').write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'passed': True, 'report': 'runtime/backend-acceptance.json'}))


if __name__ == '__main__':
    main()
