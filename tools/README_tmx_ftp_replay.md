# ทดสอบไฟล์ FTP จาก TM-X เมื่อ Session ไม่ Running

ใช้ Python environment เดียวกับที่รัน `Backend-server/Data-receiver.py` เพราะตัวทดสอบแบบแยกต้องใช้ dependency ของ Receiver (`httpx`, `pyftpdlib`, `python-dotenv`, `opencv-python`, `numpy`). รันคำสั่งจาก root ของโปรเจกต์

```powershell
python tools\repro_receiver_pairing.py
```

ตัวทดสอบนี้เปิด Data Receiver จริงบน **FTP port ชั่วคราวที่ localhost** และ Backend จำลอง ไม่แตะ Pi, MySQL หรือ Receiver ที่เปิดอยู่ จึงลองได้ก่อนเริ่ม Session จริง มันจำลอง `.txt` ค่าเก่า `5.011/5.012` ตอน Session หยุด และรูปใหม่พร้อมค่าใหม่ `5.031/5.032` ตอน Session Running โดยลองสองลำดับ:

- `image-first`: รูปใหม่มาก่อน `.txt` ค่าใหม่ ถ้าค่าเก่าถูกเก็บไว้จะได้ `OLD/STALE`; หลังแก้ Receiver ควรแสดง `old .txt while stopped: REJECTED` และ `NEW`
- `txt-first`: `.txt` ค่าใหม่มาก่อนรูป เป็นตัวเทียบ ควรได้ `NEW`

ผลและ log อยู่ใน `output/ftp_replay_offline/` คำสั่ง `--order image-first --txt-delay 2` ใช้เพิ่มช่วงเวลารอ `.txt` ค่าใหม่เป็น 2 วินาที

ถ้าต้องการยิงเข้า Receiver/Backend **จริง** ใช้ไฟล์ `tools/replay_tmx_ftp.py` กับ ALPL และ Session สำหรับทดสอบเท่านั้น เพราะขั้น `inside` อาจสร้างหรือแก้ measurement ใน DB จริง:

```powershell
python tools\replay_tmx_ftp.py prepare --case stale01
python tools\replay_tmx_ftp.py outside --case stale01 --host 127.0.0.1
# เริ่ม Session/กด Measure หรือ Remeasure จากเว็บ และรอให้ Pi เปิด capture
python tools\replay_tmx_ftp.py inside --case stale01 --host 127.0.0.1 --write-live-db
```

คำสั่งอ่าน FTP user/password/port และ Backend URL จาก `.env` (หรือ environment) ถ้า Receiver อยู่คนละเครื่อง ให้เปลี่ยน `--host` และ `--backend` ตามเครื่องทดสอบ ผลบรรทัด `DB X/Y=` ใช้เทียบกับค่าเก่าและค่าใหม่ใน case; ถ้าไม่ขึ้น ให้ดู Receiver log และผลในตาราง Measurement ก่อนสรุป
