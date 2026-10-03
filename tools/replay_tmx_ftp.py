"""Replay TM-X-shaped FTP files across a stopped/running session boundary.

This is a diagnostic tool. The `inside` phase can update a real measurement,
so use a dedicated test ALPL/session and inspect the saved DB row afterwards.
"""

import argparse
import ftplib
import io
import json
import os
import re
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]
CASES = ROOT / "output" / "ftp_replay"
SAMPLE_BMP = ROOT / "Edit_image" / "260910_093136_0000000002_HEAD-A_OK.bmp"


def project_env():
    values = {}
    path = ROOT / ".env"
    if path.exists():
        for raw in path.read_text(encoding="utf-8-sig").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"\'')
    values.update(os.environ)
    return values


def measurement_line(x, y):
    # Same 24-column shape as Store_image_temporary/tm-x/result/...txt.
    # Data-receiver.py removes the 16 negative placeholders before indexing.
    active = [x, y, 2.498, 2.523, 2.555, 2.466, 0.025, 0.089]
    fields = (["-9999.999"] * 6 + ["-999999.999"] * 2) * 2
    fields += [f"+{v:08.3f}" for v in active[:6]]
    fields += [f"+{v:010.3f}" for v in active[6:]]
    return ",".join(fields) + "\r\n"


def case_dir(name):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", name):
        raise ValueError("case ต้องใช้ A-Z, a-z, 0-9, _ หรือ - เท่านั้น")
    return CASES / name


