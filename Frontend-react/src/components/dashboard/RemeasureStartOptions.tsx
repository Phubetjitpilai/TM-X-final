import { useState } from "react";
import type { TriggerMode } from "./PartEntryModal";

/** Own the selection inside DialogProvider so it updates while the dialog is open. */
export default function RemeasureStartOptions({ alpl, initialMode, onModeChange }: {
  alpl?: number;
  initialMode: TriggerMode;
  onModeChange: (mode: TriggerMode) => void;
}) {
  const [mode, setMode] = useState(initialMode);
  const selectMode = (value: TriggerMode) => {
    setMode(value);
    onModeChange(value);
  };
  return <>
    <p style={{ marginTop: 0 }}>
      วางชิ้นงาน <strong>ALPL {alpl}</strong> ให้พร้อม แล้วกด Start เพื่อวัดชิ้นนี้ใหม่
      ผลและรูปใหม่จะแทนที่รายการเดิม
    </p>
    <div className="form-group">
      <label>Trigger</label>
      <div className="entry-toggle" role="group" aria-label="โหมด Trigger สำหรับวัดใหม่">
        <button type="button" className={`entry-toggle-btn${mode === "auto" ? " active" : ""}`}
          aria-pressed={mode === "auto"} onClick={() => selectMode("auto")}>
          Auto (MCU)
        </button>
        <button type="button" className={`entry-toggle-btn${mode === "manual" ? " active" : ""}`}
          aria-pressed={mode === "manual"} onClick={() => selectMode("manual")}>
          Manual (ปุ่มบนเว็บ)
        </button>
      </div>
      <div className="entry-session-hint" style={{ marginTop: ".4rem" }}>
        {mode === "auto"
          ? "รอสัญญาณจาก MCU — ต้องเชื่อมต่อ Mega กับ Pi"
          : "กดปุ่ม Trigger บนเว็บเมื่อระบบพร้อมวัด"}
      </div>
    </div>
  </>;
}
