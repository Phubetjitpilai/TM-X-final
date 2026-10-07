"""Three paired TM-X demo measurements for recording the Web UI.

Run from ``Backend-pc_station`` with the same Python environment as mockup.py::

    python mockup_for_clip.py --dry-run
    python mockup_for_clip.py

Start a Web session containing exactly three 5x5 measurements. The order of
the eight *existing* images is shuffled once per session, then the first three
are used. Every posted numeric field comes from the table printed in its paired
image. This is a simulation,
not a new physical TM-X measurement.
"""

from __future__ import annotations

import argparse
import hashlib
import mimetypes
import random
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path


IMAGE_DIR = Path(__file__).resolve().parent / "image"
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}
CLIP_COUNT = 3


@dataclass(frozen=True)
class Sample:
    filename: str
    sha256: str
    value_x: float
    value_y: float
    horizon_left: float
    horizon_right: float
    vertical_top: float
    vertical_bottom: float
    offset_opx: float
    offset_opy: float


# Values were transcribed from the eight visible "Measured" rows in each
# matching JPG. The hash prevents a replaced picture from silently receiving
# the old picture's values. Do not add an unverified image to this table.
SAMPLES = (
    Sample("100_665_2bb423094db6c1c5.jpg", "33ae0e517c99e4a90542f3a3136c14673408b6af215e3914cccef49e6dde0968",
           5.022, 5.023, 2.515, 2.507, 2.525, 2.497, 0.008, 0.028),
    Sample("100_755_428d0bbbb2c74c1e.jpg", "86d6200b1aaeebd02f89ac8fd120d06f90aa3e0d3d09038ff2c62d952c321d17",
           5.012, 5.016, 2.514, 2.498, 2.518, 2.498, 0.016, 0.020),
    Sample("100_787_168854bfe42dba4f.jpg", "afb7b772562786d611908e5add4c3a2fb7084f288519b01d5066d9ee5bd69350",
           5.014, 5.021, 2.513, 2.501, 2.524, 2.498, 0.012, 0.026),
    Sample("100_817_4b6d5c2feb1e14d2.jpg", "c52a129a4c5fc6290f4ed0e2913e540130d244c1042b6cf53cb03729d19452df",
           5.024, 5.021, 2.517, 2.507, 2.526, 2.495, 0.010, 0.031),
    Sample("100_910_2a5e536004a5c13e.jpg", "a6b42759b8ba369e8a1aeb05512d6a78075c07f98430cb9f4daef041cbed5a2e",
           5.033, 5.033, 2.505, 2.528, 2.557, 2.476, 0.023, 0.081),
    Sample("100_915_bb44c82d8bb884e3.jpg", "87413d3df1207b2c0cfcf2929e5154bd234dea3d44e1f2a8a98621ec9e1a6d78",
           5.033, 5.035, 2.506, 2.527, 2.560, 2.474, 0.021, 0.086),
    Sample("100_925_7db2980b531d9a65.jpg", "ed3651b1e3d694ebe86696f1254da91352355f3d778e73c5fe531f1ea82aa8b8",
           5.023, 5.022, 2.500, 2.523, 2.534, 2.488, 0.023, 0.046),
    Sample("101_666_0194cb00039781d1.jpg", "f256f0d7625fd36b6b75cd7aec372f5d96c3b87b9b1dc4fb6dfb11941f23e195",
           5.022, 5.024, 2.515, 2.507, 2.526, 2.499, 0.008, 0.027),
)


def validate_images() -> None:
    expected = {sample.filename for sample in SAMPLES}
    actual = {p.name for p in IMAGE_DIR.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_SUFFIXES}
    if actual != expected:
        missing = sorted(expected - actual)
        unmapped = sorted(actual - expected)
        raise RuntimeError(f"Image folder must contain the eight mapped files. Missing={missing}; unmapped={unmapped}")
    for sample in SAMPLES:
        digest = hashlib.sha256((IMAGE_DIR / sample.filename).read_bytes()).hexdigest()
        if digest != sample.sha256:
            raise RuntimeError(f"Image changed: {sample.filename}. Verify its measured values before updating SAMPLES.")


def shuffled_samples(seed: int | None = None) -> list[Sample]:
    order = list(SAMPLES)
    random.Random(seed).shuffle(order)
    return order[:CLIP_COUNT]


def show_order(order: list[Sample]) -> None:
    for number, sample in enumerate(order, 1):
        print(f"{number}. {sample.filename}  X={sample.value_x:.3f} Y={sample.value_y:.3f} "
              f"Offset X/Y={sample.offset_opx:.3f}/{sample.offset_opy:.3f}")


