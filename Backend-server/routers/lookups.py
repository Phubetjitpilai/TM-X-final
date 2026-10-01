"""routers/lookups.py — ตารางอ้างอิง 7 ตัว ที่ dropdown ใช้ (operator/owner/vendor/handler/template/package_size/part_number)

ย้ายมาจาก main.py แบบยกก้อน ไม่ได้แก้ตรรกะใดๆ
⚠ ห้ามประกาศ session_queues / measure_timeouts / subscribers ซ้ำในไฟล์นี้
  ต้องดึงจาก shared.py เท่านั้น ไม่งั้นจะกลายเป็นคนละ object โดยไม่มี error
"""
from fastapi import APIRouter

from shared import *  # noqa: F401,F403

router = APIRouter()


# ══════════════════════════════════════════════════════════════════════════════
# Lookup endpoints (dropdown data สำหรับ index.html / edit.html)
# ══════════════════════════════════════════════════════════════════════════════
# Dropdown ทุกตัวนี้เป็นแบบ "ปิด" (closed) — frontend เลือกได้เฉพาะค่าที่มีอยู่
# จริงใน DB เท่านั้น ไม่มีช่องพิมพ์เพิ่มค่าใหม่ในฟอร์ม ถ้าต้องเพิ่ม
# owner/vendor/handler/operator ใหม่ ต้อง insert ตรงเข้า DB เอง
# (ตามที่คุยกันไว้ — ไม่ทำ "add new" inline ในฟอร์ม)
@router.get("/api/operators")
def list_operators():
    db = get_db()
    try:
        with db.cursor() as cur:
            cur.execute("SELECT operator_id, operator_name FROM operator ORDER BY operator_name")
            return cur.fetchall()
    finally:
        db.close()

@router.get("/api/owners")
def list_owners():
    db = get_db()
    try:
        with db.cursor() as cur:
            cur.execute("SELECT owner_id, owner_name FROM owner ORDER BY owner_name")
            return cur.fetchall()
    finally:
        db.close()

@router.get("/api/vendors")
def list_vendors():
    db = get_db()
    try:
        with db.cursor() as cur:
            cur.execute("SELECT vendor_id, vendor_name FROM vendor ORDER BY vendor_name")
            return cur.fetchall()
    finally:
        db.close()

@router.get("/api/handlers")
def list_handlers():
    db = get_db()
    try:
        with db.cursor() as cur:
            cur.execute("SELECT handler_id, handler_name FROM handler ORDER BY handler_name")
            return cur.fetchall()
    finally:
        db.close()

@router.get("/api/package-sizes")
def list_package_sizes():
    """คืนรายการ package_size พร้อมรายชื่อ handler ที่ตั้ง Template ไว้
    และเป็นแหล่งข้อมูลของตาราง Lookup Tables → Package Size

    เกณฑ์ OK/NG อยู่ใน package_size_tolerance ซึ่งมีได้หลายชุดต่อขนาด

    ⚠ `handlers` คืนเป็น **ลิสต์ของสตริง** ไม่ใช่สตริงคั่นคอมมา — แตกที่นี่
      ไม่ปล่อยให้ฝั่ง React ไป `split(",")` เอง เพราะวันหลังถ้ามีชื่อ handler
      ที่มีคอมมาอยู่ข้างใน มันจะแตกผิดแบบเงียบๆ โดยไม่มีอะไรเตือน
      ขนาดที่ยังไม่ผูกเครื่องไหนเลยได้ `[]` (ไม่ใช่ null) ฝั่งหน้าเว็บจะได้
      ไม่ต้องเช็ค 2 แบบ
    """
    db = get_db()
    try:
        with db.cursor() as cur:
            cur.execute(
                "SELECT ps.package_size_id, ps.package_size, "
                # LEFT JOIN + GROUP BY: ขนาดที่ไม่มี handler เลยต้องยังอยู่ในผลลัพธ์
                # (ถ้าใช้ JOIN ธรรมดาจะหายไปทั้งแถว แล้วแก้ฟิลด์อื่นของมันไม่ได้เลย)
                "       GROUP_CONCAT(h.handler_name ORDER BY h.handler_name) AS handlers "
                "FROM package_size ps "
                "LEFT JOIN package_size_handler_template psh ON psh.package_size_id = ps.package_size_id "
                "LEFT JOIN handler h ON h.handler_id = psh.handler_id "
                "GROUP BY ps.package_size_id "
                "ORDER BY ps.package_size"
            )
            rows = cur.fetchall()
            for r in rows:
                r["handlers"] = r["handlers"].split(",") if r["handlers"] else []
            return rows
    finally:
        db.close()

@router.get("/api/package-size-tolerances")
def list_package_size_tolerances():
    db = get_db()
    try:
        with db.cursor() as cur:
            cur.execute(
                "SELECT pst.tolerance_id, pst.package_size_id, ps.package_size, "
                "       pst.nominal_x, pst.nominal_y, pst.upper_tol, "
                "       pst.lower_tol, pst.offset_tol "
                "FROM package_size_tolerance pst "
                "JOIN package_size ps ON ps.package_size_id = pst.package_size_id "
                "ORDER BY ps.package_size, pst.tolerance_id"
            )
            return cur.fetchall()
    finally:
        db.close()

