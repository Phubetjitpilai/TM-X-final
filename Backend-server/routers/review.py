"""Queue review commands and acquisition identity shared by Pi and Receiver."""
import copy
import json
from typing import Literal

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
import shared as s

router = APIRouter()
captures = {}
active = {}
latest_image_capture = {}


class ReviewRequest(BaseModel):
    session_id: int
    action: str
    measurement_id: int | None = None


class CaptureRequest(BaseModel):
    session_id: int
    piece: int
    capture_id: str
    measurement_id: int | None = None


class CaptureCancelRequest(BaseModel):
    session_id: int
    capture_id: str


class SingleReviewStartRequest(BaseModel):
    trigger_mode: Literal["auto", "manual"] | None = None


async def agent(method, path, **kwargs):
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.request(method, f"{s.AGENT_BASE_URL}{path}", **kwargs)
        if not response.is_success:
            try:
                detail = response.json().get("detail", response.text)
            except ValueError:
                detail = response.text
            raise HTTPException(response.status_code, detail)
        return response.json()
    except httpx.HTTPError as exc:
        raise HTTPException(503, f"ติดต่อ Pi ไม่สำเร็จ: {exc}")


@router.get("/api/review/state")
async def state():
    return await agent("GET", "/queue-review")


@router.post("/api/review/command")
async def command(req: ReviewRequest):
    if req.action not in ("pause_queue", "resume_queue", "remeasure"):
        raise HTTPException(400, "คำสั่งไม่ถูกต้อง")
    db = s.get_db()
    try:
        with db.cursor() as cur:
            cur.execute("SELECT state FROM sessions WHERE session_id=%s", (req.session_id,))
            row = cur.fetchone()
            if not row or row["state"] != "running":
                raise HTTPException(409, "Session ไม่ได้ Running แล้ว")
            job = None
            if req.action == "remeasure":
                cur.execute("SELECT number_alpl FROM measurements WHERE measurement_id=%s AND session_id=%s",
                            (req.measurement_id, req.session_id))
                measurement = cur.fetchone()
                q = s.session_queues.get(req.session_id)
                if not measurement or not q:
                    raise HTTPException(409, "ไม่พบผลวัดในคิวปัจจุบัน")
                piece = q["queue"].index(measurement["number_alpl"]) + 1
                job = {"measurement_id": req.measurement_id, "piece": piece}
    finally:
        db.close()
    return await agent("POST", "/command", json={"action": req.action,
                       "session_id": req.session_id, "review_job": job})


@router.post("/api/review/capture")
async def prepare(req: CaptureRequest):
    q = s.session_queues.get(req.session_id)
    if not q or not 1 <= req.piece <= len(q["queue"]):
        raise HTTPException(409, "คิวไม่ตรงกับ Session")
    if req.capture_id in captures:
        return {"ok": True}
    old = captures.get(active.get(req.session_id), {})
    if old and not old.get("image_done"):
        raise HTTPException(409, "รอผลและรูปของรอบก่อนให้เสร็จก่อน")
    if req.measurement_id is None and req.piece != q["position"] + 1:
        raise HTTPException(409, "ตำแหน่งคิวไม่ตรงกัน")
    source = q.get("review_source") or {}
    single_review = source.get("update_existing", False)
    measurement_id = req.measurement_id
    measurement_session_id = req.session_id
    if single_review:
        if (len(q["queue"]) != 1 or req.piece != 1
                or req.measurement_id not in (None, source["measurement_id"])):
            raise HTTPException(409, "รายการวัดซ้ำไม่ตรงกับ Session ที่เปิดไว้")
        measurement_id = source["measurement_id"]
        measurement_session_id = source["session_id"]
    db = s.get_db()
    try:
        with db.cursor() as cur:
            cur.execute("SELECT state FROM sessions WHERE session_id=%s", (req.session_id,))
            row = cur.fetchone()
            if not row or row["state"] != "running":
                raise HTTPException(409, "Session ไม่ได้ Running")
            if measurement_id is not None:
                cur.execute("SELECT number_alpl FROM measurements WHERE measurement_id=%s AND session_id=%s",
                            (measurement_id, measurement_session_id))
                row = cur.fetchone()
                if not row or row["number_alpl"] != q["queue"][req.piece - 1]:
                    raise HTTPException(409, "รายการวัดซ้ำไม่ตรงกับ ALPL")
    finally:
        db.close()
    captures[req.capture_id] = {**req.model_dump(), "measurement_id": measurement_id,
                              "measurement_session_id": measurement_session_id,
                              "single_review": single_review, "saved": False, "image_done": False}
    active[req.session_id] = req.capture_id
    return {"ok": True}


