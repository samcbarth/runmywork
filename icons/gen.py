#!/usr/bin/env python3
"""Generate PNG icons for RunMyWork PWA. No external dependencies."""
import struct, zlib, os

def make_png(w, h, pixels):
    def chunk(t, d=b''):
        crc = zlib.crc32(t + d) & 0xffffffff
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', crc)
    ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
    raw = b''.join(
        b'\x00' + b''.join(struct.pack('BBB', r, g, b) for r, g, b in pixels[y*w:(y+1)*w])
        for y in range(h)
    )
    idat = chunk(b'IDAT', zlib.compress(raw, 9))
    return b'\x89PNG\r\n\x1a\n' + ihdr + idat + chunk(b'IEND')

def in_tri(px, py, v1, v2, v3):
    def side(ax, ay, bx, by, cx, cy):
        return (bx-ax)*(cy-ay) - (by-ay)*(cx-ax)
    d1 = side(*v1, *v2, px, py)
    d2 = side(*v2, *v3, px, py)
    d3 = side(*v3, *v1, px, py)
    return not ((d1<0 or d2<0 or d3<0) and (d1>0 or d2>0 or d3>0))

def icon(size, pad_frac=0.08):
    BG   = (15, 23, 42)
    BLUE = (59, 130, 246)
    p = int(size * pad_frac)
    cw = size - 2*p
    # Triangle vertices (in pixel space within content area)
    v1 = (p + int(cw*0.20), p + int(cw*0.15))
    v2 = (p + int(cw*0.20), p + int(cw*0.85))
    v3 = (p + int(cw*0.82), p + int(cw*0.50))
    pixels = []
    for row in range(size):
        for col in range(size):
            pixels.append(BLUE if in_tri(col, row, v1, v2, v3) else BG)
    return pixels

os.chdir(os.path.dirname(os.path.abspath(__file__)))

for sz in [192, 512]:
    data = make_png(sz, sz, icon(sz))
    with open(f'icon-{sz}.png', 'wb') as f: f.write(data)
    print(f'icon-{sz}.png')

data = make_png(512, 512, icon(512, pad_frac=0.12))
with open('icon-maskable-512.png', 'wb') as f: f.write(data)
print('icon-maskable-512.png')
