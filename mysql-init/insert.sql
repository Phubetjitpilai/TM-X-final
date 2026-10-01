-- seed_lookup_data.sql
-- ฐานข้อมูลใหม่: รัน init.sql แล้วไฟล์นี้ (โครงสร้าง ALPL + Package Size อยู่ใน init.sql)
-- ฐานข้อมูลเดิมที่มีข้อมูล: ใช้ insert_pkg_tolerance.sql สำหรับ migration;
-- ถ้าเคยรันไฟล์นั้นไปแล้ว ใช้ migrate_alpl_package_identity.sql แยกต่างหาก
-- Insert ข้อมูลตั้งต้นให้ตาราง lookup (operator/owner/handler/vendor/template/
-- package_size/part_number) ใช้ INSERT IGNORE เพื่อให้รันซ้ำได้โดยไม่ error
-- (ชื่อซ้ำจะถูกข้าม เพราะทุกตารางมี UNIQUE อยู่แล้วบนคอลัมน์ชื่อ — ดู init.sql)

USE tmx_db;

-- ── Operator ─────────────────────────────────────────────────────────────
INSERT IGNORE INTO operator (operator_name) VALUES
  ('Boss'),
  ('Nut');

-- ── Owner ────────────────────────────────────────────────────────────────
INSERT IGNORE INTO owner (owner_name) VALUES
  ('Messi'),
  ('Ronaldo');

-- ── Handler ──────────────────────────────────────────────────────────────
INSERT IGNORE INTO handler (handler_name) VALUES
  ('HT9046'),
  ('HT9046MX');

-- ── Vendor ───────────────────────────────────────────────────────────────
INSERT IGNORE INTO vendor (vendor_name) VALUES
  ('A'),
  ('B'),
  ('C');

-- ── Template ───────────────────────────────────────────────────────────────
INSERT IGNORE INTO template (template_name) VALUES
  ('201');

-- ── Package Size ─────────────────────────────────────────────────────────
-- ค่า nominal/tolerance อยู่ใน package_size_tolerance แยกจากชื่อขนาด
--
-- ที่มาของตัวเลข:
--   • ขนาดที่มี part_number อ้างถึงอยู่แล้ว → ลอกค่าจากบล็อก part_number
--     ท้ายไฟล์นี้ตรงๆ (ถ้า part_number หลายตัวใช้ package เดียวกันแล้วค่าไม่ตรง
--     กัน เช่น 3x3 กับ 3.5x3.75 → ใช้ค่าที่พบบ่อยที่สุด)
--   • ขนาดที่ยังไม่มี part_number ตัวไหนอ้างถึง → เดาจากรูปแบบเดียวกัน
--     (nominal = ขนาดตามชื่อ + 0.03, tolerance 0.02 / 0.01)
--
-- ⚠ offset_tol ยังไม่มีค่าจริงจากหน้างาน — ใส่ 0.03 ไว้ทุกแถวเป็นค่าชั่วคราว
--   ต้องแก้ให้ตรงของจริงก่อนใช้ตัดสิน OK/NG (ฝั่ง Pi อ่านค่านี้ไปเทียบ offset
--   ที่ได้จาก GM)
INSERT IGNORE INTO package_size (package_size) VALUES
  ('10x6.5'),
  ('3.05x7.25'),
  ('3.255x3.255'),
  ('3.25x7.40'),
  ('3.5x3.75'),
  ('3.5x3'),
  ('3.5x4.6'),
  ('3x2.5'),
  ('3x3'),
  ('3x4'),
  ('4.25x4.25'),
  ('4.5x5.75'),
  ('4x4'),
  ('4x5'),
  ('5.16x5.16'),
  ('5x5'),
  ('6.55x4.3'),
  ('6x6'),
  ('7x7'),
  ('8x8'),
  ('9x15'),
  ('9x9');

