import { useRef, useState } from "react";
import { apiPost } from "../../api/client";
import SingleSelect from "../SingleSelect";
import EntryGroups, {
  GROUP_FIELDS, OPTIONAL_FIELDS, emptyGroup,
  type EntryMode, type GroupValues,
} from "./EntryGroups";
import { formatAlplRanges } from "../../utils/formatAlplRanges";

/** คิวที่พร้อมกด Start — โครงเดียวกันทั้ง 3 โหมด ต่างกันแค่ field ในกลุ่ม */
/** กลุ่มที่พร้อมส่ง backend — number_alpl ถูกแปลงเป็นลิสต์ตัวเลขแล้ว
 *  (ต่างจาก GroupValues ที่เป็นค่าดิบจากช่องกรอก) */
export type PayloadGroup = { number_alpl: number[]; [k: string]: string | number[] };

/** สัญญาณ "ชิ้นงานเข้าที่แล้ว" มาจากไหน
 *
 *    auto   — MCU ส่ง <TRIGGER_TMX> มาทาง Serial (ใช้งานจริงหน้างาน)
 *    manual — คนกดปุ่ม ⚡ Trigger บนหน้าเว็บ (ตอนยังไม่ต่อ MCU / ตอนไล่บั๊ก)
 *
 * ⚠ เป็นของทั้ง session ไม่ใช่รายกลุ่ม และ **ล็อกตั้งแต่กด Start สลับกลางคัน
 *   ไม่ได้** — ฝั่ง Pi จำว่าบอกขนาดชิ้นงานให้ MCU ไปแล้ว ถ้าสลับกลางรอบ MCU
 *   จะพลาด <PKG:...> ของกลุ่มที่ข้ามไปตอนอยู่โหมด manual
 */
export type TriggerMode = "manual" | "auto";

export interface EntryQueue {
  mode: EntryMode;
  operator: string;
  /** `undefined` ได้ — คิวที่ถูกเซฟลง localStorage ไว้ก่อนมีฟีเจอร์นี้จะไม่มี
   *  ผู้อ่านต้อง `?? "auto"` เสมอ (ดู DashboardPage ตอนประกอบ body) */
  triggerMode?: TriggerMode;
  trayCapacity?: number | null;
  groups: PayloadGroup[];
  /** ALPL ทั้งหมดคลี่เรียงตามลำดับที่จะวัด — ใช้โชว์จำนวนและวาดแถบคิว */
  list: number[];
  session_id?: number | null;
}

/**
 * แยก "400, 401" หรือ "400-403" เป็นลิสต์ตัวเลข
 * รับรูปแบบเดียวกับที่ backend เข้าใจ (ดู _parse_int_ranges)
 */
export function parseAlplList(raw: string): { list: number[]; error: string | null } {
  const s = raw.trim();
  if (!s) return { list: [], error: "กรอก ALPL อย่างน้อย 1 ค่า" };
  const out: number[] = [];
  for (const part of s.split(",")) {
    const p = part.trim();
    if (!p) continue;
    if (/^\d+$/.test(p)) { out.push(Number(p)); continue; }
    const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!m) return { list: [], error: `รูปแบบไม่ถูกต้อง: "${p}"` };
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a > b) return { list: [], error: `ช่วงกลับหัว: "${p}"` };
    for (let n = a; n <= b; n++) out.push(n);
  }
  if (!out.length) return { list: [], error: "กรอก ALPL อย่างน้อย 1 ค่า" };
  return { list: out, error: null };
}