@router.get("/api/part-numbers")
def list_part_numbers(package_size: str = Query(..., min_length=1)):
    """คืนรายการ part_number (จากตาราง catalog part_number ตรงๆ ไม่ใช่ derive
    จาก parts_specifications ที่เคยลงทะเบียนแล้ว) ที่ผูกกับ package_size ที่
    ระบุ — ใช้เป็น dropdown ของช่อง Part Number ที่ cascade จาก Package Size
    ในฟอร์ม Part Entry (New/Rework/IPM) เป็น dropdown "ปิด" เหมือน
    operator/vendor/handler/owner/package_size — เลือกได้เฉพาะ part_number ที่
    มีอยู่จริงในตาราง part_number เท่านั้น ไม่มีช่องพิมพ์เพิ่มค่าใหม่ (handler
    ของ part นั้นๆ ผูกมากับ part_number อยู่แล้ว ไม่ต้องให้ผู้ใช้เลือก Handler
    เองอีกที)
    """
    db = get_db()
    try:
        with db.cursor() as cur:
            cur.execute(
                "SELECT pn.part_number_name FROM part_number pn "
                "JOIN package_size ps ON pn.package_size_id = ps.package_size_id "
                "WHERE ps.package_size = %s "
                "ORDER BY pn.part_number_name",
                (package_size,),
            )
            return [row["part_number_name"] for row in cur.fetchall()]
    finally:
        db.close()

@router.get("/api/templates")
def list_templates():
    """คืนรายการ template ทั้งหมด — ใช้โดย Database Editor (edit.html) ตอน
    จัดการตาราง template และตอนผูก Package Size + Handler กับ Template
    """
    db = get_db()
    try:
        with db.cursor() as cur:
            cur.execute("SELECT template_id, template_name FROM template ORDER BY template_name")
            return cur.fetchall()
    finally:
        db.close()

@router.get("/api/part-numbers/all")
def list_all_part_numbers():
    """คืนรายการ part_number ทั้งหมด — ใช้โดย Database Editor หน้า Edit
    ต่างจาก GET /api/part-numbers (คืนแค่ชื่อ กรองด้วย package_size — ใช้เป็น
    cascading dropdown ของฟอร์ม Part Entry)

    ⚠ **ไม่มี nominal/tolerance แล้ว** — part_number ไม่ได้ถือเกณฑ์ตัดสินอีกต่อไป
      ทุกโหมดใช้ของ `package_size` (ดู `_load_criteria` ใน shared.py)
      ถ้าอยากรู้เกณฑ์ของ part ตัวไหน ให้ดูที่ `package_size` ที่มันผูกอยู่
    """
    db = get_db()
    try:
        with db.cursor() as cur:
            cur.execute(
                "SELECT pn.part_number_id, pn.part_number_name, ps.package_size, "
                "h.handler_name AS handler "
                "FROM part_number pn "
                "JOIN package_size ps ON pn.package_size_id = ps.package_size_id "
                "JOIN handler h       ON pn.handler_id = h.handler_id "
                "ORDER BY pn.part_number_name"
            )
            return cur.fetchall()
    finally:
        db.close()

# ══════════════════════════════════════════════════════════════════════════════
# Lookup table management (Database Editor — Add/Rename/Delete)
# ══════════════════════════════════════════════════════════════════════════════
# operator/owner/vendor/handler/template เป็นตารางรูปแบบเดียวกันหมด (id + ชื่อ
# ตัวเดียว) เลยใช้ helper function ชุดเดียวกัน 3 ตัวนี้ร่วมกันได้ทั้งหมด แทนที่
# จะเขียน insert/rename/delete แยกกันซ้ำๆ ทีละตาราง — ยังคง endpoint แยกกัน
# ตามตารางเหมือนเดิม (ไม่ทำ dynamic routing) เพื่อให้ URL คาดเดาได้ตรงไปตรงมา
def _create_lookup(table: str, name_col: str, name: str) -> int:
    db = get_db()
    try:
        with db.cursor() as cur:
            try:
                cur.execute(f"INSERT INTO {table} ({name_col}) VALUES (%s)", (name,))
            except pymysql.MySQLError as exc:
                raise HTTPException(409, f"เพิ่มไม่สำเร็จ (ชื่อนี้อาจมีอยู่แล้ว): {exc}")
            new_id = cur.lastrowid
            log_edit(table, "add", name, after={name_col: name})
            return new_id
    finally:
        db.close()

def _rename_lookup(table: str, id_col: str, name_col: str, id_value: int, name: str) -> None:
    db = get_db()
    try:
        with db.cursor() as cur:
            # อ่านชื่อเดิมไว้ก่อน UPDATE — ต้องได้ตอนแถวยังเป็นค่าเก่าอยู่
            # ไม่งั้นประวัติจะมีแต่ "หลังแก้" ซึ่งไม่บอกอะไรเลย
            old = _fetch_one(cur, f"SELECT {name_col} FROM {table} WHERE {id_col} = %s", (id_value,))
            try:
                cur.execute(f"UPDATE {table} SET {name_col} = %s WHERE {id_col} = %s", (name, id_value))
            except pymysql.MySQLError as exc:
                raise HTTPException(409, f"แก้ไขชื่อไม่สำเร็จ (ชื่อใหม่นี้อาจมีอยู่แล้ว): {exc}")
            if cur.rowcount == 0:
                raise HTTPException(404, "ไม่พบข้อมูล")
            log_edit(table, "edit", name, before=old, after={name_col: name})
    finally:
        db.close()

