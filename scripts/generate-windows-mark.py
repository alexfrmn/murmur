#!/usr/bin/env python3
"""Compile the shared SVG subset into Go draw primitives; no runtime SVG dependency.

Reject unsupported syntax instead of approximating a newly changed design silently.
Quadratic curves use 32 equal parameter steps (subpixel error at tray sizes).
"""
import argparse
import hashlib
import json
import math
import pathlib
import re
import subprocess
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'contracts/visual/murmur-mark.svg'
OUTPUT = ROOT / 'spikes/windows-tray-go/mark_generated.go'
NS = '{http://www.w3.org/2000/svg}'
NUMBER = r'[-+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)'


def number(value):
    if not re.fullmatch(NUMBER, value):
        raise ValueError('invalid geometry number: ' + value)
    result = float(value)
    if not math.isfinite(result):
        raise ValueError('nonfinite geometry')
    return result


def segments(data):
    tokens = re.findall(r'[MQVH]|' + NUMBER, data)
    if ''.join(tokens) != re.sub(r'[\s,]', '', data):
        raise ValueError('unsupported path syntax: ' + data)
    x = y = 0.0
    result = []
    while tokens:
        command = tokens.pop(0)
        if command == 'M':
            x, y = number(tokens.pop(0)), number(tokens.pop(0))
        elif command in ('V', 'H'):
            n = number(tokens.pop(0))
            xx, yy = (n, y) if command == 'H' else (x, n)
            result.append([x, y, xx, yy])
            x, y = xx, yy
        elif command == 'Q':
            cx, cy, ex, ey = [number(tokens.pop(0)) for _ in range(4)]
            start_x, start_y = x, y
            for step in range(1, 33):
                t = step / 32
                xx = (1-t)**2*start_x + 2*(1-t)*t*cx + t*t*ex
                yy = (1-t)**2*start_y + 2*(1-t)*t*cy + t*t*ey
                result.append([x, y, xx, yy])
                x, y = xx, yy
        else:
            raise ValueError('path requires explicit supported commands')
    return result


def rgba(value):
    if re.fullmatch(r'#[0-9a-fA-F]{3}', value):
        value = '#' + ''.join(c*2 for c in value[1:])
    if not re.fullmatch(r'#[0-9a-fA-F]{6}', value):
        raise ValueError('unsupported colour: ' + value)
    return [int(value[i:i+2], 16) for i in (1, 3, 5)] + [255]


