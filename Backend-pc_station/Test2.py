
result = "UNKNOWN"          # ← ① ต้องมี กัน NameError รอบแรก
ok = False
while True:
    if ok:
        if result != "UNKNOWN":
            print("everything ok")
            break
    else:
        result = "UNKNOWN"  # ← T1 ไม่ผ่าน = ยังไม่มีค่าของชิ้นนี้
    if not ok:
            print("not ok")
            break
    else:                   # ← ② else ไม่ใช่ if — รอบนึงถามครั้งเดียว
            print("gm error")
            break