def _delete_lookup(table: str, id_col: str, id_value: int, references: List[tuple],
                   kind: Optional[str] = None) -> None:
    """ลบ row ของตาราง lookup — ปฏิเสธถ้ายังมีตารางอื่นอ้างอิง id นี้อยู่จริง
    (`references` คือ list ของ (referencing_table, referencing_col)) เพื่อไม่ให้
    Part/Measurement ที่มีอยู่แล้วกลายเป็นข้อมูลกำพร้า (orphan FK) — แนะนำให้
    "เปลี่ยนชื่อ" (rename) แทนถ้ายังมีข้อมูลผูกอยู่ ไม่ใช่ลบทิ้งแล้วสร้างใหม่
    """
    db = get_db()
    try:
        with db.cursor() as cur:
            if table == "package_size_tolerance":
                _block_if_session_running(cur, "ลบ Tolerance")
            for ref_table, ref_col in references:
                cur.execute(f"SELECT 1 FROM {ref_table} WHERE {ref_col} = %s LIMIT 1", (id_value,))
                if cur.fetchone():
                    display_name = _TABLE_DISPLAY_NAME.get(ref_table, ref_table)
                    raise HTTPException(
                        409,
                        f"ลบไม่ได้ — ยังมีข้อมูลใน {display_name} ที่อ้างอิงถึงอยู่ "
                        f"กรุณาเปลี่ยนชื่อแทนถ้าต้องการแก้ไข",
                    )
            # ── สำรองก่อนลบ ── ต้องอ่านตอนแถวยังอยู่ และหลังผ่านด่านเช็ค FK แล้ว
            # (ถ้าเช็คไม่ผ่านจะ raise 409 ไปก่อน ไม่มีอะไรถูกลบ ไม่ต้องสำรอง)
            row = _fetch_one(cur, f"SELECT * FROM {table} WHERE {id_col} = %s", (id_value,))
            if row is None:
                raise HTTPException(404, "ไม่พบข้อมูล")
            trash_id = _archive_before_delete(
                kind=kind or table, table=table, pk={id_col: id_value}, row=row
            )

            cur.execute(f"DELETE FROM {table} WHERE {id_col} = %s", (id_value,))
            if cur.rowcount == 0:
                raise HTTPException(404, "ไม่พบข้อมูล")
            # ป้าย ref ใช้ "ชื่อ" ของแถวที่ลบ ไม่ใช่ id — ประวัติต้องอ่านรู้เรื่อง
            # หลังแถวหายไปแล้ว (id ที่ตายไปแล้วไม่สื่ออะไรกับใคร)
            name_col = next((k for k in row if k != id_col), id_col)
            log_edit(table, "delete", str(row.get(name_col, id_value)),
                     before=row, trash_id=trash_id)
    finally:
        db.close()

@router.post("/api/operators", status_code=201)
def create_operator(body: LookupCreate):
    return {"operator_id": _create_lookup("operator", "operator_name", body.name)}

@router.patch("/api/operators/{operator_id}")
def rename_operator(operator_id: int, body: LookupUpdate):
    _rename_lookup("operator", "operator_id", "operator_name", operator_id, body.name)
    return {"ok": True}

@router.delete("/api/operators/{operator_id}")
def delete_operator(operator_id: int):
    # operator ถูกอ้างอิงจาก measurements.operator_id เท่านั้น
    _delete_lookup("operator", "operator_id", operator_id, [("measurements", "operator_id")])
    return {"ok": True}

@router.post("/api/owners", status_code=201)
def create_owner(body: LookupCreate):
    return {"owner_id": _create_lookup("owner", "owner_name", body.name)}

@router.patch("/api/owners/{owner_id}")
def rename_owner(owner_id: int, body: LookupUpdate):
    _rename_lookup("owner", "owner_id", "owner_name", owner_id, body.name)
    return {"ok": True}

@router.delete("/api/owners/{owner_id}")
def delete_owner(owner_id: int):
    # owner ถูกอ้างอิงจาก parts_specifications.owner_id เท่านั้น
    _delete_lookup("owner", "owner_id", owner_id, [("parts_specifications", "owner_id")])
    return {"ok": True}

@router.post("/api/vendors", status_code=201)
def create_vendor(body: LookupCreate):
    return {"vendor_id": _create_lookup("vendor", "vendor_name", body.name)}

@router.patch("/api/vendors/{vendor_id}")
def rename_vendor(vendor_id: int, body: LookupUpdate):
    _rename_lookup("vendor", "vendor_id", "vendor_name", vendor_id, body.name)
    return {"ok": True}