def compile_source(data):
    root = ET.fromstring(data)
    if root.attrib.get('viewBox') != '0 0 120 120' or root.attrib.get('data-schema') != 'murmur.mark/2':
        raise ValueError('unsupported shared mark schema or viewBox')
    nodes = {}
    allowed_tags = {'svg','title','defs','linearGradient','stop','g','path','rect','circle','symbol','use'}
    for node in root.iter():
        if node.tag.removeprefix(NS) not in allowed_tags:
            raise ValueError('unsupported SVG element: '+node.tag)
        if 'id' in node.attrib:
            if node.attrib['id'] in nodes: raise ValueError('duplicate SVG ID')
            nodes[node.attrib['id']] = node
    gradients = {}
    for node in root.iter(NS+'linearGradient'):
        if {k: node.get(k) for k in ('x1','y1','x2','y2')} != dict(x1='0%',y1='0%',x2='100%',y2='100%'):
            raise ValueError('unsupported gradient direction')
        if set(node.attrib) - {'id','x1','y1','x2','y2'}:
            raise ValueError('unsupported gradient attribute')
        stops = list(node)
        if any(stop.tag != NS+'stop' or set(stop.attrib) != {'offset','stop-color'} for stop in stops):
            raise ValueError('unsupported gradient stop')
        if len(stops) != 2 or [s.get('offset') for s in stops] != ['0%', '100%']:
            raise ValueError('unsupported gradient stops')
        gradients[node.get('id')] = [rgba(s.attrib['stop-color']) for s in stops]

    def style(fill):
        if fill.startswith('url(#') and fill.endswith(')'):
            return gradients[fill[5:-1]]
        c = rgba(fill)
        return [c, c]

    def draw(node, stack=()):
        kind = node.tag.removeprefix(NS)
        attr = node.attrib
        if kind in ('g', 'symbol'):
            allowed = {'id'} if kind == 'g' else {'id', 'viewBox'}
            if set(attr) - allowed:
                raise ValueError('unsupported drawing container attribute')
            return [shape for child in node for shape in draw(child, stack)]
        if kind == 'use':
            if set(attr) - {'href'} or not attr.get('href','').startswith('#'):
                raise ValueError('only local untransformed uses are supported')
            name = attr['href'][1:]
            if name in stack: raise ValueError('cyclic use')
            return draw(nodes[name], (*stack, name))
        allowed = {'fill','stroke','stroke-width','stroke-linecap','data-overlay'} | {
            'circle': {'cx','cy','r'}, 'rect': {'x','y','width','height','rx'}, 'path': {'d'}
        }[kind]
        if set(attr) - allowed: raise ValueError('unsupported drawing attribute')
        shapes = []
        if kind == 'circle':
            x,y,r = [number(attr[k]) for k in ('cx','cy','r')]
            if attr.get('stroke'):
                # Paint the outer stroke first, then the fill. No transparent
                # fills are used in this source, so this is equivalent to SVG.
                a,b = style(attr['stroke'])
                shapes.append(('circle',[x,y,r+number(attr['stroke-width'])/2],a,b))
            a,b = style(attr['fill'])
            shapes.append(('circle',[x,y,r-number(attr.get('stroke-width','0'))/2],a,b))
        elif kind == 'rect':
            if attr.get('stroke'): raise ValueError('unsupported rectangle stroke')
            a,b = style(attr['fill'])
            shapes.append(('rect',[number(attr[k]) for k in ('x','y','width','height','rx')],a,b))
        elif kind == 'path':
            if attr.get('fill') != 'none' or attr.get('stroke-linecap') != 'round':
                raise ValueError('expected unfilled round-cap path')
            a,b = style(attr['stroke'])
            shapes.extend(('line',line+[number(attr['stroke-width'])],a,b) for line in segments(attr['d']))
        return shapes

    marks = {}
    for name in ('ready','idle','unread','failed'):
        symbol = nodes['murmur-'+name]
        if symbol.tag != NS+'symbol' or symbol.get('viewBox') != '0 0 120 120':
            raise ValueError('invalid state symbol')
        marks[name] = draw(symbol)
    overlays = [node for node in nodes['murmur-unread'] if node.get('data-overlay') == 'unread']
    if len(overlays) != 1: raise ValueError('one explicit unread overlay required')
    marks['unread-overlay'] = draw(overlays[0])
    return marks


def generate():
    data = SOURCE.read_bytes()
    marks = compile_source(data)
    lines = ['// Code generated by scripts/generate-windows-mark.py; DO NOT EDIT.', 'package main', 'import "image/color"',
             'const markSourceSHA256 = "'+hashlib.sha256(data).hexdigest()+'"',
             'const markViewBox = 120.0', 'var markShapes = map[string][]markPrimitive{']
    for name, shapes in sorted(marks.items()):
        lines.append(json.dumps(name)+': {')
        for kind, values, ink1, ink2 in shapes:
            v = ','.join(format(n,'.12g') for n in values)
            c1,c2 = [','.join(map(str,c)) for c in (ink1,ink2)]
            lines.append('{kind:"'+kind+'",values:[6]float64{'+v+'},first:color.NRGBA{'+c1+'},last:color.NRGBA{'+c2+'}},')
        lines.append('},')
    lines.append('}\n')
    return subprocess.run(['gofmt'],input='\n'.join(lines),text=True,check=True,capture_output=True).stdout


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--check',action='store_true')
    args = parser.parse_args()
    result = generate()
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_text() != result:
            raise SystemExit('Windows mark is stale; run python3 scripts/generate-windows-mark.py')
        print('Windows mark matches the shared SVG')
    else:
        OUTPUT.write_text(result)