interface Props {
  /** Lookup กำลัง retry หลังดึงข้อมูลไม่สำเร็จ */
  lookupFailed?: boolean;
  /** ทุกชุดเคยโหลดสำเร็จแล้ว จึงยังมีตัวเลือกเดิมใน cache */
  lookupCached?: boolean;
  operators: string[];
  vendors: string[];
  owners: string[];
  packageSizes: string[];
  partNumbersFor: (packageSize: string) => string[];
  /** เครื่องที่ package size นั้นลงได้ (ตาราง package_size_handler) */
  handlersFor: (packageSize: string) => string[];
  tolerancesFor: (packageSize: string) => { tolerance_id: number; nominal_x: number; nominal_y: number; upper_tol: number; lower_tol: number; offset_tol: number }[];
  /** เครื่องของ part number นั้น — ใช้เติมช่อง Handler อัตโนมัติใน New/Rework */
  handlerOfPartNumber: (partNumber: string) => string;
  onSave: (queue: EntryQueue) => void;
  onClose: () => void;
  /** ให้หน้าแม่ถามยืนยันก่อนลงทะเบียน ALPL ใหม่ (โหมด IPM)
   *  ส่ง package_size ของกลุ่มที่ ALPL นั้นอยู่ไปด้วย — ผู้ใช้ต้องเห็นว่ากำลังจะ
   *  ลงทะเบียนด้วยเกณฑ์ไหน ไม่ใช่เห็นแค่เลข ALPL แล้วกดตกลงไปโดยไม่รู้ */
  confirmRegister: (items: { alpl: number; package_size: string }[]) => Promise<boolean>;
  confirmExisting: (items: { alpl: number; package_size: string }[]) => Promise<boolean>;
  onGroupConflict: (messages: string[]) => Promise<void>;
  /** แจ้งเตือนทั่วไป (toast) — ใช้ตอน autofill เขียนทับค่าที่ผู้ใช้พิมพ์เอง */
  onNotify: (message: string, detail?: string, type?: "warning" | "error") => void;
  /** ถามยืนยันก่อนสลับโหมดตอนฟอร์มมีข้อมูลค้าง — คืน false = ยกเลิก อยู่โหมดเดิม
   *
   *  ให้หน้าแม่เป็นคนถาม (ไม่ใช่ window.confirm ในนี้) เพราะ dialog ของโปรเจกต์
   *  อยู่ที่ DashboardPage ผ่าน useDialog — แบบเดียวกับ confirmRegister */
  confirmSwitch: (target: EntryMode, current: EntryMode) => Promise<boolean>;
  /** คิวเดิมที่จะเอามาเติมในฟอร์ม — `undefined` = เปิดฟอร์มเปล่า
   *
   *  ปุ่ม "✎ Edit" กับ "+ New Entry" ใช้ฟังก์ชันเปิด modal ตัวเดียวกัน แต่ปุ่มแรก
   *  จะโผล่เฉพาะตอนมีคิวอยู่ · ปุ่มหลังโผล่เฉพาะตอนไม่มี — ส่ง `entryQueue`
   *  เข้ามาตรง ๆ จึงถูกทั้งสองกรณีโดยไม่ต้องมีธงบอกโหมด
   */
  initial?: EntryQueue;
  /** คิวที่เริ่มวัดแล้วแก้ข้อมูลชิ้นงานไม่ได้ แต่เลือก Trigger ของรอบวัดต่อได้ */
  triggerOnly?: boolean;
}

const MODES: EntryMode[] = ["IPM", "New", "Rework"];

/** แปลงคิวที่เก็บไว้ กลับเป็นค่าที่ฟอร์มใช้ได้
 *
 *  ⚠ สองชนิดนี้เก็บ ALPL คนละแบบ — `PayloadGroup.number_alpl` เป็น `number[]`
 *    (คลี่ช่วงแล้ว) ส่วนฟอร์มเป็น string ดิบที่ผู้ใช้พิมพ์
 *
 *  ALPL ถูกเก็บใน EntryQueue เป็นลิสต์ตัวเลขเพื่อส่ง Backend แต่ตอนเติมกลับเข้า
 *  ฟอร์มจะบีบเลขเรียงติดกันกลับเป็นช่วงอีกครั้ง เช่น [1,2,3,4,5] → "1-5"
 *  เพื่อให้กด Edit แล้วรูปแบบที่เห็นยังอ่านง่ายเหมือนเดิม
 */