@router.post("/api/review/capture/cancel")
def cancel_capture(req: CaptureCancelRequest):
    capture = captures.get(req.capture_id)
    if not capture or capture["session_id"] != req.session_id:
        raise HTTPException(409, "ไม่พบรอบวัดที่จะยกเลิก")
    if capture.get("cancelled"):
        return {"ok": True}
    if active.get(req.session_id) != req.capture_id:
        raise HTTPException(409, "รอบวัดนี้ไม่ใช่รอบปัจจุบัน")
    if capture.get("saved"):
        raise HTTPException(409, "ผลวัดถูกบันทึกแล้ว — ยกเลิกรอบนี้ไม่ได้")
    capture["cancelled"] = True
    active.pop(req.session_id, None)
    return {"ok": True}


@router.get("/api/review/capture")
def current_capture(session_id: int):
    return {"capture_id": active.get(session_id)}


@router.get("/api/review/capture/{token}")
def capture_status(token: str):
    if token not in captures:
        raise HTTPException(409, "รอบวัดหายไป — หยุดแล้วเริ่มใหม่")
    return captures[token]


def resolve_capture(req):
    token = req.capture_id
    if not token:
        source = (s.session_queues.get(req.session_id) or {}).get("review_source") or {}
        if active.get(req.session_id) or source.get("update_existing"):
            raise HTTPException(409, "ผลวัดไม่มี capture_id — อัปเดต Data-Receiver และ Pi พร้อมกัน")
        return None
    capture = captures.get(token)
    if not capture or capture["session_id"] != req.session_id or active.get(req.session_id) != token:
        raise HTTPException(409, "ผลวัดเป็นของรอบเก่า")
    return capture


def check_image(measurement_id, token):
    expected = latest_image_capture.get(measurement_id)
    if expected is None and token is None:
        return None  # older agents remain compatible until a capture is registered
    capture = captures.get(token)
    if (not capture or token != expected or not capture.get("saved")
            or capture.get("saved_measurement_id") != measurement_id or capture.get("image_done")):
        raise HTTPException(409, "รูปไม่ตรงกับรอบวัดปัจจุบัน หรือรอบนี้ปิดรับรูปแล้ว")
    return capture


@router.post("/api/review/start/{measurement_id}")
async def start_single(measurement_id: int, options: SingleReviewStartRequest | None = None):
    # Reuse Start validation/locking and original group configuration, with only one ALPL.
    from routers.session import start_session
    db = s.get_db()
    try:
        with db.cursor() as cur:
            cur.execute("SELECT m.number_alpl, m.session_id, s.queue_state FROM measurements m JOIN sessions s ON s.session_id=m.session_id WHERE m.measurement_id=%s", (measurement_id,))
            row = cur.fetchone()
            if not row or not row["queue_state"]:
                raise HTTPException(409, "ไม่มีข้อมูลคิวเดิม — กรุณาเริ่มผ่าน Part Entry")
            q = row["queue_state"]
            q = json.loads(q) if isinstance(q, str) else q
            index = q["queue"].index(row["number_alpl"])
            group = copy.deepcopy(q["groups"][q["group_of"][index]])
            group["number_alpl"] = [row["number_alpl"]]
            body = {"Measure_Type": q.get("measure_mode", q["entry_mode"]),
                    "Operator": q["operator"],
                    "Trigger_Mode": (options.trigger_mode if options else None) or q.get("trigger_mode", "auto"),
                    "Tray_Capacity": 0,
                    "groups": [group]}
    finally:
        db.close()
    async def receive():
        return {"type": "http.request", "body": json.dumps(body).encode(), "more_body": False}
    request = Request({"type": "http", "method": "POST", "path": "/api/session/start", "headers": []}, receive)
    # Internal metadata, not a client-supplied Start option. Keep it in queue_state
    # so both SSE and polling can distinguish a single-item remeasure from Start.
    request.state.review_source = {"measurement_id": measurement_id,
                                   "session_id": row["session_id"], "number_alpl": row["number_alpl"],
                                   "update_existing": True}
    return await start_session(request)
