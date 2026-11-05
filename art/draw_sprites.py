"""Draw native 64px soft-pixel sprites on a stable 32-unit animation rig."""
import struct
import json
import sys
import zlib
import math
from pathlib import Path

KINDS = {
    'anino': ('#30263f', '#71608b', '#b5a0d1', '#d9ffad'),
    'cat': ('#59404b', '#eeb376', '#ffe8bc', '#593445'),
    'dog': ('#57404a', '#c9916c', '#f9ddae', '#442d3d'),
    'ghost': ('#514369', '#b4a1df', '#f0e8ff', '#59487b'),
    'sprout': ('#594552', '#e5ad8b', '#ffe0bc', '#4e3949'),
    'robot': ('#394b61', '#87afbf', '#d8f0ef', '#b9ffe1'),
    'bunny': ('#805e70', '#e8b9bc', '#fff3e6', '#563747'),
    'cloud': ('#70658d', '#c6bde6', '#fff6ff', '#61537c'),
    'chicken': ('#68505b', '#f5deb0', '#fff6df', '#4a3040'),
}
MOODS = ('idle', 'eat', 'happy', 'sleep', 'surprised', 'dance', 'stretch', 'headphones', 'run', 'carry', 'crouch', 'pickup', 'pounce', 'hungry', 'tired', 'groove')
SIZE = 32
RASTER_SCALE = 2
RASTER_SIZE = SIZE * RASTER_SCALE
FRAMES = 6