function toFormGroups(q: EntryQueue): GroupValues[] {
  return q.groups.map((g) => {
    const out: GroupValues = {};
    for (const [k, v] of Object.entries(g)) {
      out[k] = Array.isArray(v)
        ? (k === "number_alpl" ? formatAlplRanges(v as number[]) : v.join(", "))
        : String(v ?? "");
    }
    return out;
  });
}

export default function PartEntryModal({
  lookupFailed,
  lookupCached,
  operators, vendors, owners, packageSizes, partNumbersFor, handlersFor, tolerancesFor, handlerOfPartNumber,
  onSave, onClose, confirmRegister, confirmExisting, confirmSwitch, onGroupConflict, onNotify, initial, triggerOnly = false,
}: Props) {
  /* ตั้งค่าเริ่มต้นจาก `initial` ครั้งเดียวตอน mount — พอเพียงเพราะหน้าแม่วาด
     modal นี้แบบ `{peModalOpen && <PartEntryModal .../>}` ทุกครั้งที่เปิดใหม่
     component จึงเกิดใหม่ทั้งตัวและ initializer ทำงานซ้ำเสมอ

     ⚠ ห้ามใช้ useEffect ซิงก์ `initial` เข้ามาทีหลัง — ระหว่างที่ผู้ใช้กำลัง
       พิมพ์อยู่ ถ้าคิวฝั่งแม่เปลี่ยน (เช่น SSE สั่งล้างคิวตอน session จบ)
       ของที่พิมพ์ค้างไว้จะโดนเขียนทับกลางคัน */
  const [mode, setMode] = useState<EntryMode>(initial?.mode ?? "IPM");
  const [operator, setOperator] = useState(initial?.operator ?? "");
  /* default เป็น "auto" ให้ตรงกับฝั่ง Pi — ถ้าเผลอไม่เลือก จะได้พฤติกรรม
     เดียวกับตอนที่ยังไม่มีฟีเจอร์นี้ ไม่ใช่เปลี่ยนไปเป็นอย่างอื่นเงียบ ๆ */
  const [triggerMode, setTriggerMode] = useState<TriggerMode>(initial?.triggerMode ?? "auto");
  const [trayCapacity, setTrayCapacity] = useState(initial?.trayCapacity == null ? "" : String(initial.trayCapacity));
  const [trayCapacityError, setTrayCapacityError] = useState("");
  const [groups, setGroups] = useState<GroupValues[]>(() =>
    initial ? toFormGroups(initial) : [emptyGroup("IPM")],
  );
  const [errors, setErrors] = useState<Record<number, Record<string, string>>>({});
  const [operatorError, setOperatorError] = useState("");
  /** กล่อง modal — ใช้จำกัดขอบเขตการค้นหาช่องที่ลืมกรอก (ดู focusFirstInvalid)
   *  ⚠ ต้องผูกกับ `.pe-modal-box` ซึ่งเป็นตัวที่ scroll ได้ ไม่ใช่ `.modal-overlay`
   *    ข้างนอก — `scrollIntoView` ต้องมีตัว scroll จริงถึงจะขยับ */
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState(false);

  /** ฟอร์มมีข้อมูลที่จะหายไหม — ใช้ตัดสินว่าต้องถามยืนยันก่อนสลับโหมดไหม
   *
   *  ⚠ **ไม่นับ Operator** เพราะมันไม่ถูกล้างตอนสลับโหมด (ดู switchMode)
   *    ถ้านับด้วย จะกลายเป็นถามทุกครั้งหลังเลือก Operator แล้วทั้งที่ยังไม่ได้
   *    กรอกอะไรที่จะหายจริง
   */
  const formHasData = () =>
    groups.some((g) => Object.values(g).some((v) => (v ?? "").trim() !== ""));

  /** เปลี่ยนโหมด = ล้างกลุ่มทิ้ง เพราะ field คนละชุดกัน — เก็บของเดิมไว้แล้วโชว์
   *  ในโหมดใหม่จะได้ค่าที่ไม่มีความหมาย (เช่น Part Number ที่ IPM ไม่ได้ใช้)
   *
   *  ⚠ **ไม่ล้าง Operator** — คนที่ยืนวัดยังเป็นคนเดิม สลับโหมดไม่ได้แปลว่า
   *    เปลี่ยนคน (ฝั่ง vanilla เดิมล้างด้วย ซึ่งทำให้ต้องเลือกซ้ำทุกครั้ง
   *    โดยไม่ได้ประโยชน์ — ตั้งใจไม่ทำตาม)
   *
   *  ⚠ ถามเฉพาะตอนฟอร์มมีข้อมูลจริง ถ้ายังว่างให้สลับได้เลย — ไม่งั้นน่ารำคาญมาก
   *    ตอนคนแค่กดดูว่าโหมดไหนมีช่องอะไรบ้าง (ยกกติกานี้มาจาก vanilla ตรงๆ)
   */
  async function switchMode(next: EntryMode) {
    if (next === mode) return;
    if (formHasData() && !(await confirmSwitch(next, mode))) return;   // ยกเลิก = อยู่โหมดเดิม
    setMode(next);
    setGroups([emptyGroup(next)]);
    setErrors({});
    setOperatorError("");
  }

  /** เลื่อนไปหาช่องที่ลืมกรอก "ตัวบนสุด" แล้วโฟกัสให้
   *
   *  ทำไมต้องมี: ฟอร์มกรอกได้หลายกลุ่ม พอกด Save แล้วไม่ผ่าน ข้อความแดงอาจอยู่
   *  นอกจอ (ต้องเลื่อนลงไปอีก 2-3 หน้าจอถึงจะเห็น) ผู้ใช้จะเห็นแค่ปุ่มกดแล้วไม่
   *  เกิดอะไรขึ้น แล้วกดซ้ำอยู่อย่างนั้น
   *
   *  ⚠ ต้องรอ **หลัง** React วาดจอใหม่ถึงจะหาเจอ — ตอนที่บรรทัดนี้ทำงาน
   *    `setErrors` เพิ่งถูกเรียก DOM ยังไม่มีคลาส `.invalid` เลยสักอัน
   *    `requestAnimationFrame` คือจังหวะที่สั้นที่สุดที่การันตีว่าวาดเสร็จแล้ว
   *
   *  ⚠ `querySelector` คืน **ตัวแรกตามลำดับใน DOM** ซึ่งตรงกับ "บนสุดบนจอ"
   *    พอดีเพราะฟอร์มนี้เรียงจากบนลงล่างตรง ๆ ไม่มี CSS ที่สลับตำแหน่ง
   *    (ถ้าวันหลังใส่ `order` หรือ grid ที่สลับที่ ต้องเปลี่ยนมาเทียบ
   *     getBoundingClientRect().top แทน)
   *
   *  ⚠ `focus({ preventScroll: true })` — ไม่งั้นเบราว์เซอร์จะเลื่อนของมันเอง
   *    แบบกระตุกทับ smooth scroll ที่เพิ่งสั่งไป
   */
  function focusFirstInvalid() {
    requestAnimationFrame(() => {
      const box = boxRef.current;
      if (!box) return;
      const el = box.querySelector<HTMLElement>(".invalid");
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.focus({ preventScroll: true });
    });
  }

  async function handleSave() {
    if (triggerOnly) {
      if (initial) onSave({ ...initial, triggerMode });
      return;
    }
    const errs: Record<number, Record<string, string>> = {};
    const capacity = triggerMode === "auto" && trayCapacity.trim() !== "" ? Number(trayCapacity) : null;
    const capacityError = capacity !== null && (!Number.isSafeInteger(capacity) || capacity < 0)
      ? "กรอกจำนวนเต็มตั้งแต่ 0 ขึ้นไป หรือเว้นว่างเพื่อใช้ 8" : "";
    setTrayCapacityError(capacityError);
    let opErr = "";
    if (!operator.trim()) opErr = "เลือก Operator";

    // ── ตรวจทีละกลุ่ม ────────────────────────────────────────────────────
    const perGroupLists: number[][] = [];
    groups.forEach((g, gi) => {
      const ge: Record<string, string> = {};
      const { list, error } = parseAlplList(g.number_alpl ?? "");
      if (error) ge.number_alpl = error;
      perGroupLists[gi] = list;

      GROUP_FIELDS[mode].forEach((f) => {
        if (f === "number_alpl") return;
        if (OPTIONAL_FIELDS[mode].includes(f)) return;
        if (!(g[f] ?? "").trim()) ge[f] = "กรอกช่องนี้ก่อน";
      });
      if (mode !== "IPM" && (g.po_number ?? "").trim() && isNaN(Number(g.po_number)))
        ge.po_number = "ต้องเป็นตัวเลข";

      if (Object.keys(ge).length) errs[gi] = ge;
    });

    // ⚠ ALPL ห้ามซ้ำ "ข้ามกลุ่ม" ด้วย ไม่ใช่แค่ในกลุ่มเดียวกัน — ถ้าปล่อยให้ซ้ำ
    //   ชิ้นเดียวกันจะถูกวัด 2 ครั้งด้วย config คนละชุด แล้วอันหลังเขียนทับ Part
    //   ของอันแรกโดยที่ผู้ใช้ไม่รู้ตัว (backend ก็เช็คซ้ำ แต่บอกตั้งแต่ตรงนี้ดีกว่า)
    const seen = new Map<string, number>();
    perGroupLists.forEach((list, gi) => {
      list.forEach((n) => {
        const identity = `${n}|${groups[gi]?.package_size ?? ""}`;
        if (seen.has(identity) && seen.get(identity) !== gi) {
          errs[gi] = { ...errs[gi], number_alpl: `ALPL ${n} / Package Size นี้ซ้ำกับกลุ่มที่ ${seen.get(identity)! + 1}` };
        } else seen.set(identity, gi);
      });
    });

    setErrors(errs);
    setOperatorError(opErr);
    // ตรวจเลข ALPL ก่อนเรียก API แต่ปล่อยช่องที่ยังว่างไว้ชั่วคราว เพื่อให้
    // ข้อความ "ข้อมูลในกลุ่มไม่ตรงกัน" ปรากฏก่อน error กรอกไม่ครบ
    if (opErr || capacityError || Object.values(errs).some((ge) => !!ge.number_alpl)) {
      focusFirstInvalid();
      return;
    }

    const all = perGroupLists.flat();

    // ── เช็คกับ DB ว่า ALPL มี/ไม่มี ตามเงื่อนไขของโหมด ────────────────────
    // IPM    ยังไม่มี → ถามยืนยันแล้วลงทะเบียนให้ตอนวัดจริง
    // New มีอยู่แล้ว → ยืนยันใช้ Part เดิม · Rework ยังไม่มี → ยืนยันลงทะเบียน
    setBusy(true);
    try {
      const res = await apiPost<{ group_results: { exists: number[]; missing: number[] }[]; conflicts: { group: number; message: string }[] }>(
        "/api/parts/check", {
          alpl: all,
          groups: perGroupLists.map((list, gi) => ({ alpl: list, package_size: groups[gi]?.package_size ?? "" })),
          mode,
        },
      );
      if (res.conflicts?.length) {
        const conflictErrors = { ...errs };
        for (const conflict of res.conflicts) {
          conflictErrors[conflict.group] = {
            ...conflictErrors[conflict.group], number_alpl: "ALPL ในกลุ่มนี้มีข้อมูลไม่ตรงกัน",
          };
        }
        setErrors(conflictErrors);
        await onGroupConflict(res.conflicts.map((conflict) => conflict.message));
        setBusy(false);
        focusFirstInvalid();
        return;
      }
      if (Object.keys(errs).length) {
        setBusy(false);
        focusFirstInvalid();
        return;
      }
      const existing = (res.group_results ?? []).flatMap((group, gi) => group.exists.map((alpl) => ({ alpl, package_size: groups[gi]?.package_size ?? "" })));
      const missing = (res.group_results ?? []).flatMap((group, gi) => group.missing.map((alpl) => ({ alpl, package_size: groups[gi]?.package_size ?? "" })));
      if (mode === "New" && existing.length) {
        if (!await confirmExisting(existing)) { setBusy(false); return; }
      }
      if ((mode === "IPM" || mode === "Rework") && missing.length) {
        const ok = await confirmRegister(missing);
        if (!ok) { setBusy(false); return; }
      }
    } catch {
      onNotify("ตรวจสอบ ALPL ไม่สำเร็จ กรุณาลองบันทึกอีกครั้ง");
      setBusy(false);
      return;
    }
    setBusy(false);

    onSave({
      mode,
      operator: operator.trim(),
      triggerMode,
      trayCapacity: capacity,
      // ส่ง number_alpl เป็น "ลิสต์ตัวเลข" ให้ backend ตรง ๆ ไม่ใช่ string ดิบ
      groups: groups.map((g, gi) => ({ ...g, recieve_date: g.receive_date ?? "", number_alpl: perGroupLists[gi] })),
      list: all,
    });
  }

  return (
    <div className="modal-overlay open">
      <div className="pe-modal-box" ref={boxRef}>
        <div className="pe-modal-header">
          <div className="card-title">Part Entry</div>
          <button className="pe-modal-close" title="Close" onClick={onClose}>✕</button>
        </div>

        <div className="entry-toggle">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              className={`entry-toggle-btn${mode === m ? " active" : ""}`}
              disabled={triggerOnly}
              /* ⚠ switchMode เป็น async (รอคำตอบจาก dialog) — ต้อง catch เอง
                 ไม่งั้นถ้ามันโยน exception จะกลายเป็น unhandled rejection ที่
                 ไม่มีอะไรแสดงบนจอเลย ผู้ใช้เห็นแค่ปุ่มกดแล้วไม่เกิดอะไรขึ้น */
              onClick={() => { switchMode(m).catch((e) => console.error("switchMode:", e)); }}
            >
              {m}
            </button>
          ))}
        </div>

        <div className="entry-session-hint">
          {triggerOnly
            ? "ข้อมูลชิ้นงานถูกล็อกไว้ เปลี่ยนได้เฉพาะ Trigger และจะใช้ค่าที่เลือกเมื่อกด Continue"
            : "ℹ️ ลำดับ ALPL ที่กรอก (ไล่จากกลุ่มบนลงล่าง) คือลำดับที่ค่าที่วัดได้จะถูก map เข้าไป — 1 กลุ่มคือ ALPL ที่ใช้ข้อมูลชุดเดียวกัน"}
        </div>

        {/* ⚠ แถบนี้คือสิ่งที่ทำให้อาการ "ช่องเลือกว่าง" ไม่เงียบอีกต่อไป
            เดิมโหลด lookup ไม่สำเร็จแล้วได้ [] ซึ่งหน้าตาเหมือน "ไม่มีข้อมูลในระบบ"
            เป๊ะ ผู้ใช้จะไปไล่หาที่ DB แทนที่จะรู้ว่าแค่ถามไม่ติด

            ไม่มีปุ่ม "ลองใหม่" โดยตั้งใจ — ระบบลองให้เองอยู่แล้วไม่จำกัดครั้ง
            ปุ่มจะทำให้เข้าใจผิดว่าต้องกดถึงจะทำงาน */}
        {lookupFailed && !triggerOnly && (
          <div className="entry-session-hint warn">
            {lookupCached
              ? <>⚠️ ข้อมูลในตัวเลือกเป็นข้อมูลเก่า กำลังลองโหลดใหม่อีกครั้ง</>
              : <>⚠️ โหลดตัวเลือกบางชุดไม่สำเร็จ กำลังลองโหลดใหม่อีกครั้ง</>}
          </div>
        )}

        {/* ค่าระดับ Session อยู่แถวเดียวกัน; triggerOnly แก้ได้เฉพาะ Trigger */}
        <div className="pe-session-fields">
          <div className="form-group entry-field">
            <label htmlFor="pe-operator">Operator<span className="req">*</span></label>
            <SingleSelect
              id="pe-operator"
              label="Operator"
              options={triggerOnly && operator && !operators.includes(operator) ? [operator, ...operators] : operators}
              value={operator}
              disabled={triggerOnly}
              onChange={setOperator}
              placeholder="เลือก Operator"
              invalid={!!operatorError}
              searchable={false}
              showRadio={false}
            />
            {operatorError && <div className="field-error">{operatorError}</div>}
          </div>

          <div className="form-group">
            <label htmlFor="pe-trigger-mode">Trigger</label>
            <SingleSelect
              id="pe-trigger-mode"
              label="Trigger"
              options={[{ value: "auto", label: "MCU (Auto)" }, { value: "manual", label: "Manual (Web)" }]}
              value={triggerMode}
              onChange={(value) => setTriggerMode(value as TriggerMode)}
              placeholder="MCU (Auto)"
              searchable={false}
              showRadio={false}
            />
          </div>

          <div className="form-group entry-tray-capacity">
            <label htmlFor="pe-tray-capacity">Tray Capacity</label>
            <input id="pe-tray-capacity" type="number" min="0" step="1"
              className={trayCapacityError ? "invalid" : undefined}
              value={trayCapacity}
              disabled={triggerOnly || triggerMode === "manual"}
              aria-invalid={!!trayCapacityError} aria-describedby="pe-tray-capacity-hint"
              onWheel={(e) => e.currentTarget.blur()}
              onChange={e => { setTrayCapacity(e.target.value); setTrayCapacityError(""); }} />
            {trayCapacityError && <div className="field-error">{trayCapacityError}</div>}
          </div>
        </div>
        <div id="pe-tray-capacity-hint" className="entry-session-hint pe-session-help">
          {triggerMode === "auto"
            ? "MCU เริ่มวัดเมื่อชิ้นงานเข้าที่ · Tray Capacity เว้นว่างใช้ 8, ใส่ 0 เพื่อไม่ตรวจถาดเต็ม"
            : "Manual: กด Trigger บนหน้าเว็บเพื่อวัดทีละชิ้น · ไม่ใช้ Tray Capacity"}
        </div>

        <EntryGroups
          /* ⚠ key ผูกกับ mode — บังคับให้ component เกิดใหม่ทั้งตัวเมื่อสลับโหมด
             เพราะ EntryGroups ถือ state ภายในที่ผู้เรียกล้างให้ไม่ได้:
               autoRef   ช่องไหนถูกระบบเติมค่าให้แล้วล็อกไว้
               collapsed กลุ่มไหนถูกย่อ
               timers    debounce ของ prefill
             ถ้าไม่ใส่ สถานะล็อกช่องที่ autofill จากโหมดก่อนอาจค้างข้ามโหมด */
          key={mode}
          mode={mode}
          groups={groups}
          disabled={triggerOnly}
          onChange={setGroups}
          errors={errors}
          onOverwrite={(message) => onNotify(message, undefined, "warning")}
          options={{ vendor: vendors, owner: owners, packageSize: packageSizes,
                     partNumbersFor, handlersFor, tolerancesFor, handlerOfPartNumber }}
        />

        <div className="entry-actions">
          <button type="button" className="btn-submit-entry" disabled={busy} onClick={handleSave}>
            ✓ Save
          </button>
          {/* บอกให้รู้ว่า Save ไม่ผ่านเพราะอะไร — ของเดิม handleSave แค่ return เงียบ ๆ
              ถ้าช่องที่ขาดอยู่ในกลุ่มที่ยุบไว้ ผู้ใช้จะไม่เห็นอะไรเลยว่าเกิดอะไรขึ้น */}
          {Object.keys(errors).length > 0 && (
            <span className="entry-actions-error">
              ยังกรอกไม่ครบใน{" "}
              {Object.keys(errors).map(Number).sort((a, b) => a - b)
                .map((gi) => `กลุ่มที่ ${gi + 1}`).join(" · ")}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