def run_agent(seed: int | None) -> None:
    # Keep the existing agent's heartbeat, command/trigger API, queue review,
    # session stop behaviour and image-capture handshake. Only the sample
    # source changes here.
    try:
        import mockup
    except ModuleNotFoundError as exc:
        raise SystemExit(f"Missing {exc.name}; run with the Python environment used for mockup.py") from exc
    import uvicorn

    # The regular mock alternates/forces NG for demos. Here the picture's
    # measured values are the source of truth, including whatever verdict the
    # selected ALPL tolerance produces.
    mockup.DEMO_MODE = False
    mockup.MOCK_MODE = "default"
    mockup.NG_RATE = 0.0

    state = threading.local()
    original_flow = mockup.measurement_flow
    original_post_measurement = mockup.post_measurement

    def timed_post_measurement(*args, **kwargs):
        started = time.perf_counter()
        result = original_post_measurement(*args, **kwargs)
        state.value_post_done_at = time.perf_counter()
        print(f"[SIMULATION] Value POST took {state.value_post_done_at - started:.3f}s")
        return result

    def paired_value(_lo: float, _hi: float, _force_ng: bool) -> float:
        sample = getattr(state, "sample", None)
        if sample is None:
            try:
                sample = next(state.remaining)
            except StopIteration as exc:
                raise RuntimeError(f"All {CLIP_COUNT} paired images were already used in this session") from exc
            state.sample = sample
            state.phase = "x"
            print(f"\n[SIMULATION] Using {sample.filename} with X={sample.value_x:.3f}, Y={sample.value_y:.3f}")
            return sample.value_x
        if state.phase != "x":
            raise RuntimeError("Unexpected value request; refusing to mix picture and values")
        state.phase = "y"
        return sample.value_y

    def paired_offsets(_offset_max: float | None, force_ok: bool = False) -> tuple[float, ...]:
        sample = getattr(state, "sample", None)
        if sample is None or state.phase != "y":
            raise RuntimeError("Offset values requested without the paired X/Y values")
        state.phase = "offsets"
        # post_measurement expects bottom before top, unlike the image's row order.
        return (sample.offset_opx, sample.offset_opy, sample.horizon_left,
                sample.horizon_right, sample.vertical_bottom, sample.vertical_top)

    def upload_paired_image(measurement_id: int) -> bool:
        sample = getattr(state, "sample", None)
        if sample is None or state.phase != "offsets":
            raise RuntimeError("Image upload requested without its paired values")
        image_path = IMAGE_DIR / sample.filename
        if hashlib.sha256(image_path.read_bytes()).hexdigest() != sample.sha256:
            raise RuntimeError(f"Image changed before upload: {sample.filename}")
        upload_started = time.perf_counter()
        with image_path.open("rb") as image_file:
            response = mockup.httpx.post(
                f"{mockup.BACKEND_URL}/api/measurements/{measurement_id}/image-upload",
                params={"capture_id": mockup.queue_review.capture_id},
                files={"file": (image_path.name, image_file,
                                mimetypes.guess_type(image_path.name)[0] or "application/octet-stream")},
                timeout=60,
            )
        response.raise_for_status()
        upload_done = time.perf_counter()
        print(f"[SIMULATION] Uploaded {sample.filename} to measurement {measurement_id}")
        print(f"[SIMULATION] Image request took {upload_done - upload_started:.3f}s; "
              f"value response → image response {upload_done - state.value_post_done_at:.3f}s")
        state.sample = None
        state.phase = None
        return True

    def clip_flow(session_id: int, groups: list[dict], target_count: int) -> None:
        if target_count != CLIP_COUNT:
            reason = f"Clip mock requires exactly {CLIP_COUNT} measurements; session requested {target_count}"
            print(f"[SIMULATION] {reason}")
            mockup.report("CLIP_SAMPLE_COUNT", reason)
            try:
                mockup.httpx.post(f"{mockup.BACKEND_URL}/api/session/stop",
                                  json={"session_id": session_id, "reason": reason}, timeout=10).raise_for_status()
            finally:
                mockup.is_running = False
                mockup.current_session_id = None
            return
        validate_images()
        order = shuffled_samples(seed)
        state.remaining = iter(order)
        state.sample = None
        state.phase = None
        print(f"\n[SIMULATION] {CLIP_COUNT} paired images for this session:")
        show_order(order)
        try:
            original_flow(session_id, groups, target_count)
        finally:
            state.sample = None
            state.phase = None

    mockup.random_value = paired_value
    mockup.random_offsets = paired_offsets
    mockup.post_measurement = timed_post_measurement
    mockup.upload_random_image = upload_paired_image
    mockup.measurement_flow = clip_flow

    threading.Thread(target=mockup.heartbeat_loop, daemon=True).start()
    print(f"[SIMULATION] Clip mock agent: choose a {CLIP_COUNT}-piece 5x5 session on the Web.")
    print(f"[SIMULATION] Manual trigger mode waits for each of the {CLIP_COUNT} Trigger clicks.")
    print(f"[SIMULATION] Backend={mockup.BACKEND_URL}, agent port={mockup.AGENT_PORT}")
    print("[SIMULATION] Stop the real Pi agent/mockup.py first; they share this port.")
    uvicorn.run(mockup.http_app, host="0.0.0.0", port=mockup.AGENT_PORT)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Validate pictures and print a sample order without contacting Backend")
    parser.add_argument("--seed", type=int, help="Use the same randomized order for repeatable recording")
    args = parser.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    validate_images()
    if args.dry_run:
        show_order(shuffled_samples(args.seed))
        return 0
    run_agent(args.seed)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