INSERT INTO package_size_tolerance (package_size_id, nominal_x, nominal_y, upper_tol, lower_tol, offset_tol)
SELECT seed.package_size_id, seed.nominal_x, seed.nominal_y, seed.upper_tol, seed.lower_tol, seed.offset_tol
FROM (
    SELECT (SELECT package_size_id FROM package_size WHERE package_size='10x6.5') AS package_size_id, 10.03 AS nominal_x, 6.53 AS nominal_y, 0.02 AS upper_tol, 0.01 AS lower_tol, 0.03 AS offset_tol UNION ALL
    SELECT (SELECT package_size_id FROM package_size WHERE package_size='3.05x7.25') AS package_size_id, 3.08 AS nominal_x, 7.28 AS nominal_y, 0.02 AS upper_tol, 0.01 AS lower_tol, 0.03 AS offset_tol UNION ALL
    SELECT (SELECT package_size_id FROM package_size WHERE package_size='3.255x3.255') AS package_size_id, 3.285 AS nominal_x, 3.285 AS nominal_y, 0.02 AS upper_tol, 0.01 AS lower_tol, 0.03 AS offset_tol UNION ALL
    SELECT (SELECT package_size_id FROM package_size WHERE package_size='3.25x7.40') AS package_size_id, 3.28 AS nominal_x, 7.43 AS nominal_y, 0.02 AS upper_tol, 0.01 AS lower_tol, 0.03 AS offset_tol UNION ALL
    SELECT (SELECT package_size_id FROM package_size WHERE package_size='3.5x3.75') AS package_size_id, 3.53 AS nominal_x, 3.78 AS nominal_y, 0.02 AS upper_tol, 0.01 AS lower_tol, 0.03 AS offset_tol UNION ALL
    SELECT (SELECT package_size_id FROM package_size WHERE package_size='3.5x3') AS package_size_id, 3.53 AS nominal_x, 3.03 AS nominal_y, 0.02 AS upper_tol, 0.01 AS lower_tol, 0.03 AS offset_tol UNION ALL
    SELECT (SELECT package_size_id FROM package_size WHERE package_size='3.5x4.6') AS package_size_id, 3.53 AS nominal_x, 4.63 AS nominal_y, 0.02 AS upper_tol, 0.01 AS lower_tol, 0.03 AS offset_tol UNION ALL
    SELECT (SELECT package_size_id FROM package_size WHERE package_size='3x2.5') AS package_size_id, 3.03 AS nominal_x, 2.53 AS nominal_y, 0.02 AS upper_tol, 0.01 AS lower_tol, 0.03 AS offset_tol UNION ALL
    SELECT (SELECT package_size_id FROM package_size WHERE package_size='3x3') AS package_size_id, 3.03 AS nominal_x, 3.02 AS nominal_y, 0.02 AS upper_tol, 0.01 AS lower_tol, 0.03 AS offset_tol UNION ALL
    SELECT (SELECT package_size_id FROM package_size WHERE package_size='3x4') AS package_size_id, 3.03 AS nominal_x, 4.03 AS nominal_y, 0.02 AS upper_tol, 0.01 AS lower_tol, 0.03 AS offset_tol UNION ALL
    SELECT (SELECT package_size_id FROM package_size WHERE package_size='4.25x4.25') AS package_size_id, 4.28 AS nominal_x, 4.28 AS nominal_y, 0.02 AS upper_tol, 0.01 AS lower_tol, 0.03 AS offset_tol UNION ALL
    SELECT (SELECT package_size_id FROM package_size WHERE package_size='4.5x5.75') AS package_size_id, 4.53 AS nominal_x, 5.78 AS nominal_y, 0.02 AS upper_tol, 0.01 AS lower_tol, 0.03 AS offset_tol UNION ALL
    SELECT (SELECT package_size_id FROM package_size WHERE package_size='4x4') AS package_size_id, 4.03 AS nominal_x, 4.03 AS nominal_y, 0.02 AS upper_tol, 0.01 AS lower_tol, 0.03 AS offset_tol UNION ALL
    SELECT (SELECT package_size_id FROM package_size WHERE package_size='4x5') AS package_size_id, 4.03 AS nominal_x, 5.03 AS nominal_y, 0.02 AS upper_tol, 0.01 AS lower_tol, 0.03 AS offset_tol UNION ALL
    SELECT (SELECT package_size_id FROM package_size WHERE package_size='5.16x5.16') AS package_size_id, 5.19 AS nominal_x, 5.19 AS nominal_y, 0.02 AS upper_tol, 0.01 AS lower_tol, 0.03 AS offset_tol UNION ALL
    SELECT (SELECT package_size_id FROM package_size WHERE package_size='5x5') AS package_size_id, 5.03 AS nominal_x, 5.03 AS nominal_y, 0.02 AS upper_tol, 0.01 AS lower_tol, 0.03 AS offset_tol UNION ALL
    SELECT (SELECT package_size_id FROM package_size WHERE package_size='6.55x4.3') AS package_size_id, 6.58 AS nominal_x, 4.33 AS nominal_y, 0.02 AS upper_tol, 0.01 AS lower_tol, 0.03 AS offset_tol UNION ALL
    SELECT (SELECT package_size_id FROM package_size WHERE package_size='6x6') AS package_size_id, 6.03 AS nominal_x, 6.03 AS nominal_y, 0.02 AS upper_tol, 0.01 AS lower_tol, 0.03 AS offset_tol UNION ALL
    SELECT (SELECT package_size_id FROM package_size WHERE package_size='7x7') AS package_size_id, 7.03 AS nominal_x, 7.03 AS nominal_y, 0.02 AS upper_tol, 0.01 AS lower_tol, 0.03 AS offset_tol UNION ALL
    SELECT (SELECT package_size_id FROM package_size WHERE package_size='8x8') AS package_size_id, 8.03 AS nominal_x, 8.03 AS nominal_y, 0.02 AS upper_tol, 0.01 AS lower_tol, 0.03 AS offset_tol UNION ALL
    SELECT (SELECT package_size_id FROM package_size WHERE package_size='9x15') AS package_size_id, 9.03 AS nominal_x, 15.03 AS nominal_y, 0.02 AS upper_tol, 0.01 AS lower_tol, 0.03 AS offset_tol UNION ALL
    SELECT (SELECT package_size_id FROM package_size WHERE package_size='9x9') AS package_size_id, 9.03 AS nominal_x, 9.03 AS nominal_y, 0.02 AS upper_tol, 0.01 AS lower_tol, 0.03 AS offset_tol
) seed
WHERE NOT EXISTS (SELECT 1 FROM package_size_tolerance existing WHERE existing.package_size_id = seed.package_size_id);

