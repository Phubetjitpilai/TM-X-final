rounds = 0
result = "OK"          # ← ① ต้องมี กัน NameError รอบแรก
ok = False
while True:
    if ok:
        if result != "UNKNOWN":
            print("Everything ok")
            break
    else:
        rounds += 1
    if not ok:
        print("T1 error")
        break
    elif result == "UNKNOWN":                   # ← ② else ไม่ใช่ if — รอบนึงถามครั้งเดียว
        print("GM error")
        break