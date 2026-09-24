package main

// ICO-иконки собираются в рантайме, поэтому в репозитории нет ни одного бинарного
// файла: ревью читает правило раскраски, а не diff картинки. Windows понимает PNG
// внутри ICO начиная с Vista, так что достаточно PNG-кадра и 22-байтового заголовка.

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"sync"
)

const iconSize = 32

var (
	colGrey   = color.NRGBA{R: 0x8a, G: 0x8a, B: 0x8e, A: 0xff}
	colYellow = color.NRGBA{R: 0xe8, G: 0xb3, B: 0x39, A: 0xff}
	colGreen  = color.NRGBA{R: 0x3f, G: 0xb9, B: 0x50, A: 0xff}
	colRed    = color.NRGBA{R: 0xd9, G: 0x3d, B: 0x3d, A: 0xff}
	colUnread = color.NRGBA{R: 0x3d, G: 0x8b, B: 0xfd, A: 0xff}
)

// Geometry and colours are generated from contracts/visual/murmur-mark.svg.
//
//go:generate python3 ../../scripts/generate-windows-mark.py
type markPrimitive struct {
	kind        string
	values      [6]float64
	first, last color.NRGBA
}

func (p markPrimitive) contains(x, y float64) bool {
	v := p.values
	switch p.kind {
	case "circle":
		dx, dy := x-v[0], y-v[1]
		return dx*dx+dy*dy <= v[2]*v[2]
	case "rect":
		qx := math.Abs(x-(v[0]+v[2]/2)) - (v[2]/2 - v[4])
		qy := math.Abs(y-(v[1]+v[3]/2)) - (v[3]/2 - v[4])
		return math.Hypot(math.Max(qx, 0), math.Max(qy, 0))+math.Min(math.Max(qx, qy), 0) <= v[4]
	case "line":
		if x < math.Min(v[0], v[2])-v[4]/2 || x > math.Max(v[0], v[2])+v[4]/2 || y < math.Min(v[1], v[3])-v[4]/2 || y > math.Max(v[1], v[3])+v[4]/2 {
			return false
		}
		dx, dy := v[2]-v[0], v[3]-v[1]
		length := dx*dx + dy*dy
		t := 0.0
		if length > 0 {
			t = math.Max(0, math.Min(1, ((x-v[0])*dx+(y-v[1])*dy)/length))
		}
		px, py := x-v[0]-t*dx, y-v[1]-t*dy
		return px*px+py*py <= v[4]*v[4]/4
	}
	return false
}

func (p markPrimitive) ink(x, y float64) color.NRGBA {
	if p.first == p.last {
		return p.first
	}
	// The schema's two-stop diagonal circle gradients use objectBoundingBox.
	v := p.values
	t := math.Max(0, math.Min(1, (x+y-(v[0]+v[1]-2*v[2]))/(4*v[2])))
	channel := func(a, b uint8) uint8 { return uint8(math.Round(float64(a)*(1-t) + float64(b)*t)) }
	return color.NRGBA{channel(p.first.R, p.last.R), channel(p.first.G, p.last.G), channel(p.first.B, p.last.B), 255}
}

func rasterMark(shapes []markPrimitive) *image.NRGBA {
	const samples = 8
	img := image.NewNRGBA(image.Rect(0, 0, iconSize, iconSize))
	for y := 0; y < iconSize; y++ {
		for x := 0; x < iconSize; x++ {
			count, r, g, b := 0, 0, 0, 0
			for sy := 0; sy < samples; sy++ {
				for sx := 0; sx < samples; sx++ {
					px := (float64(x) + (float64(sx)+0.5)/samples) * markViewBox / iconSize
					py := (float64(y) + (float64(sy)+0.5)/samples) * markViewBox / iconSize
					// All schema2 paints are opaque; the last covering primitive wins. Sampling
					// the complete composition avoids seams at adjacent flattened curve pieces.
					for i := len(shapes) - 1; i >= 0; i-- {
						if shapes[i].contains(px, py) {
							ink := shapes[i].ink(px, py)
							count++
							r += int(ink.R)
							g += int(ink.G)
							b += int(ink.B)
							break
						}
					}
				}
			}
			if count > 0 {
				img.SetNRGBA(x, y, color.NRGBA{uint8(r / count), uint8(g / count), uint8(b / count), uint8((count*255 + samples*samples/2) / (samples * samples))})
			}
		}
	}
	return img
}

