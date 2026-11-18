"""
Green Quest 360 — robot « version propre ».

Refait chaque photo 360 en haute définition à partir des photos sources envoyées par l'app V2 :
  - repart des orientations affinées par le téléphone (meta.json, champ Rref) ;
  - compense l'exposition par blocs ;
  - cherche des coutures intelligentes (graph-cut : les raccords passent là où les photos se ressemblent,
    ce qui évite de couper un objet ou une personne en deux) ;
  - fond les photos en multi-bandes (détails fins sur une zone étroite, couleurs sur une zone large) ;
  - bouche seulement le ciel et le sol manquants (jamais le sujet).

Utilisation :
  python process.py --local DOSSIER [--out FICHIER] [--width 8192]   # un dossier meta.json + sources/
  python process.py --drive                                          # file d'attente du Drive (GitHub Actions)
      variables d'environnement : GQ_BOT_URL (URL du script Google V2), GQ_BOT_KEY (clé robot)
"""
import argparse
import base64
import json
import math
import os
import struct
import sys
import time
import traceback
import urllib.request

import cv2
import numpy as np

cv2.setNumThreads(max(1, os.cpu_count() or 1))


# ---------------------------------------------------------------- géométrie

def mat3(a):
    return np.array(a, dtype=np.float64).reshape(3, 3)


def yaw_of(v):
    return math.atan2(v[0], v[1])


def build_cameras(meta, images):
    cams = []
    fn = float(meta.get('focalNorm') or 0.77)
    for s, img in zip(meta['shots'], images):
        R = mat3(s.get('Rref') or s['R'])  # caméra -> monde
        h, w = img.shape[:2]
        f = fn * max(w, h)
        cams.append({'R': R, 'Rt': R.T, 'f': f, 'w': w, 'h': h, 'fwd': R[:, 2].copy(), 'gain': s.get('gain') or 1.0})
    return cams


def footprint(cam, W, H, yaw0):
    """Zone (x0, x1, y0, y1) de l'image dans l'équirectangulaire de travail, x non replié autour de son centre."""
    w, h, f = cam['w'], cam['h'], cam['f']
    n = 24
    pts = []
    for t in np.linspace(0, 1, n):
        pts += [(t * w, 0), (t * w, h), (0, t * h), (w, t * h)]
    pts = np.array(pts)
    rays = np.stack([(pts[:, 0] - w / 2) / f, (pts[:, 1] - h / 2) / f, np.ones(len(pts))], 1) @ cam['R'].T
    rays /= np.linalg.norm(rays, axis=1, keepdims=True)
    yaw = np.arctan2(rays[:, 0], rays[:, 1])
    pitch = np.arcsin(np.clip(rays[:, 2], -1, 1))
    xc = ((yaw_of(cam['fwd']) - yaw0) % (2 * math.pi)) / (2 * math.pi) * W
    xs = ((yaw - yaw0) % (2 * math.pi)) / (2 * math.pi) * W
    dx = (xs - xc + W / 2) % W - W / 2
    ys = (0.5 - pitch / math.pi) * H
    # L'image contient-elle un pôle ? (zénith / nadir)
    fwd_pitch = math.asin(max(-1, min(1, cam['fwd'][2])))
    half_diag = math.atan(math.hypot(w, h) / 2 / f)
    pole = abs(fwd_pitch) + half_diag > math.pi / 2
    y0, y1 = int(max(0, math.floor(ys.min()) - 2)), int(min(H, math.ceil(ys.max()) + 2))
    if pole:
        if fwd_pitch > 0:
            y0 = 0
        else:
            y1 = H
        return None, None, y0, y1, True
    return int(math.floor(xc + dx.min()) - 2), int(math.ceil(xc + dx.max()) + 2), y0, y1, False