@router.delete("/api/vendors/{vendor_id}")
def delete_vendor(vendor_id: int):
    # vendor ถูกอ้างอิงจาก parts_specifications.vendor_id เท่านั้น
    _delete_lookup("vendor", "vendor_id", vendor_id, [("parts_specifications", "vendor_id")])
    return {"ok": True}

@router.post("/api/handlers", status_code=201)
def create_handler(body: LookupCreate):
    return {"handler_id": _create_lookup("handler", "handler_name", body.name)}

@router.patch("/api/handlers/{handler_id}")
def rename_handler(handler_id: int, body: LookupUpdate):
    _rename_lookup("handler", "handler_id", "handler_name", handler_id, body.name)
    return {"ok": True}

@router.delete("/api/handlers/{handler_id}")
def delete_handler(handler_id: int):
    # ⚠ ต้องครบทุกตารางที่มี FK ชี้มาที่ handler — ตกหล่นตัวไหน MySQL จะโยน
    #   FK constraint error ดิบออกมาเป็น **500 ที่ไม่มี CORS header** หน้าเว็บ
    #   อ่านข้อความไม่ได้เลย (ต่างจาก 409 ที่ _delete_lookup ทำให้อ่านรู้เรื่อง)
    #
    #   เดิมเช็คแค่ part_number เพราะสมัยนั้น parts_specifications ยังไม่มี
    #   handler_id และยังไม่มีตาราง package_size_handler
    _delete_lookup("handler", "handler_id", handler_id, [
        ("part_number", "handler_id"),
        ("parts_specifications", "handler_id"),
        ("package_size_handler_template", "handler_id"),
    ])
    return {"ok": True}

@router.post("/api/templates", status_code=201)
def create_template(body: LookupCreate):
    return {"template_id": _create_lookup("template", "template_name", body.name)}

@router.patch("/api/templates/{template_id}")
def rename_template(template_id: int, body: LookupUpdate):
    _rename_lookup("template", "template_id", "template_name", template_id, body.name)
    return {"ok": True}

@router.delete("/api/templates/{template_id}")
def delete_template(template_id: int):
    _delete_lookup("template", "template_id", template_id,
                   [("package_size_handler_template", "template_id")])
    return {"ok": True}

@router.post("/api/package-sizes", status_code=201)
def create_package_size(body: PackageSizeCreate):
    db = get_db()
    try:
        with db.cursor() as cur:
            try:
                cur.execute("INSERT INTO package_size (package_size) VALUES (%s)", (body.package_size,))
            except pymysql.IntegrityError as exc:
                if exc.args[0] == 1062:
                    raise HTTPException(409, "มี Package Size นี้ในระบบแล้ว") from exc
                raise
            new_id = cur.lastrowid
            log_edit("package_size", "add", body.package_size, after={"package_size": body.package_size})
            return {"package_size_id": new_id}
    finally:
        db.close()

@router.patch("/api/package-sizes/{package_size_id}")
def update_package_size(package_size_id: int, body: PackageSizeUpdate):
    if body.package_size is None:
        raise HTTPException(400, "ต้องระบุ Package Size")
    db = get_db()
    try:
        with db.cursor() as cur:
            _block_if_session_running(cur, "แก้ไข Package Size")
            old = _fetch_one(cur, "SELECT package_size FROM package_size WHERE package_size_id=%s", (package_size_id,))
            if old is None:
                raise HTTPException(404, "ไม่พบ Package Size")
            try:
                cur.execute("UPDATE package_size SET package_size=%s WHERE package_size_id=%s",
                            (body.package_size, package_size_id))
            except pymysql.IntegrityError as exc:
                if exc.args[0] == 1062:
                    raise HTTPException(409, "มี Package Size นี้ในระบบแล้ว") from exc
                raise
            log_edit("package_size", "edit", body.package_size, before=old,
                     after={"package_size": body.package_size})
            return {"ok": True}
    finally:
        db.close()

@router.delete("/api/package-sizes/{package_size_id}")
def delete_package_size(package_size_id: int):
    _delete_lookup("package_size", "package_size_id", package_size_id, [
        ("part_number", "package_size_id"),
        ("parts_specifications", "package_size_id"),
        ("package_size_handler_template", "package_size_id"),
        ("package_size_tolerance", "package_size_id"),
    ])
    return {"ok": True}

@router.get("/api/package-size-handler-templates")
def list_package_size_handler_templates():
    db = get_db()
    try:
        with db.cursor() as cur:
            cur.execute(
                "SELECT CONCAT(psht.package_size_id, '-', psht.handler_id) AS mapping_key, "
                "ps.package_size, h.handler_name AS handler, t.template_name "
                "FROM package_size_handler_template psht "
                "JOIN package_size ps ON ps.package_size_id=psht.package_size_id "
                "JOIN handler h ON h.handler_id=psht.handler_id "
                "JOIN template t ON t.template_id=psht.template_id "
                "ORDER BY ps.package_size, h.handler_name"
            )
            return cur.fetchall()
    finally:
        db.close()

