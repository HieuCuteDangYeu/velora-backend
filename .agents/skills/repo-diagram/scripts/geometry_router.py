#!/usr/bin/env python3
"""Geometry helpers for Repo Diagrammer's native architecture renderer."""
from __future__ import annotations

import math

EPS = 1e-6


def center(box):
    x, y, w, h = box
    return x+w/2, y+h/2


def orient(a, b, c):
    return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])


def proper_intersection(a, b, c, d):
    o1, o2, o3, o4 = orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b)
    return ((o1 > EPS and o2 < -EPS) or (o1 < -EPS and o2 > EPS)) and \
           ((o3 > EPS and o4 < -EPS) or (o3 < -EPS and o4 > EPS))


def collinear_overlap(a, b, c, d):
    """Return overlap length for axis-aligned collinear segments."""
    if abs(a[0]-b[0]) < EPS and abs(c[0]-d[0]) < EPS and abs(a[0]-c[0]) < EPS:
        lo=max(min(a[1],b[1]),min(c[1],d[1]))
        hi=min(max(a[1],b[1]),max(c[1],d[1]))
        return max(0.0, hi-lo)
    if abs(a[1]-b[1]) < EPS and abs(c[1]-d[1]) < EPS and abs(a[1]-c[1]) < EPS:
        lo=max(min(a[0],b[0]),min(c[0],d[0]))
        hi=min(max(a[0],b[0]),max(c[0],d[0]))
        return max(0.0, hi-lo)
    return 0.0


def segment_hits_box(a, b, box, pad=3.0):
    x, y, w, h = box
    left, right = x-pad, x+w+pad
    top, bottom = y-pad, y+h+pad
    if abs(a[0]-b[0]) < EPS:
        xx=a[0]
        lo,hi=sorted((a[1],b[1]))
        return left < xx < right and max(lo,top) < min(hi,bottom)
    if abs(a[1]-b[1]) < EPS:
        yy=a[1]
        lo,hi=sorted((a[0],b[0]))
        return top < yy < bottom and max(lo,left) < min(hi,right)
    return False


def route_length(points):
    return sum(math.dist(a,b) for a,b in zip(points,points[1:]))


def compress(points):
    out=[]
    for p in points:
        if out and math.dist(out[-1],p)<EPS:
            continue
        out.append(p)
    changed=True
    while changed and len(out)>2:
        changed=False
        tmp=[out[0]]
        for i in range(1,len(out)-1):
            a,b,c=tmp[-1],out[i],out[i+1]
            if (abs(a[0]-b[0])<EPS and abs(b[0]-c[0])<EPS) or \
               (abs(a[1]-b[1])<EPS and abs(b[1]-c[1])<EPS):
                changed=True
                continue
            tmp.append(b)
        tmp.append(out[-1])
        out=tmp
    return out


def route_score(points, sid, tid, boxes, existing_routes):
    obstacles=0
    for nid,box in boxes.items():
        if nid in {sid,tid}:
            continue
        for a,b in zip(points,points[1:]):
            if segment_hits_box(a,b,box):
                obstacles += 1

    crossings=0
    overlaps=0.0
    for prev in existing_routes:
        if {sid,tid} & {prev.get("source"),prev.get("target")}:
            # Shared endpoint is normal, but long shared corridors are still penalized.
            shared=True
        else:
            shared=False
        for a,b in zip(points,points[1:]):
            for c,d in zip(prev["points"],prev["points"][1:]):
                if proper_intersection(a,b,c,d):
                    crossings += 1
                ov=collinear_overlap(a,b,c,d)
                if ov>8:
                    overlaps += ov*(0.2 if shared else 1.0)

    bends=max(0,len(points)-2)
    length=route_length(points)
    return obstacles*1_000_000 + crossings*100_000 + overlaps*500 + bends*25 + length


def _same_row_candidates(sbox,tbox,canvas_w,lane_index=0,source_slot=0.0,target_slot=0.0):
    sx,sy,sw,sh=sbox
    tx,ty,tw,th=tbox
    scx,_=center(sbox)
    tcx,_=center(tbox)
    rightward=tcx>=scx
    x1=sx+sw if rightward else sx
    x2=tx if rightward else tx+tw
    y1=sy+sh/2 + source_slot*sh*0.32
    y2=ty+th/2 + target_slot*th*0.32
    lift_base=30+lane_index*10
    candidates=[]
    for sign in (-1,1):
        for extra in (0,24,52,86):
            midy=(min(sy,ty)-lift_base-extra) if sign<0 else (max(sy+sh,ty+th)+lift_base+extra)
            candidates.append([(x1,y1),(x1,midy),(x2,midy),(x2,y2)])
    # Perimeter escapes for dense rows.
    candidates.append([(x1,y1),(x1,sy-20),(24,sy-20),(24,ty-20),(x2,ty-20),(x2,y2)])
    candidates.append([(x1,y1),(x1,sy+sh+20),(canvas_w-24,sy+sh+20),
                       (canvas_w-24,ty+th+20),(x2,ty+th+20),(x2,y2)])
    return [compress(x) for x in candidates]


