"""Reproduce stale TM-X text/image pairing with the real Data-receiver.py.

Runs an isolated Receiver on a temporary FTP port and a fake HTTP backend.
No Pi, MySQL, or production Receiver is contacted. Run with the Python
environment that normally runs Data-receiver.py (httpx, pyftpdlib, etc.).
"""

import argparse
import ftplib
import http.server
import importlib.util
import io
import json
import os
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

import replay_tmx_ftp as replay


ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "output" / "ftp_replay_offline"


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class FakeBackend(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port):
        super().__init__(("127.0.0.1", port), FakeHandler)
        self.session_state = "stopped"
        self.posts = []
        self.events = []


class FakeHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, data, status=200):
        encoded = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/session/state":
            self.reply({"session_id": 1, "state": self.server.session_state})
        elif path == "/api/review/capture":
            self.reply({"capture_id": "repro-capture"})
        else:
            self.reply({"detail": "not found"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if path == "/api/measurements":
            self.server.posts.append(json.loads(raw))
            self.reply({"measurement_id": len(self.server.posts), "result": "OK",
                        "measured": len(self.server.posts), "target": 1})
        elif path == "/api/session/event":
            self.server.events.append(json.loads(raw))
            self.reply({"ok": True})
        elif path.endswith("/image-upload"):
            self.reply({"ok": True})
        else:
            self.reply({"detail": "not found"}, 404)

    def do_PATCH(self):
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.reply({"ok": True})


def wait_for_ftp(port, process):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Data Receiver exited with code {process.returncode}")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.2)
    raise RuntimeError("Data Receiver did not open its FTP port")


def run_case(order, txt_delay):
    if not replay.SAMPLE_BMP.is_file():
        raise RuntimeError(f"Sample BMP missing: {replay.SAMPLE_BMP}")
    run_dir = RESULTS / f"{datetime.now():%Y%m%d_%H%M%S}_{order}"
    run_dir.mkdir(parents=True, exist_ok=True)
    ftp_port, backend_port = free_port(), free_port()
    while backend_port == ftp_port:
        backend_port = free_port()
    backend = FakeBackend(backend_port)
    server_thread = threading.Thread(target=backend.serve_forever, daemon=True)
    server_thread.start()
    env = os.environ.copy()
    env.update({
        "FORWARD_TO_BACKEND": "1",
        "TEMP_IMAGE_DIR": str(run_dir / "receiver-temp"),
        "BACKEND_URL": f"http://127.0.0.1:{backend_port}",
        "DATA_RECEIVER_FTP_HOST": "127.0.0.1",
        "DATA_RECEIVER_FTP_PORT": str(ftp_port),
        "DATA_RECEIVER_FTP_USER": "ftp_repro",
        "DATA_RECEIVER_FTP_PASS": "ftp_repro_only",
        "PYTHONIOENCODING": "utf-8",
    })
    log_path = run_dir / "receiver.log"
    process = None
    try:
        with log_path.open("wb") as log_file:
            process = subprocess.Popen(
                [sys.executable, "-u", str(ROOT / "Backend-server" / "Data-receiver.py")],
                cwd=ROOT, env=env, stdout=log_file, stderr=subprocess.STDOUT,
            )
            wait_for_ftp(ftp_port, process)
            # The real watcher polls every 3 s. Let it observe stopped first,
            # then plant a text row from an out-of-session TM-X trigger.
            time.sleep(4)
            stamp = datetime.now().strftime("%y%m%d_%H%M%S")
            date = stamp[:6]
            txt_rel = f"tm-x/result/SD1_023/{stamp}.txt"
            old_image = f"{date}/HEAD-A/{stamp}_0000000001_HEAD-A_OK.bmp"
            new_image = f"{date}/HEAD-A/{stamp}_0000000002_HEAD-A_OK.bmp"
            old_line = replay.measurement_line(5.011, 5.012)
            new_line = replay.measurement_line(5.031, 5.032)
            old_txt_accepted = False
            with replay.connect_ftp("127.0.0.1", ftp_port,
                                    "ftp_repro", "ftp_repro_only") as ftp:
                replay.ensure_remote_dirs(ftp, txt_rel)
                try:
                    ftp.storbinary(f"STOR {Path(txt_rel).name}",
                                   io.BytesIO(old_line.encode("ascii")))
                    old_txt_accepted = True
                except (ftplib.error_temp, ftplib.error_perm) as exc:
                    if not str(exc).startswith("451"):
                        raise
                replay.ensure_remote_dirs(ftp, old_image)
                try:
                    with replay.SAMPLE_BMP.open("rb") as image:
                        ftp.storbinary(f"STOR {Path(old_image).name}", image)
                except (ftplib.error_temp, ftplib.error_perm) as exc:
                    if not str(exc).startswith("451"):
                        raise
                else:
                    raise RuntimeError("Out-of-session BMP was unexpectedly accepted")

                backend.session_state = "running"
                # Same sequence observed from TM-X: HEAD-A image before text.
                if order == "txt-first":
                    replay.ensure_remote_dirs(ftp, txt_rel)
                    ftp.storbinary(f"STOR {Path(txt_rel).name}",
                                   io.BytesIO(((old_line if old_txt_accepted else "") +
                                               new_line).encode("ascii")))
                replay.ensure_remote_dirs(ftp, new_image)
                with replay.SAMPLE_BMP.open("rb") as image:
                    ftp.storbinary(f"STOR {Path(new_image).name}", image)
                if order == "image-first":
                    time.sleep(txt_delay)
                    replay.ensure_remote_dirs(ftp, txt_rel)
                    ftp.storbinary(f"STOR {Path(txt_rel).name}",
                                   io.BytesIO(((old_line if old_txt_accepted else "") +
                                               new_line).encode("ascii")))
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline and not backend.posts:
                time.sleep(0.2)
            posted = backend.posts[0] if backend.posts else None
            result = {"order": order, "old_txt_accepted": old_txt_accepted,
                      "posted": posted, "events": backend.events,
                      "receiver_log": str(log_path)}
            (run_dir / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2),
                                                    encoding="utf-8")
            return result
    finally:
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        backend.shutdown()
        backend.server_close()
        server_thread.join(timeout=2)


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--order", choices=("both", "image-first", "txt-first"), default="both")
    parser.add_argument("--txt-delay", type=float, default=1.0,
                        help="seconds after new image before new text arrives")
    args = parser.parse_args()
    missing = [name for name in ("httpx", "pyftpdlib", "dotenv", "cv2", "numpy")
               if importlib.util.find_spec(name) is None]
    if missing:
        parser.error("Python นี้ไม่มี dependency ของ Data Receiver: " + ", ".join(missing)
                     + " — ใช้ Python environment เดียวกับที่รัน Data-receiver.py")
    RESULTS.mkdir(parents=True, exist_ok=True)
    for order in (("image-first", "txt-first") if args.order == "both" else (args.order,)):
        result = run_case(order, args.txt_delay)
        posted = result["posted"]
        print(f"{order}: old .txt while stopped: "
              f"{'ACCEPTED' if result['old_txt_accepted'] else 'REJECTED'}")
        if posted:
            x, y = posted.get("value_x"), posted.get("value_y")
            interpretation = "OLD/STALE" if (x, y) == (5.011, 5.012) else \
                "NEW" if (x, y) == (5.031, 5.032) else "OTHER"
            print(f"{order}: Receiver POST X/Y={x}/{y} -> {interpretation}")
        else:
            print(f"{order}: Receiver did not POST; inspect {result['receiver_log']}")
        print(f"  log: {result['receiver_log']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
