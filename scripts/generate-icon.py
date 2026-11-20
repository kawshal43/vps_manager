"""Generate the code-native server mark as Windows PNG/ICO resources (stdlib only)."""
import math
from pathlib import Path
import struct
import zlib

OUT = Path(__file__).resolve().parents[1] / 'resources'
OUT.mkdir(exist_ok=True)

def rounded(x, y, left, top, right, bottom, radius):
    cx = max(left + radius, min(x, right - radius))
    cy = max(top + radius, min(y, bottom - radius))
    return math.hypot(x - cx, y - cy) <= radius

def pixel(x, y):
    if not rounded(x, y, 4, 4, 252, 252, 49):
        return (0, 0, 0, 0)
    for top in (60, 137):
        outer = rounded(x, y, 51, top, 205, top + 59, 12)
        inner = rounded(x, y, 59, top + 8, 197, top + 51, 5)
        if outer and not inner or math.hypot(x - 77, y - (top + 29.5)) <= 5 or 169 <= x <= 181 and top + 26 <= y <= top + 33:
            return (255, 255, 255, 255)
    return (37, 99, 235, 255)

def png(size):
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            samples = [pixel((x + dx / 2 + .25) * 256 / size, (y + dy / 2 + .25) * 256 / size) for dx in range(2) for dy in range(2)]
            for channel in range(4):
                rows.append(round(sum(p[channel] for p in samples) / 4))
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>2I5B', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')

images = [(s, png(s)) for s in (16, 32, 48, 64, 128, 256)]
offset = 6 + 16 * len(images)
header = struct.pack('<3H', 0, 1, len(images))
payload = b''
for size, data in images:
    header += struct.pack('<4B2H2I', size % 256, size % 256, 0, 0, 1, 32, len(data), offset)
    payload += data
    offset += len(data)
(OUT / 'icon.ico').write_bytes(header + payload)
(OUT / 'icon.png').write_bytes(images[-1][1])
(OUT / 'icon.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect x="4" y="4" width="248" height="248" rx="49" fill="#2563eb"/><g fill="none" stroke="white" stroke-width="8"><rect x="55" y="64" width="146" height="51" rx="9"/><rect x="55" y="141" width="146" height="51" rx="9"/></g><g fill="white"><circle cx="77" cy="90" r="5"/><circle cx="77" cy="167" r="5"/><path d="M169 86h12v8h-12zM169 163h12v8h-12z"/></g></svg>')
print('Generated Windows application icon.')