def _cross_row_candidates(sbox,tbox,canvas_w,lane_index=0,source_slot=0.0,target_slot=0.0):
    sx,sy,sw,sh=sbox
    tx,ty,tw,th=tbox
    downward=ty>=sy
    x1=sx+sw/2 + source_slot*sw*0.34
    y1=sy+sh if downward else sy
    x2=tx+tw/2 + target_slot*tw*0.34
    y2=ty if downward else ty+th
    lo,hi=sorted((y1,y2))
    candidates=[]
    # Horizontal channels distributed through the free vertical span.
    fractions=(0.28,0.38,0.5,0.62,0.72)
    for j,f in enumerate(fractions):
        mid=lo+(hi-lo)*f + ((lane_index+j)%3-1)*7
        candidates.append([(x1,y1),(x1,mid),(x2,mid),(x2,y2)])
    stub1=y1+(18 if downward else -18)
    stub2=y2+(-18 if downward else 18)
    for channel in (24,canvas_w-24):
        candidates.append([(x1,y1),(x1,stub1),(channel,stub1),(channel,stub2),(x2,stub2),(x2,y2)])
    return [compress(x) for x in candidates]


def route_edge(boxes,row_index,sid,tid,canvas_w,existing_routes,lane_index=0,source_slot=0.0,target_slot=0.0):
    if sid not in boxes or tid not in boxes:
        return []
    if row_index[sid]==row_index[tid]:
        candidates=_same_row_candidates(
            boxes[sid],boxes[tid],canvas_w,lane_index,source_slot,target_slot
        )
    else:
        candidates=_cross_row_candidates(
            boxes[sid],boxes[tid],canvas_w,lane_index,source_slot,target_slot
        )
    return min(candidates,key=lambda p: route_score(p,sid,tid,boxes,existing_routes))


def box_overlap(a,b,pad=0.0):
    ax,ay,aw,ah=a
    bx,by,bw,bh=b
    return min(ax+aw,bx+bw)-max(ax,bx)>pad and min(ay+ah,by+bh)-max(ay,by)>pad


def label_candidates(points,w,h):
    candidates=[]
    segs=sorted(zip(points,points[1:]),key=lambda ab:math.dist(ab[0],ab[1]),reverse=True)
    # Midpoint-only placement is too brittle in dense diagrams. Sample several
    # positions and several distances from each significant route segment.
    for a,b in segs[:6]:
        for frac in (0.25,0.5,0.75):
            mx=a[0]+(b[0]-a[0])*frac
            my=a[1]+(b[1]-a[1])*frac
            if abs(a[1]-b[1])<EPS:
                for offset in (6, h+10, 2*h+16):
                    candidates.extend([
                        (mx-w/2,my-h-offset,w,h),
                        (mx-w/2,my+offset,w,h),
                    ])
            elif abs(a[0]-b[0])<EPS:
                for offset in (7, w*0.35+10, w+14):
                    candidates.extend([
                        (mx+offset,my-h/2,w,h),
                        (mx-w-offset,my-h/2,w,h),
                    ])
    return candidates


def place_label(points,w,h,boxes,placed_labels,existing_routes,owner_edge_id,canvas_w,canvas_h):
    candidates=label_candidates(points,w,h)
    if not candidates:
        return (8,8,w,h)

    def score(rect):
        x,y,rw,rh=rect
        s=0.0
        if x<4 or y<4 or x+rw>canvas_w-4 or y+rh>canvas_h-4:
            s+=1_000_000
        for box in boxes.values():
            if box_overlap(rect,box):
                s+=100_000
        for other in placed_labels:
            if box_overlap(rect,other):
                s+=80_000
        for route in existing_routes:
            if route.get("id") == owner_edge_id:
                continue
            for a,b in zip(route["points"],route["points"][1:]):
                if segment_hits_box(a,b,rect,pad=1.0):
                    s+=70_000
        # Prefer compact position near center of diagram and earlier candidates.
        s+=abs((x+rw/2)-canvas_w/2)*0.02
        return s

    return min(candidates,key=score)