def paint(pixels, x, y, width, height, color, radius=0):
    """Rasterize geometry directly on the finer grid, without resampling."""
    rgba = bytes.fromhex(color.lstrip('#'))
    if len(rgba) == 3:
        rgba += b'\xff'
    left, top = round(x * RASTER_SCALE), round(y * RASTER_SCALE)
    right, bottom = round((x + width) * RASTER_SCALE), round((y + height) * RASTER_SCALE)
    r = min(round(radius * RASTER_SCALE), (right - left) // 2, (bottom - top) // 2)
    for py in range(max(0, top), min(RASTER_SIZE, bottom)):
        inset = 0
        if r > 0:
            dy = max(top + r - py - .5, py + .5 - (bottom - r), 0)
            inset = round(r - math.sqrt(max(0, r * r - dy * dy)))
        for px in range(max(0, left + inset), min(RASTER_SIZE, right - inset)):
            at = (py * RASTER_SIZE + px) * 4
            pixels[at:at + 4] = rgba


def ellipse(pixels, cx, cy, rx, ry, color):
    # Half-unit samples let ears, cheeks and puffs use smaller pixel steps.
    for py in range(round((cy - ry) * RASTER_SCALE), round((cy + ry + 1) * RASTER_SCALE)):
        for px in range(round((cx - rx) * RASTER_SCALE), round((cx + rx + 1) * RASTER_SCALE)):
            dx, dy = (px + .5) / RASTER_SCALE - cx - .5, (py + .5) / RASTER_SCALE - cy - .5
            if dx * dx / ((rx + .5) ** 2) + dy * dy / ((ry + .5) ** 2) <= 1:
                paint(pixels, px / RASTER_SCALE, py / RASTER_SCALE, .5, .5, color)


def finish(pixels, kind, mood, anchors):
    """Small clean highlight clusters, with no noise, blur or dithering."""
    ink, body, light, eye = (bytes.fromhex(color[1:]) for color in KINDS[kind])
    # Tiny material details share the rig's anchors, so they travel with the
    # head and torso instead of flickering in place during an animation.
    hx, hy, cx, cy, _, _ = anchors
    base = bytes(pixels)

    def detail(x, y, width, height, color, materials=(body, light)):
        rgba = bytes.fromhex(color[1:]) + b'\xff'
        for py in range(max(0, round(y * 2)), min(RASTER_SIZE, round((y + height) * 2))):
            for px in range(max(0, round(x * 2)), min(RASTER_SIZE, round((x + width) * 2))):
                offset = (py * RASTER_SIZE + px) * 4
                if base[offset + 3] == 255 and base[offset:offset + 3] in materials:
                    pixels[offset:offset + 4] = rgba

    if kind in ('cat', 'dog', 'bunny', 'chicken'):
        detail(hx - 5, hy + 2, 2, .5, '#fff0d4')
        detail(hx - 5.5, hy + 2.5, 1, .5, '#fff0d4')
        detail(cx - 2.5, cy + 1, 1, .5, '#fff4df')
        detail(cx + 1, cy + 1.5, 1, .5, '#fff4df')
        if mood not in ('run', 'carry', 'crouch', 'pickup', 'pounce'):
            detail(hx - 7, hy + 8, 2.5, .5, '#edaaa2')
            detail(hx + 6, hy + 8, 2.5, .5, '#edaaa2')
    elif kind == 'anino':
        detail(hx - 5, hy + 2, 2, .5, '#c0a8da')
        detail(hx - 6, hy + 2.5, 1, 1, '#a78bc6')
        detail(cx - 3, cy + 1, 1, 1, '#cdb4e3')
        detail(cx - 1.5, cy + 1.5, 1, .5, '#cdb4e3')
    elif kind == 'robot':
        detail(hx - 7, hy + 2, .5, 3, '#e5fffa')
        detail(cx - 4, cy + 1, 1.5, .5, '#d5f4f0')
        detail(cx + 4, cy + 1, 1, 1, '#587d94')
    elif kind == 'sprout':
        detail(hx - 5, hy + 2, 2.5, .5, '#fff3d8')
        detail(cx + 3, cy + 2, .5, 2, '#c6816b')
        detail(cx + 4, cy + 2.5, .5, 1, '#c6816b')
    else:
        detail(hx - 5, hy + 3, 2.5, .5, '#fff9ff')
        detail(hx - 6, hy + 3.5, 1, .5, '#fff9ff')
        detail(cx + 5, cy + 1, 1.5, .5, '#cdbbe8')
    original = bytes(pixels)
    for py in range(RASTER_SIZE):
        for px in range(RASTER_SIZE):
            at = (py * RASTER_SIZE + px) * 4
            rgb = original[at:at + 3]
            if original[at + 3] != 255 or rgb not in (body, light):
                continue
            # Three broad material tones keep the surface quiet at desktop size.
            lift = 7 if py < 27 else 2 if py < 40 else -7
            above = original[at - RASTER_SIZE * 4:at - RASTER_SIZE * 4 + 3] if py else b''
            left = original[at - 4:at - 1] if px else b''
            if py < 42 and (above == ink or left == ink):
                lift += 10
            pixels[at:at + 3] = bytes(max(0, min(255, channel + lift)) for channel in rgb)
    # One finer pixel of reflected light per open eye. Closed eyes stay clean.
    visited = set()
    for py in range(RASTER_SIZE):
        for px in range(RASTER_SIZE):
            if (px, py) in visited:
                continue
            at = (py * RASTER_SIZE + px) * 4
            if original[at:at + 3] != eye or original[at + 3] != 255:
                continue
            component, queue = [], [(px, py)]
            visited.add((px, py))
            while queue:
                qx, qy = queue.pop()
                component.append((qx, qy))
                for nx, ny in ((qx - 1, qy), (qx + 1, qy), (qx, qy - 1), (qx, qy + 1)):
                    if not (0 <= nx < RASTER_SIZE and 0 <= ny < RASTER_SIZE) or (nx, ny) in visited:
                        continue
                    offset = (ny * RASTER_SIZE + nx) * 4
                    if original[offset:offset + 3] == eye and original[offset + 3] == 255:
                        visited.add((nx, ny))
                        queue.append((nx, ny))
            if max(y for _, y in component) - min(y for _, y in component) >= 3 and len(component) <= 80:
                gx, gy = min(component, key=lambda point: (point[1], point[0]))
                paint(pixels, gx / 2, gy / 2, .5, .5, '#fff6e8')
    return pixels

def draw(kind, mood, f, blink_now=False, anchors=None):
    if kind in ('ghost', 'sprout', 'robot', 'bunny', 'cloud'):
        return mascot(kind, mood, f, blink_now, anchors)
    if mood in ('run', 'carry', 'crouch', 'pickup', 'pounce'):
        return profile(kind, mood, f, anchors)
    pixels = bytearray(RASTER_SIZE * RASTER_SIZE * 4)
    dark, fur, light, eyes = KINDS[kind]
    pink, gold, purple = '#ff9cad', '#ffd771', '#bfa0ff'
    hop = [0, 1, 2, 1, 0, 0][f]
    sleeping = mood == 'sleep'
    hungry = mood == 'hungry'
    tired = mood == 'tired'
    music = mood in ('dance', 'headphones', 'groove')
    y = -hop if mood in ('happy', 'surprised') else 2 if sleeping else 0
    if mood == 'stretch':
        y = -[0, 1, 2, 2, 1, 0][f]
    x = 0

    def box(left, top, width, height, color, moving=True):
        if moving:
            left, top = left + x, top + y
        paint(pixels, left, top, width, height, color)

    def blob(left, top, width, height, color):
        paint(pixels, left + x, top + y, width, height, color, radius=2.5)

    def star(left, top, color):
        box(left + 1, top, 1, 3, color)
        box(left, top + 1, 3, 1, color)

    ellipse(pixels, 16, 27.5, 11, .75, '#1a112a45')
    wag = 0 if music or sleeping or tired else [0, -1, -2, -1, 0, 1][f]
    if kind in ('cat', 'anino', 'dog'):
        box(23, 20, 5, 4, dark)
        box(26, 15 + wag, 3, 8 - wag, dark)
        box(26, 17 + wag, 2, 5 - wag, fur)
        if kind == 'cat':
            box(27, 14 + wag, 3, 3, dark)
    if kind == 'chicken':
        box(24, 14 + wag, 4, 7, dark)
        box(25, 15 + wag, 2, 4, light)
        for foot in (11, 21):
            box(foot, 24, 2, 3, '#cb7a51')
            box(foot - 1, 26, 4, 1, '#f5a565')
    else:
        for foot in (8, 20):
            box(foot, 24, 5, 3, dark)
            box(foot + 1, 24, 3, 1, fur)
    if tired:
        y = (1, 1, 2, 2, 2, 1)[f]
    elif hungry and kind == 'chicken':
        y = (0, 0, 1, 2, 1, 0)[f]
    if music:
        # Torso, tail, and feet use fixed screen coordinates in every music frame.
        blob(7, 16, 19, 9, dark)
        blob(8, 17, 17, 7, fur)
        box(11, 22, 11, 2, light)
        if kind == 'chicken':
            box(22, 19, 4, 3, '#d3a574')
            box(23, 19, 2, 1, light)
        if mood in ('dance', 'groove'):
            head_offsets = {
                'anino': ((0, 0), (0, 1), (0, 2), (0, 1), (0, 0), (0, -1)),
                'cat': ((-1, 0), (-1, 1), (0, 1), (1, 0), (1, 1), (0, 1)),
                'dog': ((0, 0), (0, 1), (0, 2), (0, 2), (0, 1), (0, 0)),
                'chicken': ((0, 0), (1, 1), (2, 1), (1, 0), (0, 0), (-1, 0)),
            }
            x, y = head_offsets[kind][f]
            if mood == 'groove':
                x += (0, -1, -1, 0, 1, 1)[f]
                y -= (0, 1, 2, 1, 0, 0)[f]
        blob(6, 8, 20, 13, dark)
        blob(7, 9, 18, 11, fur)
    else:
        blob(6, 11 if sleeping else 9, 20, 16, dark)
        blob(7, 12 if sleeping else 10, 18, 13, fur)
        box(10, 21, 12, 3, light)
    if kind in ('cat', 'anino'):
        for ear in (7, 21):
            box(ear, 4, 4, 8, dark)
            box(ear + (1 if ear == 7 else -1), 7, 4, 4, dark)
            box(ear + 1, 6, 2, 4, pink if kind == 'cat' else light)
        if kind == 'cat':
            for stripe in (13, 16, 19):
                box(stripe, 10, 1, 3 if stripe == 16 else 2, '#b96650')
    elif kind == 'dog':
        for ear in (4, 23):
            droop = 2 if tired else f % 2 if mood == 'dance' else 0
            blob(ear, 9 + droop, 5, 11, dark)
            box(ear + 1, 11 + droop, 3, 6, '#80504a')
        box(15, 11, 3, 8, light)
        blob(11, 16 if music else 17, 10, 5 if music else 6, light)
    else:
        crest = -1 if mood in ('dance', 'happy') and f % 2 else 0
        box(12, 6 + crest, 10, 5, '#9c4051')
        box(14, 4 + crest, 3, 5, '#e65c64')
        box(18, 5 + crest, 3, 4, '#f27369')
        if not music:
            wing = hop if mood == 'happy' else 0
            box(22, 18 - wing, 4, 4, '#d3a574')
            box(23, 18 - wing, 3, 2, light)
    if hungry:
        # Each species asks for food differently.
        for eye in (10, 20):
            if kind == 'cat':
                box(eye, 14, 3, 4, eyes)
                box(eye + 1, 15, 1, 1, '#fff9dd')
            elif kind == 'dog':
                blob(eye - 1, 13, 5, 6, eyes)
                box(eye, 14, 2, 2, '#fff9dd')
            elif kind == 'chicken':
                box(eye, 14, 2, 3, eyes)
            else:
                box(eye, 15, 4, 2, eyes)
        if kind == 'cat':
            box(14, 19, 4, 2 + (f in (2, 3)), dark)
            box(15, 21, 2, 1, pink)
            box(8, 18, 3, 1, light)
            box(22, 18, 3, 1, light)
        elif kind == 'dog':
            box(14, 18, 4, 2, dark)
            box(15, 20, 2, 2, pink)
            if f in (2, 3, 4):
                box(22, 20, 1, 2, '#89d9e9')
                box(21, 22, 2, 1, '#b7edf2')
        elif kind == 'chicken':
            box(13, 18, 6, 2, '#df8742')
            box(14, 18, 4, 1, gold)
            if f in (2, 3):
                box(15, 20, 2, 2, dark)
        else:
            box(11, 13, 3, 1, light)
            box(19, 13, 3, 1, light)
            box(13, 19, 6, 2, dark)
            box(14, 19, 1, 1, '#fff9dd')
            box(17, 19, 1, 1, '#fff9dd')
        if f < 4:
            box(26, 4, 4, 3, '#f8ca80', False)
            box(27, 4, 2, 1, '#fff0b5', False)
            box(28, 6, 2, 1, '#b96c48', False)
            box(25, 8, 1, 1, '#f8ca80', False)
    elif tired:
        for eye in (10, 20):
            box(eye, 15, 4, 1, eyes)
            if f < 2:
                box(eye + 1, 16, 2, 1, eyes)
            else:
                box(eye + 1, 14, 2, 1, eyes)
        if kind == 'chicken':
            box(13, 18, 6, 2, '#e19549')
            box(14, 19, 4, 1, gold)
        else:
            box(14, 18, 4, 2 + (f in (2, 3)), dark)
            if kind == 'cat' and f in (2, 3):
                box(15, 20, 2, 1, pink)
        if f >= 2:
            z = 6 - (f - 2)
            box(26, z, 3, 1, purple, False)
            box(27, z + 1, 1, 1, purple, False)
            box(26, z + 2, 3, 1, purple, False)
    else:
        blink = sleeping or blink_now or (mood == 'idle' and f == 5)
        for eye in (11, 20):
            eye_y = 16 if sleeping else 14
            box(eye - int(blink), eye_y + int(blink), 4 if blink else 2, 1 if blink else 3, eyes)
            if not blink and kind == 'anino':
                box(eye, eye_y, 1, 1, '#ffffdf')
        for cheek in (9, 22):
            box(cheek, 18, 2, 1, pink)
        mouth = 1 + (f % 2) if mood == 'eat' else 2 if mood == 'surprised' else 1
        box(14, 18, 4, mouth, '#e79b48' if kind == 'chicken' else dark)
        if kind == 'chicken':
            box(15, 18, 2, 1, gold)
        elif kind == 'cat':
            box(6, 18, 3, 1, light)
            box(23, 18, 3, 1, light)
    if music:
        box(10, 6, 12, 2, purple)
        for side in (6, 23):
            box(side + 1, 8, 2, 6, purple)
            blob(side, 13, 4, 7, '#7857a2')
            box(side + 1, 14, 2, 5, purple)
        if mood in ('dance', 'groove'):
            note_x = 27 if f < 3 else 3
            note_y = 8 - f % 3
            box(note_x, note_y, 1, 4, gold, False)
            box(note_x, note_y, 3, 1, gold, False)
            box(note_x - 1, note_y + 3, 2, 2, gold, False)
    if mood == 'groove' and f % 2 == 0:
        star(1, 12, pink)
        star(28, 3, gold)
    if mood == 'fidget':
        gesture = (0, 1, 2, 2, 1, 0)[f]
        if kind == 'cat':
            blob(7 + gesture, 21 - gesture, 5, 5, dark)
            box(8 + gesture, 22 - gesture, 3, 2, light)
        elif kind == 'dog':
            box(15, 20, 2, 1 + gesture, pink)
            box(25, 9 - gesture, 2, 2, light)
        elif kind == 'chicken':
            box(14, 20 + gesture, 3, 1, gold)
            box(12 + gesture, 24 - gesture, 1, 1, '#fff5dc')
        else:
            star(2 + f % 3, 11 - gesture, purple)
            star(27, 8 + gesture, gold)
    if mood == 'look':
        shift = (-2, -2, -1, 1, 2, 0)[f]
        box(10, 14, 15, 4, fur)
        for eye in (11, 20):
            box(eye + shift, 14, 2, 3, eyes)
        if kind == 'dog':
            box(15, 15, 2, 3, light)
    if sleeping:
        z = 5 - f % 3
        box(24, z, 3, 1, purple)
        box(25, z + 1, 1, 1, purple)
        box(24, z + 2, 3, 1, purple)
    if mood == 'eat':
        box(15 - f % 2, 22, 5, 3, '#ba704d')
        box(16 - f % 2, 22, 2, 1, gold)
        box(21, 21 - f % 3, 1, 1, gold)
    if mood in ('happy', 'surprised') and f % 2 == 0:
        star(3, 7, pink if mood == 'happy' else gold)
        star(25, 6, gold)
    if anchors is not None:
        head_y = (11 if sleeping else 8 if music else 9) + y
        anchors.extend((16 + x, head_y, 16, 21 if music else 21 + y, 8 + x, head_y + 1))
    return pixels

def profile(kind, mood, frame, anchors=None):
    """Draw a side profile facing left, with a six-frame foot cycle."""
    pixels = bytearray(RASTER_SIZE * RASTER_SIZE * 4)
    dark, fur, light, eye = KINDS[kind]
    low = mood in ('crouch', 'pickup')
    running = mood in ('run', 'carry')
    lunge = mood == 'pounce'
    bob = (0, -1, -1, 0, -1, -1)[frame] if running else 1

    def rect(x, y, w, h, color):
        paint(pixels, x, y, w, h, color)

    def body(x, y, w, h, color):
        paint(pixels, x, y, w, h, color, radius=2)

    ellipse(pixels, 16, 27.5, 11, .75, '#1a112a45')
    step = (0, -4, -2, 0, 4, 2)[frame] if running else -4 if lunge else 0
    dip = (0, 1, 3, 3, 2, 0)[frame] if mood == 'pickup' else 0
    if kind == 'chicken':
        for x, shift in ((12, step), (20, -step)):
            rect(x + shift, 22, 2, 5, '#a96649')
            rect(x + shift - 2, 26, 4, 1, '#e69b55')
        body(11, 12 + bob, 14, 12, dark)
        body(12, 13 + bob, 12, 10, fur)
        body(15, 16 + bob, 8, 5, '#e3bb86')
        rect(23, 11 + bob, 4, 4, light)
        head = bob + dip
        body(5, 9 + head, 12, 10, dark)
        body(6, 10 + head, 10, 8, light)
        rect(7, 7 + head, 7, 3, '#d95362')
        rect(8, 6 + head, 2, 3, '#f4776d')
        rect(3, 14 + head, 4, 2, '#e59a48')
        rect(8, 12 + head, 2, 2, eye)
    else:
        for x, shift in ((10, step), (21, -step)):
            rect(x + shift, 22, 3, 5, dark)
            rect(x + shift - 1, 25, 4, 2, dark)
        body(9, (16 if low else 13) + bob, 17, 10 if low else 12, dark)
        body(10, (17 if low else 14) + bob, 15, 8 if low else 10, fur)
        rect(13, 21 + bob, 9, 2, light)
        tail = (0, 1, 0, -1, 0, 1)[frame] if running else 0
        rect(24, 15, 4, 3, dark)
        rect(27, 10 + tail, 3, 7 - tail, dark)
        rect(27, 11 + tail, 2, 4 - tail, fur)
        y = (12 if low else 9) + bob + dip - (1 if mood == 'carry' else 0)
        body(5, y, 13, 12, dark)
        body(6, y + 1, 11, 10, fur)
        if kind == 'dog':
            ear = 1 if running and frame in (1, 2, 4) else 0
            body(12 + ear, y + 1, 5, 10, '#80504a')
            body(3, y + 6, 8, 5, light)
            rect(3, y + 6, 3, 2, dark)
        else:
            rect(8, y - 4, 4, 6, dark)
            rect(13, y - 3, 3, 6, dark)
            rect(9, y - 2, 2, 3, '#ff9cad' if kind == 'cat' else light)
            rect(5, y + 8, 6, 1, light)
        rect(8, y + 4, 2, 2, eye)
    if anchors is not None:
        head_y = 9 + head if kind == 'chicken' else y
        head_x = 11 if kind == 'chicken' else 11.5
        chest_x = 18 if kind == 'chicken' else 17.5
        anchors.extend((head_x, head_y, chest_x, 20 + bob, 6, head_y + 1))
    return pixels

def mascot(kind, mood, frame, blink_now=False, anchors=None):
    """Draw three desktop mascots with a shared pose sheet and distinct motion."""
    pixels = bytearray(RASTER_SIZE * RASTER_SIZE * 4)
    ink, shade, glow, eye = KINDS[kind]
    arc = (0, 1, 2, 2, 1, 0)[frame]
    stride = (0, 2, 3, 0, -2, -3)[frame]
    moving = mood in ('run', 'carry')
    profile = mood in ('run', 'carry', 'crouch', 'pickup', 'pounce')
    sleepy = mood in ('sleep', 'tired')
    music = mood in ('headphones', 'dance', 'groove')

    def rect(x, y, w, h, color):
        paint(pixels, x, y, w, h, color)

    def rounded(x, y, w, h, color):
        paint(pixels, x, y, w, h, color, radius=2.5)

    def sparkle(x, y, color):
        rect(x + 1, y, 1, 3, color)
        rect(x, y + 1, 3, 1, color)

    ellipse(pixels, 16, 27.5, 9, .75, '#25193945')
    y = arc if sleepy or mood == 'pickup' else -arc if mood in ('happy', 'pounce', 'surprised') else 0
    face_x = -3 if profile else 0
    face_y = y

    def oval(cx, cy, rx, ry, color):
        ellipse(pixels, cx, cy, rx, ry, color)

    if kind == 'bunny':
        ear = (0, 1, 2, 1, 0, -1)[frame]
        face_y = y + (arc if music else 0)
        for foot, shift in ((11, stride), (21, -stride)):
            oval(foot + (shift if moving else 0), 24, 4, 2, ink)
            oval(foot + (shift if moving else 0), 24, 3, 1, glow)
        oval(16, 21, 8, 4, ink)
        oval(16, 20, 7, 4, shade)
        oval(25, 20, 4, 4, ink)
        oval(25, 19, 3, 3, glow)
        oval(11, 7 + face_y, 3, 6, ink)
        oval(11, 7 + face_y, 2, 5, glow)
        oval(11, 6 + face_y, 1, 3, '#ef9eaf')
        oval(20, 7 + face_y + ear, 3, 5, ink)
        oval(20, 7 + face_y + ear, 2, 4, glow)
        oval(20, 7 + face_y + ear, 1, 2, '#ef9eaf')
        oval(16, 16 + face_y, 10, 7, ink)
        oval(16, 15 + face_y, 9, 6, glow)
        oval(10, 17 + face_y, 2, 1, '#efb5ba')
        oval(22, 17 + face_y, 2, 1, '#efb5ba')
    elif kind == 'cloud':
        drift = (0, -1, -2, -2, -1, 0)[frame]
        face_y = y + (0 if music or mood == 'pickup' else drift)
        puff = arc if mood == 'groove' else 0
        for cx, cy, rx, ry in ((8, 18, 6, 5), (14, 13, 7, 7), (21, 15, 7, 6), (25, 19, 5, 4)):
            oval(cx, cy + face_y, rx, ry, ink)
        oval(16, 20 + face_y, 12, 5, ink)
        for cx, cy, rx, ry in ((8, 18, 5, 4), (14, 13, 6, 6), (21, 15, 6, 5), (25, 19, 4, 3)):
            oval(cx, cy + face_y, rx, ry, shade)
            oval(cx, cy + face_y - 1, rx - 1, ry - 1, glow)
        oval(16, 19 + face_y, 11, 4, glow)
        oval(13, 11 + face_y, 3, 1, '#ffffff')
        face_y += puff
        if moving or mood in ('happy', 'groove'):
            sparkle(26, 8 - frame % 3, '#f2c879')
    elif kind == 'ghost':
        drift = (0, -2, -4, -4, -2, 0)[frame]
        y += drift if not sleepy and not music else 0
        face_y = y
        rounded(7, 7 + y, 19, 17, ink)
        rounded(8, 8 + y, 17, 15, glow)
        rect(9, 19 + y, 15, 5, shade)
        for i in range(3):
            tail = (frame + i) % 3 if not music else 1
            rect(8 + i * 6, 21 + y, 5, 3 + tail, ink)
            rect(9 + i * 6, 21 + y, 3, 2 + tail, shade)
        rect(10, 11 + y, 2, 4, '#fffaff')
        if moving:
            sparkle(26, 17 + frame % 3, '#d3b8f6')
        if mood in ('dance', 'groove'):
            face_y = (0, 1, 2, 1, 0, -1)[frame] if mood == 'dance' else (0, -1, 1, -2, 1, 0)[frame]
    elif kind == 'sprout':
        for foot, shift in ((10, stride), (20, -stride)):
            rect(foot + (shift if moving else 0), 24, 4, 3, ink)
        rect(9, 17 + y, 15, 7, ink)
        rect(10, 18 + y, 13, 7, shade)
        rect(11, 19 + y, 2, 5, '#f7b58b')
        rect(21, 19 + y, 2, 5, '#bd765e')
        face_y = y + (arc if mood == 'dance' else (0, 2, -1, 2, 0, -1)[frame] if mood == 'groove' else 0)
        leaf = (0, -1, -2, -1, 0, 1)[frame] if not sleepy else 1
        rect(16, 4 + face_y, 2, 8, '#366a58')
        rounded(8, 3 + face_y + leaf, 9, 6, '#35674e')
        rect(10, 4 + face_y + leaf, 5, 3, '#9bdb8d')
        rounded(17, 2 + face_y - leaf, 9, 6, '#35674e')
        rect(19, 3 + face_y - leaf, 5, 3, '#b5e598')
        rounded(7, 9 + face_y, 19, 12, ink)
        rounded(8, 10 + face_y, 17, 9, glow)
    else:
        moonwalk = mood == 'groove'
        for leg, (foot, shift) in enumerate(((9, stride), (20, -stride))):
            phase = (frame + leg * 3) % 6
            dx = (0, -2, -4, -3, -1, 0)[phase] if moonwalk else shift if moving else 0
            lift = (1, 0, 0, 0, 2, 3)[phase] if moonwalk else 0
            rect(foot + dx + 1, 21, 3, 4 - lift, ink)
            rect(foot + dx, 24 - lift, 6, 3, ink)
            rect(foot + dx + 1, 24 - lift, 4, 2, shade)
            if moonwalk:
                rect(foot + dx + 1, 25 - lift, 4, 1, '#a9ffdf')
        if moonwalk:
            arm = (0, 1, 2, 2, 1, 0)[frame]
            rect(5, 18 + arm, 5, 3, ink)
            rect(4, 17 + arm, 3, 4, glow)
            rect(24, 18 - arm, 4, 3, ink)
            rect(26, 16 - arm, 3, 4, glow)
        rounded(8, 17 + y, 17, 8, ink)
        rect(10, 18 + y, 13, 5, shade)
        rect(14, 20 + y, 4, 2, '#f4c779')
        face_y = y + (arc if mood == 'dance' else (0, 2, -1, 2, 0, -1)[frame] if mood == 'groove' else 0)
        rounded(6, 8 + face_y, 21, 13, ink)
        rounded(7, 9 + face_y, 19, 11, shade)
        rect(10, 10 + face_y, 11, 1, glow)
        rounded(9, 12 + face_y, 15, 7, '#26394f')
        rect(16, 5 + face_y, 2, 4, ink)
        sparkle(15, 3 + face_y, '#f6cf7b' if frame < 3 else '#f69498')

    eye_y = (14 if kind in ('bunny', 'robot') else 15 if kind == 'cloud' else 13) + face_y
    eye_positions = (12 + face_x,) if profile else (11, 20)
    for ex in eye_positions:
        closed = sleepy or blink_now or (mood == 'idle' and frame == 5)
        rect(ex - int(closed), eye_y + int(closed), 4 if closed else 3, 1 if closed else 3, eye)
        if mood == 'hungry':
            rect(ex + 1, eye_y, 1, 1, '#fff6da')
    if kind != 'robot':
        rect(9 + face_x, 17 + face_y, 2, 1, '#f4a9bb')
        if not profile:
            rect(22, 17 + face_y, 2, 1, '#f4a9bb')
    if mood in ('eat', 'hungry', 'surprised', 'tired'):
        rect(15 + face_x, 17 + face_y, 2, 1 + frame % 3, eye)
    elif kind != 'robot':
        rect(15 + face_x, 18 + face_y, 2, 1, eye)
    if mood == 'fidget':
        if kind == 'ghost':
            sparkle(3 + frame % 3, 10 - arc, '#ddc4ff')
            sparkle(25, 6 + arc, '#ffd584')
        elif kind == 'sprout':
            sparkle(4, 8 - arc, '#a2d789')
            rect(26, 10 + frame % 3, 2, 2, '#f7bbbc')
        elif kind == 'robot':
            rect(10, 13, 13, 5, '#26394f')
            rect(10 + frame * 2, 13, 2, 5, '#a9ffdf')
        elif kind == 'bunny':
            oval(11 + arc, 22 - arc, 3, 2, shade)
            oval(11 + arc, 21 - arc, 2, 1, glow)
        else:
            sparkle(26, 9 - arc, '#f2c879')
            rect(9 + frame % 3, 22, 2, 1, '#b9a3ed')
    if mood == 'look':
        shift = (-1, -2, -1, 1, 2, 0)[frame]
        face_color = '#26394f' if kind == 'robot' else glow
        rect(9, eye_y, 15, 3, face_color)
        for ex in (11, 20):
            rect(ex + shift, eye_y, 2, 3, eye)
    if music:
        rect(11, 7 + face_y, 12, 1, '#735798')
        for side in (7, 24):
            rect(side, 12 + face_y, 3, 5, '#735798')
            rect(side + 1, 13 + face_y, 1, 3, '#d6b8fa')
        if mood in ('dance', 'groove'):
            note = 27 if frame < 3 else 3
            rect(note, 6 - frame % 3, 1, 5, '#efbe62')
            rect(note - 1, 10 - frame % 3, 2, 1, '#efbe62')
            rect(note, 6 - frame % 3, 3, 1, '#efbe62')
    if sleepy:
        sparkle(26, 6 - frame % 3, '#a988db')
    elif mood in ('happy', 'surprised', 'stretch'):
        sparkle(3, 7 - frame % 3, '#f4bd72')
        sparkle(26, 5 + frame % 3, '#d796ce')
    elif mood in ('eat', 'hungry'):
        rect(24, 21 - frame % 3, 3, 2, '#edb067')
        rect(24, 21 - frame % 3, 2, 1, '#ffe0a0')
    if anchors is not None:
        if kind == 'bunny':
            head_x, head_y, chest_y = 16, 9 + face_y, 21
        elif kind == 'cloud':
            body_y = y + (0 if music or mood == 'pickup' else drift)
            head_x, head_y, chest_y = 16, 6 + body_y, 21 + body_y
        elif kind == 'ghost':
            head_x, head_y, chest_y = 16.5, 7 + y, 21 + y
        elif kind == 'sprout':
            head_x, head_y, chest_y = 16.5, 9 + face_y, 20 + y
        else:
            head_x, head_y, chest_y = 16.5, 8 + face_y, 20 + y
        chest_x = 16 if kind in ('bunny', 'cloud') else 16.5
        anchors.extend((head_x, head_y, chest_x, chest_y, head_x - 7, head_y + 1))
    return pixels

def write_png(path, width, height, rows):
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data))
    header = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header)
                     + chunk(b'IDAT', zlib.compress(b''.join(b'\0' + row for row in rows)))
                     + chunk(b'IEND', b''))