def _mapping_ids(cur, body):
    package_size_id = _lookup_id(cur, "package_size", "package_size_id", "package_size", body.package_size)
    handler_id = _lookup_id(cur, "handler", "handler_id", "handler_name", body.handler)
    template_id = _lookup_id(cur, "template", "template_id", "template_name", body.template_name)
    if None in (package_size_id, handler_id, template_id):
        raise HTTPException(400, "ต้องเลือก Package Size, Handler และ Template ที่มีในระบบ")
    return package_size_id, handler_id, template_id

@router.post("/api/package-size-handler-templates", status_code=201)
def create_package_size_handler_template(body: PackageHandlerTemplateCreate = Body(...)):
    db = get_db()
    try:
        with db.cursor() as cur:
            _block_if_session_running(cur, "เพิ่ม Template ของ Handler")
            ids = _mapping_ids(cur, body)
            try:
                cur.execute("INSERT INTO package_size_handler_template "
                            "(package_size_id, handler_id, template_id) VALUES (%s,%s,%s)", ids)
            except pymysql.IntegrityError as exc:
                if exc.args[0] == 1062:
                    raise HTTPException(409, "Package Size และ Handler คู่นี้มี Template ในระบบแล้ว") from exc
                raise
            log_edit("package_size_handler_template", "add", f"{body.package_size} / {body.handler}",
                     after=body.dict())
            return {"mapping_key": f"{ids[0]}-{ids[1]}"}
    finally:
        db.close()

def _parse_mapping_key(mapping_key: str):
    try:
        package_size_id, handler_id = (int(value) for value in mapping_key.split("-", 1))
        if package_size_id < 1 or handler_id < 1:
            raise ValueError
        return package_size_id, handler_id
    except ValueError:
        raise HTTPException(400, "รหัส Package Size / Handler ไม่ถูกต้อง")

def _mapping_has_measurements(cur, package_size_id: int, handler_id: int) -> bool:
    cur.execute(
        "SELECT 1 FROM measurements m "
        "JOIN parts_specifications p ON p.part_id=m.part_id "
        "LEFT JOIN part_number pn ON pn.part_number_id=p.part_number_id "
        "WHERE COALESCE(p.package_size_id,pn.package_size_id)=%s "
        "AND COALESCE(p.handler_id,pn.handler_id)=%s LIMIT 1",
        (package_size_id, handler_id),
    )
    return bool(cur.fetchone())

def _mapping_has_parts(cur, package_size_id: int, handler_id: int) -> bool:
    cur.execute(
        "SELECT 1 FROM parts_specifications p "
        "LEFT JOIN part_number pn ON pn.part_number_id=p.part_number_id "
        "WHERE COALESCE(p.package_size_id,pn.package_size_id)=%s "
        "AND COALESCE(p.handler_id,pn.handler_id)=%s LIMIT 1",
        (package_size_id, handler_id),
    )
    return bool(cur.fetchone())

@router.patch("/api/package-size-handler-templates/{mapping_key}")
def update_package_size_handler_template(mapping_key: str, body: PackageHandlerTemplateUpdate = Body(...)):
    package_size_id, handler_id = _parse_mapping_key(mapping_key)
    db = get_db()
    try:
        with db.cursor() as cur:
            _block_if_session_running(cur, "แก้ไข Template ของ Handler")
            old = _fetch_one(cur,
                "SELECT ps.package_size, h.handler_name AS handler, t.template_name "
                "FROM package_size_handler_template psht "
                "JOIN package_size ps ON ps.package_size_id=psht.package_size_id "
                "JOIN handler h ON h.handler_id=psht.handler_id "
                "JOIN template t ON t.template_id=psht.template_id "
                "WHERE psht.package_size_id=%s AND psht.handler_id=%s",
                (package_size_id, handler_id))
            if old is None:
                raise HTTPException(404, "ไม่พบคู่ Package Size / Handler")
            if ((body.package_size is not None and body.package_size != old["package_size"])
                    or (body.handler is not None and body.handler != old["handler"])):
                raise HTTPException(400, "เปลี่ยน Package Size หรือ Handler ของคู่นี้ไม่ได้; ให้ลบแล้วเพิ่มคู่ใหม่")
            if not body.template_name:
                raise HTTPException(400, "ต้องเลือก Template")
            if body.template_name == old["template_name"]:
                return {"ok": True}
            if _mapping_has_measurements(cur, package_size_id, handler_id):
                raise HTTPException(409, "คู่นี้มีผลวัดอ้างอิงแล้ว เปลี่ยน Template จะทำให้ประวัติคลาดเคลื่อน")
            template_id = _lookup_id(cur, "template", "template_id", "template_name", body.template_name)
            cur.execute("UPDATE package_size_handler_template SET template_id=%s "
                        "WHERE package_size_id=%s AND handler_id=%s",
                        (template_id, package_size_id, handler_id))
            log_edit("package_size_handler_template", "edit", f"{old['package_size']} / {old['handler']}",
                     before=old, after={**old, "template_name": body.template_name})
            return {"ok": True}
    finally:
        db.close()

