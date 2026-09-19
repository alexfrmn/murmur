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
)

const iconSize = 32

var (
	colGrey   = color.NRGBA{R: 0x8a, G: 0x8a, B: 0x8e, A: 0xff}
	colYellow = color.NRGBA{R: 0xe8, G: 0xb3, B: 0x39, A: 0xff}
	colGreen  = color.NRGBA{R: 0x3f, G: 0xb9, B: 0x50, A: 0xff}
	colRed    = color.NRGBA{R: 0xd9, G: 0x3d, B: 0x3d, A: 0xff}
	colUnread = color.NRGBA{R: 0x3d, G: 0x8b, B: 0xfd, A: 0xff}
)

// disc рисует круг с мягким краем: без сглаживания значок на 32px выглядит рваным.
func disc(img *image.NRGBA, cx, cy, r float64, c color.NRGBA) {
	minX, maxX := int(cx-r-1), int(cx+r+1)
	minY, maxY := int(cy-r-1), int(cy+r+1)
	for y := minY; y <= maxY; y++ {
		for x := minX; x <= maxX; x++ {
			if x < 0 || y < 0 || x >= iconSize || y >= iconSize {
				continue
			}
			d := math.Hypot(float64(x)+0.5-cx, float64(y)+0.5-cy)
			cover := r - d + 0.5
			if cover <= 0 {
				continue
			}
			if cover > 1 {
				cover = 1
			}
			src := c
			src.A = uint8(float64(c.A) * cover)
			img.Set(x, y, blend(img.NRGBAAt(x, y), src))
		}
	}
}

func blend(dst, src color.NRGBA) color.NRGBA {
	a := float64(src.A) / 255
	out := color.NRGBA{
		R: uint8(float64(src.R)*a + float64(dst.R)*(1-a)),
		G: uint8(float64(src.G)*a + float64(dst.G)*(1-a)),
		B: uint8(float64(src.B)*a + float64(dst.B)*(1-a)),
		A: uint8(float64(src.A) + float64(dst.A)*(1-a)),
	}
	return out
}

func iconBytes(base color.NRGBA, unread bool) []byte {
	img := image.NewNRGBA(image.Rect(0, 0, iconSize, iconSize))
	disc(img, 16, 16, 12, base)
	if unread {
		// Точку непрочитанного вырезаем из основного круга кольцом фона, иначе синее
		// на зелёном читается как грязь, а не как отдельный признак.
		disc(img, 24, 24, 8, color.NRGBA{})
		clearDisc(img, 24, 24, 7.5)
		disc(img, 24, 24, 6, colUnread)
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil
	}
	return wrapICO(buf.Bytes())
}

// clearDisc обнуляет пиксели под точкой непрочитанного: blend поверх полупрозрачного
// края круга оставил бы ореол.
func clearDisc(img *image.NRGBA, cx, cy, r float64) {
	for y := 0; y < iconSize; y++ {
		for x := 0; x < iconSize; x++ {
			if math.Hypot(float64(x)+0.5-cx, float64(y)+0.5-cy) <= r {
				img.SetNRGBA(x, y, color.NRGBA{})
			}
		}
	}
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
			return fmt.Errorf("иконка %s не собралась", it.name)
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
