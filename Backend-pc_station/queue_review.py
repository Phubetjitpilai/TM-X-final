"""Single-worker queue review. Hardware and existing error handlers stay in the caller."""
import threading
import time
import uuid

import httpx
from fastapi import HTTPException


class QueueReview:
    def __init__(self, backend):
        self.backend = backend
        self.lock = threading.RLock()
        self.reset(None)

    def reset(self, session_id):
        with self.lock:
            self.session_id = session_id
            self.phase = "running"
            self.pause = False
            self.pending = None
            self.job = None
            self.capture_id = None
            self.interrupted = False

    def status(self):
        with self.lock:
            return {"session_id": self.session_id, "phase": self.phase,
                    "measurement_id": (self.job or self.pending or {}).get("measurement_id")}

    def command(self, action, session_id, job=None):
        with self.lock:
            if session_id != self.session_id:
                raise HTTPException(409, "Session ของ Pi เปลี่ยนแล้ว")
            if action == "pause_queue":
                self.pause = True
                if self.phase == "running":
                    self.phase = "pausing"
            elif action == "resume_queue":
                if self.phase not in ("running", "paused", "pausing") or self.pending:
                    raise HTTPException(409, "รอให้วัดซ้ำเสร็จก่อนวัดต่อ")
                self.pause = False
                self.phase = "running"
            elif action == "remeasure":
                if self.phase != "paused" or self.pending:
                    raise HTTPException(409, "Pi ยังไม่พร้อมวัดซ้ำ — รอพักคิวก่อน")
                if not job or not job.get("measurement_id") or not job.get("piece"):
                    raise HTTPException(400, "ไม่มีรายการที่จะวัดซ้ำ")
                self.pending = job
                self.phase = "remeasuring"
            return self.status()

    def interrupt_wait(self):
        with self.lock:
            if self.pause and self.job is None:
                self.interrupted = True
                return True
            return False

    def pieces(self, target, running):
        next_piece = 1
        while running() and next_piece <= target:
            with self.lock:
                if self.pause and not self.pending:
                    self.phase = "paused"
                    piece = None
                else:
                    self.job = self.pending
                    self.pending = None
                    self.phase = "remeasuring" if self.job else "running"
                    piece = self.job["piece"] if self.job else next_piece
                    self.capture_id = None
                    self.interrupted = False
            if piece is None:
                time.sleep(0.1)
                continue
            yield piece
            if not self.interrupted and self.capture_id:
                try:
                    self.wait_image(running)
                except Exception:
                    self.phase = "failed"
                    raise
            if not self.job and not self.interrupted:
                next_piece += 1
            self.job = None

    def prepare(self, piece):
        # Explicit token binds Receiver/Pi fallback to one acquisition, not a moving queue.
        token = str(uuid.uuid4())
        response = httpx.post(f"{self.backend}/api/review/capture", json={
            "session_id": self.session_id, "piece": piece,
            "measurement_id": (self.job or {}).get("measurement_id"),
            "capture_id": token}, timeout=10)
        response.raise_for_status()
        self.capture_id = token

    def saved(self):
        if not self.capture_id:
            return False
        response = httpx.get(f"{self.backend}/api/review/capture/{self.capture_id}", timeout=5)
        response.raise_for_status()
        return response.json().get("saved", False)

    def wait_image(self, running, timeout=60):
        if not self.capture_id:
            return
        deadline = time.monotonic() + timeout
        while running() and time.monotonic() < deadline:
            response = httpx.get(f"{self.backend}/api/review/capture/{self.capture_id}", timeout=5)
            response.raise_for_status()
            if response.json().get("image_done"):
                return
            time.sleep(0.2)
        if running():
            raise RuntimeError("รูปของรอบวัดก่อนหน้ายังไม่เสร็จ — หยุดเพื่อไม่จับคู่รูปผิดชิ้น")