-- ── Export template (ค่าเริ่มต้นของหน้า Export) ───────────────────────────
-- is_default = 1 → หน้าเว็บจะล็อกไม่ให้แก้/ลบ (Duplicate ได้อย่างเดียว)
-- ลำดับใน array คือลำดับคอลัมน์ที่จะออกในไฟล์ CSV
INSERT IGNORE INTO export_template (name, kind, columns_json, is_default) VALUES
  ('Default - All Column', 'csv',
   '["number_alpl","value_x","value_y","result","note","operator","measure_type","timestamp","part_number","handler","package_size","template_name","nominal_x","nominal_y","upper_tol","lower_tol","vendor","owner","po_number","description","recieve_date"]',
   1);

-- ── Part Number ──────────────────────────────────────────────────────────
-- package_size_id / handler_id หาให้อัตโนมัติผ่าน subquery จับคู่ชื่อ
-- offset_tol เป็น NOT NULL เหมือนกัน (ดู init.sql) — ยังไม่มีค่าจริงจากหน้างาน
-- ใส่ 0.03 ไว้ทุกแถวเป็นค่าชั่วคราวเช่นเดียวกับ package_size
-- ⚠ ไม่มี nominal/tolerance แล้ว — part_number เก็บแค่ ชื่อ + package_size + handler
--   เกณฑ์ตัดสินทั้งหมดอยู่ที่ตาราง package_size ทุกโหมด (ดู _load_criteria)
INSERT IGNORE INTO part_number (part_number_name, package_size_id, handler_id) VALUES
  ('TL1400HT-0501-P-A', (SELECT package_size_id FROM package_size WHERE package_size='3.25x7.40'), (SELECT handler_id FROM handler WHERE handler_name='HT9046')),
  ('TL775HT-0501-P-A',  (SELECT package_size_id FROM package_size WHERE package_size='3.5x3.75'),  (SELECT handler_id FROM handler WHERE handler_name='HT9046')),
  ('TL805HT-0500-F-A',  (SELECT package_size_id FROM package_size WHERE package_size='3.5x3.75'),  (SELECT handler_id FROM handler WHERE handler_name='HT9046')),
  ('TL1010HT-0501-P-A', (SELECT package_size_id FROM package_size WHERE package_size='3x3'),       (SELECT handler_id FROM handler WHERE handler_name='HT9046')),
  ('TL722HT-0501-P-A',  (SELECT package_size_id FROM package_size WHERE package_size='3x3'),       (SELECT handler_id FROM handler WHERE handler_name='HT9046')),
  ('TL733HT-0501-P-A',  (SELECT package_size_id FROM package_size WHERE package_size='3x3'),       (SELECT handler_id FROM handler WHERE handler_name='HT9046')),
  ('TL1009HT-0501-P-A', (SELECT package_size_id FROM package_size WHERE package_size='3x3'),       (SELECT handler_id FROM handler WHERE handler_name='HT9046MX')),
  ('TL774HT-0501-P-A',  (SELECT package_size_id FROM package_size WHERE package_size='3x3'),       (SELECT handler_id FROM handler WHERE handler_name='HT9046MX')),
  ('TL391HT-0501-P-A1', (SELECT package_size_id FROM package_size WHERE package_size='3x3'),       (SELECT handler_id FROM handler WHERE handler_name='HT9046MX')),
  ('TL1384HT-0501-P-A', (SELECT package_size_id FROM package_size WHERE package_size='3x4'),       (SELECT handler_id FROM handler WHERE handler_name='HT9046')),
  ('TL776HT-0501-P-A',  (SELECT package_size_id FROM package_size WHERE package_size='4x4'),       (SELECT handler_id FROM handler WHERE handler_name='HT9046')),
  ('TL777HT-0501-P-A',  (SELECT package_size_id FROM package_size WHERE package_size='4x4'),       (SELECT handler_id FROM handler WHERE handler_name='HT9046')),
  ('TL370HT-0501-P-A1', (SELECT package_size_id FROM package_size WHERE package_size='4x4'),       (SELECT handler_id FROM handler WHERE handler_name='HT9046MX')),
  ('TL778HT-0501-P-A',  (SELECT package_size_id FROM package_size WHERE package_size='5x5'),       (SELECT handler_id FROM handler WHERE handler_name='HT9046')),
  ('TL779HT-0501-P-A',  (SELECT package_size_id FROM package_size WHERE package_size='5x5'),       (SELECT handler_id FROM handler WHERE handler_name='HT9046')),
  ('TL1449HT-0501-P-A', (SELECT package_size_id FROM package_size WHERE package_size='5x5'),       (SELECT handler_id FROM handler WHERE handler_name='HT9046MX')),
  ('TL371HT-0501-P-A1', (SELECT package_size_id FROM package_size WHERE package_size='5x5'),       (SELECT handler_id FROM handler WHERE handler_name='HT9046MX')),
  ('TL781HT-0501-P-A',  (SELECT package_size_id FROM package_size WHERE package_size='7x7'),       (SELECT handler_id FROM handler WHERE handler_name='HT9046')),
  ('TL1551HT-0501-P-A', (SELECT package_size_id FROM package_size WHERE package_size='7x7'),       (SELECT handler_id FROM handler WHERE handler_name='HT9046MX')),
  ('TL392HT-0501-P-A1', (SELECT package_size_id FROM package_size WHERE package_size='7x7'),       (SELECT handler_id FROM handler WHERE handler_name='HT9046MX')),
  ('TL392HT-0501-P-B',  (SELECT package_size_id FROM package_size WHERE package_size='7x7'),       (SELECT handler_id FROM handler WHERE handler_name='HT9046MX')),
  ('TL782HT-0501-P-B',  (SELECT package_size_id FROM package_size WHERE package_size='8x8'),       (SELECT handler_id FROM handler WHERE handler_name='HT9046')),
  ('TL783HT-0501-P-A1', (SELECT package_size_id FROM package_size WHERE package_size='8x8'),       (SELECT handler_id FROM handler WHERE handler_name='HT9046')),
  ('TL393HT-0501-P-B1', (SELECT package_size_id FROM package_size WHERE package_size='8x8'),       (SELECT handler_id FROM handler WHERE handler_name='HT9046MX')),
  ('TL1383HT-0501-P-A', (SELECT package_size_id FROM package_size WHERE package_size='9x9'),       (SELECT handler_id FROM handler WHERE handler_name='HT9046')),
  ('TL784HT-0501-P-A1', (SELECT package_size_id FROM package_size WHERE package_size='9x9'),       (SELECT handler_id FROM handler WHERE handler_name='HT9046')),
  ('TL754HT-0501-P-A',  (SELECT package_size_id FROM package_size WHERE package_size='9x9'),       (SELECT handler_id FROM handler WHERE handler_name='HT9046MX'));