def warp(img, cam, x0, x1, y0, y1, W, H, yaw0):
    """Projette une photo sur la zone [x0,x1)×[y0,y1) de l'équirectangulaire (x peut dépasser 0..W)."""
    xs = np.arange(x0, x1, dtype=np.float64)
    ys = np.arange(y0, y1, dtype=np.float64)
    yaw = yaw0 + (xs + 0.5) / W * 2 * math.pi
    pitch = (0.5 - (ys + 0.5) / H) * math.pi
    cp, sp = np.cos(pitch)[:, None], np.sin(pitch)[:, None]
    dx = cp * np.sin(yaw)[None, :]
    dy = cp * np.cos(yaw)[None, :]
    dz = np.broadcast_to(sp, dx.shape)
    Rt = cam['Rt']
    vx = Rt[0, 0] * dx + Rt[0, 1] * dy + Rt[0, 2] * dz
    vy = Rt[1, 0] * dx + Rt[1, 1] * dy + Rt[1, 2] * dz
    vz = Rt[2, 0] * dx + Rt[2, 1] * dy + Rt[2, 2] * dz
    ok = vz > 0.05
    vz = np.where(ok, vz, 1)
    mx = (cam['f'] * vx / vz + cam['w'] / 2 - 0.5).astype(np.float32)
    my = (cam['f'] * vy / vz + cam['h'] / 2 - 0.5).astype(np.float32)
    inside = ok & (mx >= 0) & (my >= 0) & (mx <= cam['w'] - 1) & (my <= cam['h'] - 1)
    mx[~inside] = -10
    my[~inside] = -10
    out = cv2.remap(img, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    mask = (inside * 255).astype(np.uint8)
    # on rogne légèrement le bord (pixels interpolés avec le noir)
    mask = cv2.erode(mask, np.ones((3, 3), np.uint8))
    return fill_outside(out, mask), mask


def fill_outside(img, mask):
    """Prolonge les couleurs de la photo dans ses zones vides (méthode « push-pull »).
    Sans ça, le fondu multi-bandes voit le noir autour de chaque photo et le fait baver le long des raccords."""
    levels = []
    cur, cm = img.astype(np.float32), (mask > 0).astype(np.float32)
    while min(cur.shape[:2]) > 4 and cm.min() == 0:
        levels.append((cur, cm))
        num = cv2.resize(cur * cm[..., None], (max(1, cur.shape[1] // 2), max(1, cur.shape[0] // 2)), interpolation=cv2.INTER_AREA)
        den = cv2.resize(cm, (num.shape[1], num.shape[0]), interpolation=cv2.INTER_AREA)
        cur = num / np.maximum(den, 1e-6)[..., None]
        cm = (den > 1e-6).astype(np.float32)
    if cm.min() == 0:  # image entièrement vide à ce niveau : couleur moyenne
        valid = cm > 0
        cur[~valid] = cur[valid].mean(axis=0) if valid.any() else 0
    for up_img, up_m in reversed(levels):
        big = cv2.resize(cur, (up_img.shape[1], up_img.shape[0]), interpolation=cv2.INTER_LINEAR)
        cur = up_img * up_m[..., None] + big * (1 - up_m[..., None])
    return np.clip(cur, 0, 255).astype(np.uint8)


# ---------------------------------------------------------------- assemblage

def stitch(meta, images, W=8192, log=print):
    t0 = time.time()
    H = W // 2
    cams = build_cameras(meta, images)
    # Repère de travail : la ligne de raccord du 360 (x = 0) passe au centre de la photo n°1 ;
    # on décale ensuite d'un demi-tour pour que la photo n°1 soit au centre de l'image finale.
    yaw0 = yaw_of(cams[0]['fwd'])
    m = W // 8  # marge de part et d'autre pour gérer le bouclage gauche/droite
    pieces = []  # (img, mask, corner)
    for i, (img, cam) in enumerate(zip(images, cams)):
        x0, x1, y0, y1, pole = footprint(cam, W, H, yaw0)
        if y1 <= y0:
            continue
        spans = [(-m, W + m)] if pole else []
        if not pole:
            for shift in (-W, 0, W):
                a, b = x0 + shift, x1 + shift
                a, b = max(a, -m), min(b, W + m)
                if b > a:
                    spans.append((a, b))
        for a, b in spans:
            out, mask = warp(img, cam, a, b, y0, y1, W, H, yaw0)
            if mask.any():
                pieces.append({'img': out, 'mask': mask, 'corner': (a + m, y0), 'src': i})
    log(f'  projection : {len(pieces)} morceaux en {time.time() - t0:.1f} s')

    # --- exposition + coutures à basse résolution
    seam_scale = min(1.0, 1500.0 / W)
    small, small_masks, small_corners = [], [], []
    for p in pieces:
        s = cv2.resize(p['img'], None, fx=seam_scale, fy=seam_scale, interpolation=cv2.INTER_AREA)
        sm = cv2.resize(p['mask'], (s.shape[1], s.shape[0]), interpolation=cv2.INTER_NEAREST)
        small.append(s)
        small_masks.append(sm)
        small_corners.append((int(round(p['corner'][0] * seam_scale)), int(round(p['corner'][1] * seam_scale))))

    comp = cv2.detail.ExposureCompensator_createDefault(getattr(cv2.detail, 'ExposureCompensator_' + os.environ.get('GQ_COMP', 'GAIN_BLOCKS')))
    comp.feed(corners=small_corners, images=small, masks=small_masks)
    for k, p in enumerate(pieces):
        comp.apply(k, small_corners[k], small[k], small_masks[k])

    seamer = cv2.detail_GraphCutSeamFinder('COST_COLOR_GRAD')
    seam_masks = seamer.find([s.astype(np.float32) for s in small], small_corners, small_masks)
    log(f'  coutures : {time.time() - t0:.1f} s')

    # --- fondu multi-bandes à pleine résolution
    blender = cv2.detail_MultiBandBlender(0, 5)
    sizes = [(p['img'].shape[1], p['img'].shape[0]) for p in pieces]
    corners = [p['corner'] for p in pieces]
    blender.prepare(cv2.detail.resultRoi(corners=corners, sizes=sizes))
    for k, p in enumerate(pieces):
        img = p['img']
        comp.apply(k, p['corner'], img, p['mask'])
        sm = seam_masks[k].get() if hasattr(seam_masks[k], 'get') else seam_masks[k]
        sm = cv2.dilate(sm, np.ones((3, 3), np.uint8))
        sm = cv2.resize(sm, (img.shape[1], img.shape[0]), interpolation=cv2.INTER_LINEAR_EXACT)
        final_mask = cv2.bitwise_and(sm, p['mask'])
        blender.feed(img.astype(np.int16), final_mask, p['corner'])
        p['img'] = None
    result, result_mask = blender.blend(None, None)
    roi = cv2.detail.resultRoi(corners=corners, sizes=sizes)
    log(f'  fondu : {time.time() - t0:.1f} s')

    # --- remise sur le canevas étendu puis découpe 0..W
    canvas = np.zeros((H, W + 2 * m, 3), np.uint8)
    cmask = np.zeros((H, W + 2 * m), np.uint8)
    rx, ry = roi[0], roi[1]
    rh, rw = result.shape[:2]
    xa, ya = max(0, rx), max(0, ry)
    xb, yb = min(W + 2 * m, rx + rw), min(H, ry + rh)
    canvas[ya:yb, xa:xb] = np.clip(result[ya - ry:yb - ry, xa - rx:xb - rx], 0, 255).astype(np.uint8)
    cmask[ya:yb, xa:xb] = result_mask[ya - ry:yb - ry, xa - rx:xb - rx]
    pano = canvas[:, m:m + W].copy()
    pmask = cmask[:, m:m + W].copy()

    # --- trous restants (ciel / sol non photographiés) : remplissage doux, uniquement près des pôles
    holes = pmask == 0
    hole_ratio = float(holes.mean())
    if holes.any():
        sc = 1024 / W
        sp = cv2.resize(pano, None, fx=sc, fy=sc, interpolation=cv2.INTER_AREA)
        sh = cv2.resize(holes.astype(np.uint8) * 255, (sp.shape[1], sp.shape[0]), interpolation=cv2.INTER_NEAREST)
        filled = cv2.inpaint(sp, sh, 6, cv2.INPAINT_TELEA)
        filled = cv2.GaussianBlur(filled, (0, 0), 3)
        big = cv2.resize(filled, (W, H), interpolation=cv2.INTER_CUBIC)
        pano[holes] = big[holes]

    pano = np.roll(pano, W // 2, axis=1)  # photo n°1 au centre
    log(f'  terminé : {time.time() - t0:.1f} s ({len(pieces)} morceaux, trous {hole_ratio * 100:.2f} %)')
    return pano, {'pieces': len(pieces), 'holes': hole_ratio, 'seconds': round(time.time() - t0, 1)}


# ---------------------------------------------------------------- métadonnées JPEG (XMP GPano + EXIF GPS)

def _segment(marker, payload):
    return b'\xff' + bytes([marker]) + struct.pack('>H', len(payload) + 2) + payload


def _xmp(w, h):
    xml = ('<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">'
           '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" '
           'xmlns:GPano="http://ns.google.com/photos/1.0/panorama/" GPano:ProjectionType="equirectangular" '
           'GPano:UsePanoramaViewer="True" '
           f'GPano:CroppedAreaImageWidthPixels="{w}" GPano:CroppedAreaImageHeightPixels="{h}" '
           f'GPano:FullPanoWidthPixels="{w}" GPano:FullPanoHeightPixels="{h}" '
           'GPano:CroppedAreaLeftPixels="0" GPano:CroppedAreaTopPixels="0" '
           'GPano:StitchingSoftware="Green Quest 360 HD"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>')
    return _segment(0xE1, b'http://ns.adobe.com/xap/1.0/\x00' + xml.encode('utf-8'))


def _exif(lat, lon):
    entries0 = [(0x0131, 2, b'Green Quest 360 HD\x00')]
    gps = []
    if lat is not None and lon is not None:
        def dms(v):
            v = abs(v); d = int(v); mf = (v - d) * 60; mi = int(mf); s = round((mf - mi) * 60 * 10000)
            return struct.pack('>IIIIII', d, 1, mi, 1, s, 10000)
        gps = [(0x0000, 1, bytes([2, 3, 0, 0])), (0x0001, 2, (b'N' if lat >= 0 else b'S') + b'\x00'), (0x0002, 5, dms(lat)),
               (0x0003, 2, (b'E' if lon >= 0 else b'W') + b'\x00'), (0x0004, 5, dms(lon))]
        entries0.append((0x8825, 4, None))
    size = {1: 1, 2: 1, 4: 4, 5: 8}
    ifd_len = lambda e: 2 + 12 * len(e) + 4
    data_len = lambda e: sum(len(v) + (len(v) & 1) for _, _, v in e if v is not None and len(v) > 4)
    off0 = 8
    gps_off = off0 + ifd_len(entries0) + data_len(entries0)
    total = gps_off + (ifd_len(gps) + data_len(gps) if gps else 0)
    buf = bytearray(total)
    buf[0:8] = b'MM\x00\x2a' + struct.pack('>I', off0)

    def write(entries, off):
        struct.pack_into('>H', buf, off, len(entries))
        p, d = off + 2, off + ifd_len(entries)
        for tag, typ, val in entries:
            if tag == 0x8825:
                struct.pack_into('>HHII', buf, p, tag, typ, 1, gps_off)
            else:
                struct.pack_into('>HHI', buf, p, tag, typ, len(val) // size[typ])
                if len(val) <= 4:
                    buf[p + 8:p + 8 + len(val)] = val
                else:
                    struct.pack_into('>I', buf, p + 8, d)
                    buf[d:d + len(val)] = val
                    d += len(val) + (len(val) & 1)
            p += 12
        struct.pack_into('>I', buf, p, 0)
    write(entries0, off0)
    if gps:
        write(gps, gps_off)
    return _segment(0xE1, b'Exif\x00\x00' + bytes(buf))


def encode_jpeg(pano, location, quality=92):
    ok, jpg = cv2.imencode('.jpg', pano, [cv2.IMWRITE_JPEG_QUALITY, quality, cv2.IMWRITE_JPEG_OPTIMIZE, 1])
    jpg = jpg.tobytes()
    pos = 2
    if jpg[2:4] == b'\xff\xe0':
        pos = 4 + struct.unpack('>H', jpg[4:6])[0]
    lat = location.get('lat') if location else None
    lon = location.get('lon') if location else None
    return jpg[:2] + _exif(lat, lon) + _xmp(pano.shape[1], pano.shape[0]) + jpg[pos:]


# ---------------------------------------------------------------- entrées / sorties

def decode(data):
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError('image illisible')
    return img


def choose_width(meta, images, requested):
    fn = float(meta.get('focalNorm') or 0.77)
    long_side = max(max(i.shape[:2]) for i in images)
    px_per_rad = fn * long_side  # résolution native des photos
    native = int(2 * math.pi * px_per_rad)
    w = min(requested, max(4096, native))
    return w - (w % 16)


def process_local(folder, out, width):
    meta = json.load(open(os.path.join(folder, 'meta.json'), encoding='utf-8'))
    images = [decode(open(os.path.join(folder, s['file']), 'rb').read()) for s in meta['shots']]
    W = choose_width(meta, images, width)
    print(f'{len(images)} photos, largeur {W}')
    pano, info = stitch(meta, images, W)
    out = out or os.path.join(folder, 'hd_360.jpg')
    open(out, 'wb').write(encode_jpeg(pano, meta.get('location')))
    print('écrit :', out, info)


def bot_call(body, timeout=300):
    url, key = os.environ['GQ_BOT_URL'], os.environ['GQ_BOT_KEY']
    body = dict(body, key=key)
    req = urllib.request.Request(url, data=json.dumps(body).encode('utf-8'), headers={'Content-Type': 'text/plain;charset=utf-8'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                res = json.loads(r.read().decode('utf-8'))
            if not res.get('ok'):
                raise RuntimeError(res.get('error') or 'erreur serveur')
            return res
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if attempt == 2:
                raise
            time.sleep(5 * (attempt + 1))


class NetworkError(Exception):
    pass


def process_drive(width, max_minutes=40):
    start = time.time()
    folders = bot_call({'action': 'bot_pending'})['folders']
    print(f'{len(folders)} photo(s) en attente')
    for fid in folders:
        if time.time() - start > max_minutes * 60:
            print('temps écoulé, le reste passera au prochain tour')
            break
        try:
            listing = bot_call({'action': 'bot_files', 'folderId': fid})
        except Exception as e:
            print('  listing impossible, on réessaiera :', e)
            continue
        files = {f['name']: f for f in listing['files']}
        print(f'- {listing["name"]} ({len(files)} fichiers)')
        try:
            if 'meta.json' not in files:
                raise NetworkError('meta.json pas encore arrivé')
            meta = json.loads(base64.b64decode(bot_call({'action': 'bot_get', 'fileId': files['meta.json']['id']})['data']).decode('utf-8'))
            missing = [s['file'] for s in meta['shots'] if s['file'] not in files]
            if missing:
                raise NetworkError(f'{len(missing)} photo(s) source manquante(s)')
            images = [decode(base64.b64decode(bot_call({'action': 'bot_get', 'fileId': files[s['file']]['id']})['data'])) for s in meta['shots']]
        except NetworkError as e:
            print('  en attente :', e)
            continue
        except Exception as e:
            print('  téléchargement impossible, on réessaiera :', e)
            continue
        try:
            W = choose_width(meta, images, width)
            pano, info = stitch(meta, images, W, log=print)
            jpg = encode_jpeg(pano, meta.get('location'))
        except Exception:
            msg = traceback.format_exc()
            print(msg)
            bot_call({'action': 'bot_fail', 'folderId': fid, 'message': msg})
            continue
        name = (meta.get('pano', {}).get('file') or 'photo_360.jpg').replace('_360.jpg', '_360_HD.jpg')
        res = bot_call({'action': 'bot_put', 'folderId': fid, 'name': name, 'captureId': meta['id'], 'data': base64.b64encode(jpg).decode('ascii')})
        print(f'  version propre déposée ({len(jpg) // 1024} Ko, {W}×{W // 2}) :', res.get('url'))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--local')
    ap.add_argument('--out')
    ap.add_argument('--drive', action='store_true')
    ap.add_argument('--width', type=int, default=8192)
    a = ap.parse_args()
    if a.local:
        process_local(a.local, a.out, a.width)
    elif a.drive:
        process_drive(a.width)
    else:
        ap.print_help()
        sys.exit(1)