@router.delete("/api/package-size-handler-templates/{mapping_key}")
def delete_package_size_handler_template(mapping_key: str):
    package_size_id, handler_id = _parse_mapping_key(mapping_key)
    db = get_db()
    try:
        with db.cursor() as cur:
            _block_if_session_running(cur, "ลบ Template ของ Handler")
            old = _fetch_one(cur,
                "SELECT ps.package_size, h.handler_name AS handler, t.template_name "
                "FROM package_size_handler_template psht "
                "JOIN package_size ps ON ps.package_size_id=psht.package_size_id "
                "JOIN handler h ON h.handler_id=psht.handler_id "
                "JOIN template t ON t.template_id=psht.template_id "
                "WHERE psht.package_size_id=%s AND psht.handler_id=%s",
                (package_size_id, handler_id))
            if old is None:
                raise HTTPException(404, "ไม่พบคู่ Package Size / Handler")
            cur.execute("SELECT 1 FROM part_number WHERE package_size_id=%s AND handler_id=%s LIMIT 1",
                        (package_size_id, handler_id))
            if cur.fetchone() or _mapping_has_parts(cur, package_size_id, handler_id):
                raise HTTPException(409, "คู่นี้ถูกใช้งานแล้ว ลบไม่ได้")
            cur.execute("DELETE FROM package_size_handler_template "
                        "WHERE package_size_id=%s AND handler_id=%s", (package_size_id, handler_id))
            log_edit("package_size_handler_template", "delete",
                     f"{old['package_size']} / {old['handler']}", before=old)
            return {"ok": True}
    finally:
        db.close()

@router.post("/api/package-size-tolerances", status_code=201)
def create_package_size_tolerance(body: PackageToleranceCreate = Body(...)):
    db = get_db()
    try:
        with db.cursor() as cur:
            package_size_id = _lookup_id(cur, "package_size", "package_size_id", "package_size", body.package_size)
            if package_size_id is None:
                raise HTTPException(400, "ไม่พบ Package Size ที่เลือก")
            values = {field: getattr(body, field) for field in _PKG_NUM_FIELDS}
            _reject_duplicate_tolerance(cur, package_size_id, values)
            try:
                cur.execute(
                    "INSERT INTO package_size_tolerance "
                    "(package_size_id, nominal_x, nominal_y, upper_tol, lower_tol, offset_tol) "
                    "VALUES (%s, %s, %s, %s, %s, %s)",
                    (package_size_id, *(values[field] for field in _PKG_NUM_FIELDS)),
                )
            except pymysql.IntegrityError as exc:
                if exc.args[0] == 1062:
                    raise HTTPException(409, "มีข้อมูล Tolerance ชุดนี้ในระบบแล้ว") from exc
                raise
            tolerance_id = cur.lastrowid
            log_edit("package_size_tolerance", "add", f"{body.package_size} / #{tolerance_id}", after=body.dict())
            return {"tolerance_id": tolerance_id}
    finally:
        db.close()

def _reject_duplicate_tolerance(cur, package_size_id: int, values: Dict[str, float], exclude_id: Optional[int] = None) -> None:
    # ฟอร์มและผลวัดใช้ความละเอียด 0.001; FLOAT อาจเก็บ 4.27 เป็น 4.269999…
    checks = " AND ".join(f"ROUND({field}, 3) = ROUND(%s, 3)" for field in _PKG_NUM_FIELDS)
    sql = f"SELECT tolerance_id FROM package_size_tolerance WHERE package_size_id = %s AND {checks}"
    params: List[Any] = [package_size_id, *(values[field] for field in _PKG_NUM_FIELDS)]
    if exclude_id is not None:
        sql += " AND tolerance_id <> %s"
        params.append(exclude_id)
    sql += " LIMIT 1"
    cur.execute(sql, params)
    if cur.fetchone():
        raise HTTPException(409, "มีข้อมูล Tolerance ชุดนี้ในระบบแล้ว")