def prepare(name, old_x, old_y, new_x, new_y):
    directory = case_dir(name)
    if directory.exists():
        raise RuntimeError(f"case นี้มีแล้ว: {directory}")
    if not SAMPLE_BMP.is_file():
        raise RuntimeError(f"ไม่พบ BMP ตัวอย่าง: {SAMPLE_BMP}")
    now = datetime.now()
    date = now.strftime("%y%m%d")
    stamp = now.strftime("%y%m%d_%H%M%S")
    text_rel = f"tm-x/result/SD1_023/{stamp}.txt"
    old_image_rel = f"{date}/HEAD-A/{stamp}_0000000001_HEAD-A_OK.bmp"
    new_image_rel = f"{date}/HEAD-A/{stamp}_0000000002_HEAD-A_OK.bmp"
    other_image_rel = f"{date}/{stamp}_0000000002_capture-image_OK.bmp"
    manifest = {
        "text_rel": text_rel,
        "old_image_rel": old_image_rel,
        "new_image_rel": new_image_rel,
        "other_image_rel": other_image_rel,
        "old_x": old_x, "old_y": old_y, "new_x": new_x, "new_y": new_y,
    }
    directory.mkdir(parents=True)
    (directory / "case.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    for rel in (text_rel, old_image_rel, new_image_rel, other_image_rel):
        (directory / rel).parent.mkdir(parents=True, exist_ok=True)
    (directory / text_rel).write_bytes(measurement_line(old_x, old_y).encode("ascii"))
    for rel in (old_image_rel, new_image_rel, other_image_rel):
        shutil.copyfile(SAMPLE_BMP, directory / rel)
    print(f"เตรียมไฟล์: {directory}")
    print(f"ค่าเก่า X/Y={old_x:.3f}/{old_y:.3f}; ค่าใหม่ X/Y={new_x:.3f}/{new_y:.3f}")
    print("ขั้นต่อไป: รอให้ Session ไม่ Running อย่างน้อย 4 วินาที แล้วรัน outside")


def load_case(name):
    directory = case_dir(name)
    manifest = json.loads((directory / "case.json").read_text(encoding="utf-8"))
    return directory, manifest


def api_get(base, path, params=None):
    url = base.rstrip("/") + path
    if params:
        url += "?" + urlencode(params)
    with urlopen(url, timeout=5) as response:
        return json.load(response)


def connect_ftp(host, port, user, password):
    ftp = ftplib.FTP()
    ftp.connect(host, port, timeout=10)
    ftp.login(user, password)
    ftp.set_pasv(True)
    return ftp


def ensure_remote_dirs(ftp, rel):
    ftp.cwd("/")
    for part in Path(rel).parts[:-1]:
        try:
            ftp.mkd(part)
        except ftplib.error_perm as exc:
            if not str(exc).startswith("550"):
                raise
        ftp.cwd(part)


def upload(ftp, rel, path, *, append=False):
    ensure_remote_dirs(ftp, rel)
    command = "APPE" if append else "STOR"
    with path.open("rb") as stream:
        ftp.storbinary(f"{command} {Path(rel).name}", stream)
    print(f"FTP {command} {rel}")


def phase_outside(args, directory, manifest, env):
    backend = args.backend or env.get("BACKEND_URL", "http://127.0.0.1:8000")
    state = api_get(backend, "/api/session/state")
    if state.get("state") == "running":
        raise RuntimeError("Session ยัง Running — ห้ามส่ง phase outside")
    # Let session_watcher finish clearing the previous run before planting the
    # old text. Otherwise its normal cleanup would remove this test condition.
    print("รอ 4 วินาทีให้ session_watcher ผ่านรอบล้างไฟล์ของ Session ก่อน...")
    time.sleep(4)
    if api_get(backend, "/api/session/state").get("state") == "running":
        raise RuntimeError("Session กลับมา Running ระหว่างรอ — ยกเลิก")
    # A case can be replayed repeatedly; outside must always seed one old row.
    (directory / manifest["text_rel"]).write_bytes(
        measurement_line(manifest["old_x"], manifest["old_y"]).encode("ascii")
    )
    with connect_ftp(args.host, args.port, args.user, args.password) as ftp:
        try:
            upload(ftp, manifest["text_rel"], directory / manifest["text_rel"])
            manifest["old_txt_accepted"] = True
        except (ftplib.error_temp, ftplib.error_perm) as exc:
            if not str(exc).startswith("451"):
                raise
            manifest["old_txt_accepted"] = False
            print(f".txt เก่าถูก Receiver ปฏิเสธตามคาด: {exc}")
        try:
            upload(ftp, manifest["old_image_rel"], directory / manifest["old_image_rel"])
        except (ftplib.error_temp, ftplib.error_perm) as exc:
            if not str(exc).startswith("451"):
                raise
            print(f"รูปเก่าถูก Receiver ปฏิเสธตามคาด: {exc}")
        else:
            raise RuntimeError("รูปเก่าถูก FTP รับ ทั้งที่ Session ไม่ Running — ตรวจ FORWARD_TO_BACKEND")
    (directory / "case.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print("เริ่มรอบทดสอบจากเว็บและรอให้ Pi เปิด capture")


def phase_inside(args, directory, manifest, env):
    if not args.write_live_db:
        raise RuntimeError("phase inside อาจเขียน DB จริง ต้องใส่ --write-live-db สำหรับ ALPL ทดสอบ")
    backend = args.backend or env.get("BACKEND_URL", "http://127.0.0.1:8000")
    state = api_get(backend, "/api/session/state")
    if state.get("state") != "running":
        raise RuntimeError("Session ไม่ Running — กด Start/Remeasure จากเว็บก่อน")
    sid = state["session_id"]
    deadline = time.monotonic() + 30
    capture_id = None
    while time.monotonic() < deadline:
        capture_id = api_get(backend, "/api/review/capture", {"session_id": sid}).get("capture_id")
        if capture_id:
            break
        time.sleep(0.5)
    if not capture_id:
        raise RuntimeError("Pi ยังไม่เปิด capture ภายใน 30 วินาที — ตรวจการ Trigger ของรอบทดสอบ")
    print(f"Session={sid}, capture={capture_id}, ลำดับ={args.order}")
    new_line = measurement_line(manifest["new_x"], manifest["new_y"])
    prior_line = (measurement_line(manifest["old_x"], manifest["old_y"])
                  if manifest.get("old_txt_accepted", True) else "")
    txt_path = directory / manifest["text_rel"]
    if args.order == "txt-first":
        txt_path.write_bytes((prior_line + new_line).encode("ascii"))
    with connect_ftp(args.host, args.port, args.user, args.password) as ftp:
        if args.order == "txt-first":
            upload(ftp, manifest["text_rel"], txt_path)
        upload(ftp, manifest["new_image_rel"], directory / manifest["new_image_rel"])
        if args.order == "image-first":
            time.sleep(args.txt_delay)
            txt_path.write_bytes((prior_line + new_line).encode("ascii"))
            upload(ftp, manifest["text_rel"], txt_path)
        upload(ftp, manifest["other_image_rel"], directory / manifest["other_image_rel"])
    time.sleep(2)
    capture = api_get(backend, f"/api/review/capture/{capture_id}")
    print(f"capture saved={capture.get('saved')} measurement_id={capture.get('saved_measurement_id')}")
    mid = capture.get("saved_measurement_id")
    if mid:
        data = api_get(backend, "/api/measurements", {"session_id": sid, "limit": 1000})
        row = next((item for item in data.get("items", []) if item.get("measurement_id") == mid), None)
        if row:
            print(f"DB X/Y={row.get('value_x')}/{row.get('value_y')} "
                  f"(เก่า={manifest['old_x']:.3f}/{manifest['old_y']:.3f}, "
                  f"ใหม่={manifest['new_x']:.3f}/{manifest['new_y']:.3f})")
    print("ตรวจ log ของ Data Receiver และแถวใน DB อีกครั้ง โดยเฉพาะการวัดซ้ำที่อัปเดต ID เดิม")


def main():
    # Windows may launch Python with cp1252 even when this script prints Thai.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    env = project_env()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("prepare", "outside", "inside"))
    parser.add_argument("--case", required=True, help="ชื่อเคสเดียวกันทั้งสาม phase")
    parser.add_argument("--host", default="127.0.0.1", help="FTP host ของ Data Receiver")
    parser.add_argument("--port", type=int, default=int(env.get("DATA_RECEIVER_FTP_PORT", "21")))
    parser.add_argument("--user", default=env.get("DATA_RECEIVER_FTP_USER", "INTERN_USER"))
    parser.add_argument("--backend", help="Backend URL; ค่าเริ่มต้นอ่านจาก .env")
    parser.add_argument("--old-x", type=float, default=5.011)
    parser.add_argument("--old-y", type=float, default=5.012)
    parser.add_argument("--new-x", type=float, default=5.031)
    parser.add_argument("--new-y", type=float, default=5.032)
    parser.add_argument("--order", choices=("image-first", "txt-first"), default="image-first")
    parser.add_argument("--txt-delay", type=float, default=1.0)
    parser.add_argument("--write-live-db", action="store_true")
    args = parser.parse_args()
    args.password = env.get("DATA_RECEIVER_FTP_PASS", "123456")
    try:
        if args.phase == "prepare":
            prepare(args.case, args.old_x, args.old_y, args.new_x, args.new_y)
        else:
            directory, manifest = load_case(args.case)
            if args.phase == "outside":
                phase_outside(args, directory, manifest, env)
            else:
                phase_inside(args, directory, manifest, env)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