def write_preview(path):
    """Render the native character geometry at its 128px desktop size."""
    cell, width = 144, 432
    pixels = bytearray(bytes.fromhex('f6f0e8ff') * width * width)
    cards = ('fffaf4ff', 'f6edf5ff', 'edf2e7ff')
    for number, kind in enumerate(KINDS):
        left, top = (number % 3) * cell, (number // 3) * cell
        for y in range(top + 4, top + cell - 4):
            for x in range(left + 4, left + cell - 4):
                if x in (left + 4, left + cell - 5) and (y < top + 10 or y >= top + cell - 10):
                    continue
                at = (y * width + x) * 4
                pixels[at:at + 4] = bytes.fromhex(cards[number % 3])
        anchors = []
        frame = finish(draw(kind, 'idle', 0, anchors=anchors), kind, 'idle', anchors)
        for y in range(128):
            for x in range(128):
                source = ((y // 2) * RASTER_SIZE + x // 2) * 4
                alpha = frame[source + 3] / 255
                if not alpha:
                    continue
                at = ((top + 8 + y) * width + left + 8 + x) * 4
                pixels[at:at + 3] = bytes(round(frame[source + channel] * alpha + pixels[at + channel] * (1 - alpha)) for channel in range(3))
    write_png(path, width, width, [pixels[y * width * 4:(y + 1) * width * 4] for y in range(width)])


if __name__ == '__main__':
    if '--preview' in sys.argv:
        write_preview(Path(sys.argv[sys.argv.index('--preview') + 1]))
        sys.exit(0)
    attachment_rows = {}
    for kind in KINDS:
        rows = []
        attachment_rows[kind] = []
        rows_moods = MOODS + ('dance', 'groove', 'fidget', 'look')
        for row, mood in enumerate(rows_moods):
            frames = []
            anchors = []
            for frame in range(FRAMES):
                points = []
                pixels = draw(kind, mood, frame, blink_now=row in (len(MOODS), len(MOODS) + 1), anchors=points)
                frames.append(finish(pixels, kind, mood, points))
                anchors.append(points)
            attachment_rows[kind].append(anchors)
            for y in range(RASTER_SIZE):
                rows.append(b''.join(frame[y * RASTER_SIZE * 4:(y + 1) * RASTER_SIZE * 4] for frame in frames))
        if '--attachments-only' not in sys.argv:
            write_png(Path('art') / (kind + '.png'), RASTER_SIZE * FRAMES, RASTER_SIZE * len(rows_moods), rows)
    lines = ['// Generated by art/draw_sprites.py. Head, chest, and clip anchors in 32px sprite coordinates.', 'const petAttachmentFrames = {']
    for kind, poses in attachment_rows.items():
        lines.append('  ' + json.dumps(kind) + ': [')
        lines.extend('    ' + json.dumps(pose) + ',' for pose in poses)
        lines.append('  ],')
    lines.append('};')
    Path('art/attachments.js').write_text('\n'.join(lines) + '\n', encoding='utf-8')



