@router.patch("/api/package-size-tolerances/{tolerance_id}")
def update_package_size_tolerance(tolerance_id: int, body: PackageToleranceUpdate = Body(...)):
    db = get_db()
    try:
        with db.cursor() as cur:
            _block_if_session_running(cur, "แก้ไข Tolerance")
            old = _fetch_one(cur, "SELECT * FROM package_size_tolerance WHERE tolerance_id = %s", (tolerance_id,))
            if old is None:
                raise HTTPException(404, "ไม่พบ Tolerance")
            changes, values = [], []
            if body.package_size is not None:
                package_size_id = _lookup_id(cur, "package_size", "package_size_id", "package_size", body.package_size)
                if package_size_id is None:
                    raise HTTPException(400, "ไม่พบ Package Size ที่เลือก")
                if package_size_id != old["package_size_id"]:
                    cur.execute("SELECT 1 FROM parts_specifications WHERE tolerance_id = %s LIMIT 1", (tolerance_id,))
                    if cur.fetchone():
                        raise HTTPException(409, "Tolerance นี้ถูกใช้โดย ALPL แล้ว ย้ายไป Package Size อื่นไม่ได้")
                changes.append("package_size_id = %s")
                values.append(package_size_id)
            for field in _PKG_NUM_FIELDS:
                value = getattr(body, field)
                if value is not None:
                    changes.append(f"{field} = %s")
                    values.append(value)
            if any(getattr(body, field) is not None and abs(getattr(body, field) - float(old[field])) > 1e-6
                   for field in _PKG_NUM_FIELDS):
                cur.execute("SELECT 1 FROM measurements WHERE tolerance_id = %s LIMIT 1", (tolerance_id,))
                if cur.fetchone():
                    raise HTTPException(409, "Tolerance นี้มีผลวัดอ้างอิงแล้ว กรุณาเพิ่ม Tolerance ชุดใหม่แทน")
            if not changes:
                raise HTTPException(400, "No valid fields provided")
            target_package_size_id = package_size_id if body.package_size is not None else old["package_size_id"]
            candidate = {field: getattr(body, field) if getattr(body, field) is not None else old[field]
                         for field in _PKG_NUM_FIELDS}
            _reject_duplicate_tolerance(cur, target_package_size_id, candidate, exclude_id=tolerance_id)
            try:
                cur.execute(
                    f"UPDATE package_size_tolerance SET {', '.join(changes)} WHERE tolerance_id = %s",
                    (*values, tolerance_id),
                )
            except pymysql.IntegrityError as exc:
                if exc.args[0] == 1062:
                    raise HTTPException(409, "มีข้อมูล Tolerance ชุดนี้ในระบบแล้ว") from exc
                raise
            new = _fetch_one(cur, "SELECT * FROM package_size_tolerance WHERE tolerance_id = %s", (tolerance_id,))
            log_edit("package_size_tolerance", "edit", f"Tolerance #{tolerance_id}", before=old, after=new)
        return {"ok": True}
    finally:
        db.close()

@router.delete("/api/package-size-tolerances/{tolerance_id}")
def delete_package_size_tolerance(tolerance_id: int):
    _delete_lookup("package_size_tolerance", "tolerance_id", tolerance_id, [
        ("parts_specifications", "tolerance_id"), ("measurements", "tolerance_id"),
    ])
    return {"ok": True}

@router.post("/api/part-numbers", status_code=201)
def create_part_number(body: PartNumberCreate):
    db = get_db()
    try:
        with db.cursor() as cur:
            package_size_id = _lookup_id(cur, "package_size", "package_size_id", "package_size", body.package_size)
            handler_id      = _lookup_id(cur, "handler",      "handler_id",      "handler_name",  body.handler)
            if package_size_id is None or handler_id is None:
                raise HTTPException(400, "ต้องระบุ package_size และ handler ที่มีอยู่จริงในระบบ")
            # ⚠ ไม่มี nominal/tolerance แล้ว — part_number เหลือแค่ "ชื่อ + ผูกกับ
            #   package_size ตัวไหน + ใช้ handler ตัวไหน" เกณฑ์ตัดสินทั้งหมดอยู่ที่
            #   package_size ทุกโหมด (ดู `_load_criteria` ใน shared.py)
            try:
                cur.execute(
                    "INSERT INTO part_number "
                    "(part_number_name, package_size_id, handler_id) "
                    "VALUES (%s, %s, %s)",
                    (body.part_number_name, package_size_id, handler_id),
                )
            except pymysql.MySQLError as exc:
                raise HTTPException(409, f"เพิ่ม Part Number ไม่สำเร็จ (ชื่อนี้อาจมีอยู่แล้ว): {exc}")
            log_edit("part_number", "add", body.part_number_name, after={
                "part_number_name": body.part_number_name,
                "package_size": body.package_size, "handler": body.handler,
            })
            return {"part_number_id": cur.lastrowid}
    finally:
        db.close()

@router.patch("/api/part-numbers/{part_number_id}")
def update_part_number(part_number_id: int, body: PartNumberUpdate):
    db = get_db()
    try:
        with db.cursor() as cur:
            set_parts, values = [], []
            if body.part_number_name is not None:
                set_parts.append("part_number_name = %s")
                values.append(body.part_number_name)
            if body.package_size is not None:
                package_size_id = _lookup_id(cur, "package_size", "package_size_id", "package_size", body.package_size)
                set_parts.append("package_size_id = %s")
                values.append(package_size_id)
            if body.handler is not None:
                handler_id = _lookup_id(cur, "handler", "handler_id", "handler_name", body.handler)
                set_parts.append("handler_id = %s")
                values.append(handler_id)
            # ⚠ เดิมมีลูปเติม nominal/tolerance ตรงนี้ — ถอดออกแล้วเพราะ part_number
            #   ไม่ได้ถือเกณฑ์อีกต่อไป แก้เกณฑ์ให้ไปแก้ที่ Package Size แทน
            if not set_parts:
                raise HTTPException(400, "No valid fields provided")
            old = _fetch_one(cur,
                "SELECT pn.part_number_name, ps.package_size, h.handler_name AS handler "
                "FROM part_number pn "
                "LEFT JOIN package_size ps ON pn.package_size_id = ps.package_size_id "
                "LEFT JOIN handler h       ON pn.handler_id = h.handler_id "
                "WHERE pn.part_number_id = %s", (part_number_id,))
            try:
                cur.execute(
                    f"UPDATE part_number SET {', '.join(set_parts)} WHERE part_number_id = %s",
                    (*values, part_number_id),
                )
            except pymysql.MySQLError as exc:
                raise HTTPException(409, f"แก้ไข Part Number ไม่สำเร็จ (ชื่อใหม่นี้อาจมีอยู่แล้ว): {exc}")
            if old:
                new = dict(old)
                if body.part_number_name is not None: new["part_number_name"] = body.part_number_name
                if body.package_size is not None: new["package_size"] = body.package_size
                if body.handler is not None: new["handler"] = body.handler
                log_edit("part_number", "edit",
                         new.get("part_number_name") or str(part_number_id), before=old, after=new)
            if cur.rowcount == 0:
                raise HTTPException(404, "Part Number not found")
        return {"ok": True}
    finally:
        db.close()

