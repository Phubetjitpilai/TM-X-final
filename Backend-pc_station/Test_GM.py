import socket
import time
TMX_IP = "192.168.10.11"
TMX_PORT = 8600
BUFFER_SIZE = 1024
client_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
client_socket.settimeout(5.0)
client_socket.connect((TMX_IP, TMX_PORT))
SOCKET_TIMEOUT   = 5
def send_recv(sock, command, timeout=SOCKET_TIMEOUT):
    """ส่ง 1 คำสั่ง แล้ว **วน recv จนเจอ CR** — คืน (response, ok)
    """
    sock.settimeout(timeout)
    deadline = time.time() + timeout
    sock.sendall((command + "\r").encode("ascii"))

    buf = b""
    while b"\r" not in buf:
        remain = deadline - time.time()
        if remain <= 0:
            return "<timeout>", False
        sock.settimeout(remain)
        try:
            chunk = sock.recv(BUFFER_SIZE)
        except socket.timeout:
            return "<timeout>", False
        if not chunk:                       # อีกฝั่งปิด connection
            return "<closed>", False
        buf += chunk

    resp = buf.decode("ascii", "replace").strip()
    return resp, not resp.upper().startswith("ER")

sock= client_socket
send_recv(sock, "GM,3,0", timeout=2.0)
resp, ok = send_recv(sock, "GM,3,0", timeout=2.0)
print(resp)