-- ── Package Size + Handler → Template ───────────────────────────────────
-- 1 แถว = 1 คู่ขนาด/เครื่อง และโปรแกรม TM-X ของคู่นั้น
--
-- Seed ตั้งต้นดึงมาจากข้อมูลที่มีอยู่จริงในบล็อก part_number ข้างบน — part_number
-- ทุกตัวบอกอยู่แล้วว่า "ขนาดนี้ ใช้เครื่องนี้" เอาคู่ที่ไม่ซ้ำมาใส่ตรงๆ ได้เลย
-- ดีกว่าไล่พิมพ์เองทีละแถวเพราะไม่มีทางตกหล่นและไม่ต้องแก้ตามเวลามี part ใหม่
--
-- ⚠ ผลลัพธ์คือ "คู่ที่เคยมี part ใช้จริง" ไม่ใช่ "คู่ที่ลงได้ทางกายภาพทั้งหมด"
--   ขนาดที่ยังไม่มี part_number ตัวไหนอ้างถึงจะไม่มีแถวเลย → dropdown Handler
--   ของขนาดนั้นจะว่าง ต้องไปเติมเองที่หน้า Edit เมื่อรู้ของจริงจากหน้างาน
INSERT IGNORE INTO package_size_handler_template (package_size_id, handler_id, template_id)
SELECT DISTINCT pn.package_size_id, pn.handler_id, t.template_id
FROM part_number pn
JOIN template t ON t.template_name = '201';
