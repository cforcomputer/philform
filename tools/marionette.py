"""Minimal client for Firefox's automation protocol (Marionette): length-prefixed JSON.

Shared by the browser test and the live-form diagnostic.
"""
import json, socket, time


class Marionette:
    """Minimal client for Firefox's automation protocol: length-prefixed JSON."""

    def __init__(self, port):
        for _ in range(60):
            try:
                self.sock = socket.create_connection(('127.0.0.1', port), timeout=10)
                break
            except OSError:
                time.sleep(1)
        else:
            raise RuntimeError('Firefox never opened its automation port')
        self.sock.settimeout(90)
        self.buf = b''
        self.seq = 0
        self._recv()

    def _recv(self):
        while True:
            i = self.buf.find(b':')
            if i > 0:
                n = int(self.buf[:i])
                if len(self.buf) >= i + 1 + n:
                    body = self.buf[i + 1:i + 1 + n]
                    self.buf = self.buf[i + 1 + n:]
                    return json.loads(body)
            chunk = self.sock.recv(65536)
            if not chunk:
                raise EOFError('Firefox closed the connection')
            self.buf += chunk

    def send(self, name, params=None):
        self.seq += 1
        raw = json.dumps([0, self.seq, name, params or {}]).encode()
        self.sock.sendall(str(len(raw)).encode() + b':' + raw)
        while True:
            msg = self._recv()
            if isinstance(msg, list) and len(msg) >= 4 and msg[1] == self.seq:
                if msg[2]:
                    raise RuntimeError(f'{name}: {json.dumps(msg[2])[:300]}')
                return msg[3]