@router.delete("/api/part-numbers/{part_number_id}")
def delete_part_number(part_number_id: int):
    # part_number ถูกอ้างอิงจาก parts_specifications.part_number_id เท่านั้น
    _delete_lookup("part_number", "part_number_id", part_number_id, [("parts_specifications", "part_number_id")])
    return {"ok": True}


# ══════════════════════════════════════════════════════════════════════════════
# ประวัติการแก้ไข (หน้า Edit → การ์ด History)
# ══════════════════════════════════════════════════════════════════════════════
# ชื่อตารางที่โชว์บนหน้าเว็บ — เก็บ mapping ไว้ฝั่ง backend เพราะ table_name ใน
# DB เป็นชื่อทางเทคนิค (parts_specifications / package_size) ที่ไม่ตรงกับหัวข้อ
# ที่ผู้ใช้เห็นในหน้า Edit
_HISTORY_LABEL = {
    "parts": "Parts", "measurements": "Measurements",
    "operator": "Operator", "owner": "Owner", "vendor": "Vendor",
    "handler": "Handler", "template": "Template",
    "package_size": "Package Size", "part_number": "Part Number",
}

@router.get("/api/history")
def list_history(
    table_name: Optional[str] = None,
    action: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    limit: int = Query(20, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """ประวัติการแก้ไขข้อมูล เรียงจากใหม่ไปเก่า

    คืน {items, total} รูปแบบเดียวกับ /api/parts เพื่อให้หน้าเว็บใช้ตัวแบ่งหน้า
    ตัวเดิมได้เลย

    ⚠ ปลายช่วงวันที่ถูกครอบเต็มวันที่นี่ (_day_end) เหมือนหน้า Export — ส่ง
      "2026-08-20" มาเฉย ๆ ต้องได้ข้อมูลของวันที่ 20 ทั้งวัน ไม่ใช่หยุดที่ 00:00
    """
    where, params = [], []
    if table_name:
        where.append("table_name = %s"); params.append(table_name)
    if action:
        where.append("action = %s"); params.append(action)
    if date_from:
        where.append("edited_at >= %s"); params.append(_day_start(date_from))
    if date_to:
        where.append("edited_at <= %s"); params.append(_day_end(date_to))
    clause = ("WHERE " + " AND ".join(where)) if where else ""

    db = get_db()
    try:
        with db.cursor() as cur:
            # ตารางอาจยังไม่ถูกสร้าง (DB หน้างานที่ยังไม่ได้รัน sql-tools/
            # add_edit_history.sql) — ตอบเป็น "ยังไม่มีประวัติ" ดีกว่าปล่อย 500
            # ให้หน้า Edit พังทั้งหน้าเพราะการ์ดเสริมใบเดียว
            try:
                cur.execute(f"SELECT COUNT(*) AS n FROM edit_history {clause}", params)
                total = cur.fetchone()["n"]
                cur.execute(
                    f"SELECT history_id, edited_at, table_name, action, ref, changes_json, trash_id "
                    f"FROM edit_history {clause} "
                    f"ORDER BY edited_at DESC, history_id DESC LIMIT %s OFFSET %s",
                    (*params, limit, offset),
                )
                rows = cur.fetchall()
            except pymysql.MySQLError as exc:
                # ส่งสาเหตุกลับไปด้วย — ของเดิมตอบแค่ ready:false ซึ่งบอกแค่ว่า
                # "ไม่ได้" แต่ไม่บอกว่าทำไม ทำให้ต้องไปไล่หาใน log เอง
                log.warning("อ่าน edit_history ไม่สำเร็จ ที่ %s — %s", _db_identity(), exc)
                return {"items": [], "total": 0, "ready": False,
                        "reason": str(exc), "db": _db_identity()}

            items = []
            for r in rows:
                raw = r["changes_json"]
                # pymysql คืน JSON column มาเป็น str หรือ dict/list แล้วแต่เวอร์ชัน
                changes = raw if isinstance(raw, (list, dict)) else (json.loads(raw) if raw else [])
                items.append({
                    "history_id":   r["history_id"],
                    "edited_at":    _json_safe(r["edited_at"]),
                    "table_name":   r["table_name"],
                    "table_label":  _HISTORY_LABEL.get(r["table_name"], r["table_name"]),
                    "action":       r["action"],
                    "ref":          r["ref"],
                    "changes":      changes,
                    "trash_id":     r["trash_id"],
                })
            return {"items": items, "total": total, "ready": True}
    finally:
        db.close()
