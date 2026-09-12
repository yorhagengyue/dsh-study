import argparse
import json
import sys
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

from .backend import StudyError
from .canvas import CanvasError, load_env
from .material_sync import safe_error
from .server import serve


def main():
    parser = argparse.ArgumentParser(description="DSH study material inputs")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("serve", "call"):
        sub = commands.add_parser(name)
        sub.add_argument("--root", type=Path, default=Path.cwd())
        sub.add_argument("--port", type=int, default=8766)
        if name == "serve":
            sub.add_argument("--parent-pid", type=int)
        else:
            sub.add_argument("operation", choices=("sources", "courses", "catalog", "refresh", "status", "read", "import_local"))
            sub.add_argument("--arguments", default="{}", help="Non-secret JSON operation arguments")
    args = parser.parse_args()
    try:
        if args.command == "serve":
            serve(args.root, args.port, args.parent_pid)
        else:
            token = load_env(args.root / ".env").get("STUDY_API_TOKEN", "")
            data = json.dumps({"operation": args.operation, "arguments": json.loads(args.arguments)}).encode("utf-8")
            request = Request(f"http://127.0.0.1:{args.port}/api/call", data=data,
                              headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
            try:
                response = build_opener(ProxyHandler({})).open(request, timeout=120)
            except HTTPError as exc:
                response = exc
            with response:
                result = json.loads(response.read())
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0 if result.get("ok") else 1
        return 0
    except (StudyError, CanvasError, OSError, ValueError) as exc:
        print(str(exc) if isinstance(exc, StudyError) else safe_error(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