func renderMark(base color.NRGBA, unread, updateAvailable bool) *image.NRGBA {
	name := "idle"
	switch base {
	case colYellow:
		name = "attention"
	case colRed:
		name = "failed"
	case colGreen:
		name = "ready"
	case colUnread:
		name = "unread"
	}
	if unread && name == "ready" {
		name = "unread"
	}
	shapes := markShapes[name]
	if unread && name != "unread" {
		// Unread never turns a failed/offline channel into a ready one.
		shapes = append(append([]markPrimitive{}, shapes...), markShapes["unread-overlay"]...)
	}
	img := rasterMark(shapes)
	if updateAvailable {
		paintUpdateBadge(img)
	}
	return img
}

func paintUpdateBadge(img *image.NRGBA) {
	// This separate release arrow occupies the lower-right corner, clear of the
	// shared lock, waves and upper-right unread signal. It is not geometry
	// copied from the product mark and never replaces a health state.
	const cx, cy, r = 26.0, 26.0, 5.0
	for y := 20; y < 32; y++ {
		for x := 20; x < 32; x++ {
			d := math.Hypot(float64(x)+0.5-cx, float64(y)+0.5-cy)
			if d <= r+0.75 {
				img.SetNRGBA(x, y, color.NRGBA{})
			}
			a := math.Max(0, math.Min(1, r-d+0.5))
			if a > 0 {
				img.SetNRGBA(x, y, color.NRGBA{R: 0x84, G: 0x50, B: 0xcf, A: uint8(math.Round(a * 255))})
			}
		}
	}
	for y := 23; y <= 28; y++ {
		for x := 23; x <= 28; x++ {
			if (x >= 25 && x <= 26 && y >= 24) || (y <= 25 && math.Abs(float64(x)-25.5) <= float64(y-22)) {
				img.SetNRGBA(x, y, color.NRGBA{255, 255, 255, 255})
			}
		}
	}
}

type iconKey struct {
	state          byte
	unread, update bool
}

var iconCache sync.Map

func iconBytes(base color.NRGBA, unread bool, updateAvailable ...bool) []byte {
	state := byte(0)
	switch base {
	case colYellow:
		state = 4
	case colRed:
		state = 1
	case colGreen:
		state = 2
	case colUnread:
		state = 3
	}
	key := iconKey{state, unread, len(updateAvailable) > 0 && updateAvailable[0]}
	if value, ok := iconCache.Load(key); ok {
		return value.([]byte)
	}
	img := renderMark(base, unread, key.update)
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil
	}
	result := wrapICO(buf.Bytes())
	actual, _ := iconCache.LoadOrStore(key, result)
	return actual.([]byte)
}

func wrapICO(pngData []byte) []byte {
	var out bytes.Buffer
	binary.Write(&out, binary.LittleEndian, uint16(0))            // reserved
	binary.Write(&out, binary.LittleEndian, uint16(1))            // type: icon
	binary.Write(&out, binary.LittleEndian, uint16(1))            // count
	out.WriteByte(iconSize)                                       // width
	out.WriteByte(iconSize)                                       // height
	out.WriteByte(0)                                              // palette
	out.WriteByte(0)                                              // reserved
	binary.Write(&out, binary.LittleEndian, uint16(1))            // planes
	binary.Write(&out, binary.LittleEndian, uint16(32))           // bpp
	binary.Write(&out, binary.LittleEndian, uint32(len(pngData))) // size
	binary.Write(&out, binary.LittleEndian, uint32(22))           // offset
	out.Write(pngData)
	return out.Bytes()
}

// dumpIcons кладёт состояния значка на диск: .ico для Windows и .png тем же кадром,
// чтобы картинку можно было открыть где угодно.
func dumpIcons(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	set := []struct {
		name   string
		col    color.NRGBA
		unread bool
	}{
		{"grey", colGrey, false},
		{"yellow", colYellow, false},
		{"green", colGreen, false},
		{"red", colRed, false},
		{"green-unread", colGreen, true},
	}
	for _, it := range set {
		ico := iconBytes(it.col, it.unread)
		if ico == nil {
			return fmt.Errorf("%s", tr("icons.failed", it.name))
		}
		if err := os.WriteFile(filepath.Join(dir, it.name+".ico"), ico, 0o644); err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(dir, it.name+".png"), ico[22:], 0o644); err != nil {
			return err
		}
	}
	return nil
}
