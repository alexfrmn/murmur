package main

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"image"
	"image/color"
	"os"
	"testing"
)

func TestSharedMarkSourceIsExactlyTheGeneratedInput(t *testing.T) {
	data, err := os.ReadFile("../../contracts/visual/murmur-mark.svg")
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprintf("%x", sha256.Sum256(data)) != markSourceSHA256 {
		t.Fatal("shared SVG changed; regenerate Windows mark")
	}
	if len(markShapes) != 5 || len(markShapes["unread-overlay"]) != 2 {
		t.Fatal("four source states and outlined unread signal required")
	}
}
func pixelCounts(img *image.NRGBA) (bright, red, visible int) {
	for y := 0; y < iconSize; y++ {
		for x := 0; x < iconSize; x++ {
			c := img.NRGBAAt(x, y)
			if c.A < 128 {
				continue
			}
			visible++
			if c.R >= 220 && c.G >= 220 && c.B >= 220 {
				bright++
			}
			if int(c.R) > int(c.G)*2 && int(c.R) > int(c.B)*2 {
				red++
			}
		}
	}
	return
}
func TestLogoHasVisibleWavesLockAndIndependentState(t *testing.T) {
	for _, tc := range []struct {
		name           string
		base           color.NRGBA
		unread         bool
		redMin, redMax int
	}{{"idle", colGrey, false, 0, 0}, {"ready", colGreen, false, 0, 0}, {"unread", colGreen, true, 60, 150}, {"failed", colRed, false, 500, 900}} {
		t.Run(tc.name, func(t *testing.T) {
			img := renderMark(tc.base, tc.unread, false)
			bright, red, visible := pixelCounts(img)
			if bright < 60 || red < tc.redMin || red > tc.redMax || visible < 700 {
				t.Fatalf("bright=%d red=%d visible=%d", bright, red, visible)
			}
			// One pixel in each wave and the lock body. A filled background alone must
			// fail, even if its colour or total alpha looked correct.
			for _, p := range [][2]int{{9, 10}, {19, 12}, {16, 18}} {
				c := img.NRGBAAt(p[0], p[1])
				if c.R < 210 || c.G < 210 || c.B < 210 {
					t.Fatalf("glyph disappeared at %v: %v", p, c)
				}
			}
			t.Logf("bright=%d red=%d visible=%d", bright, red, visible)
		})
	}
	if !bytes.Equal(iconBytes(colGrey, false), iconBytes(colYellow, false)) {
		t.Fatal("schema2 idle mapping differs for grey/yellow")
	}
}
func TestIndependentSignalsPreserveHealthAndLogo(t *testing.T) {
	for _, base := range []color.NRGBA{colGrey, colYellow, colGreen, colRed} {
		plain := renderMark(base, true, false)
		updated := renderMark(base, true, true)
		for y := 0; y < 20; y++ {
			for x := 0; x < 32; x++ {
				if plain.NRGBAAt(x, y) != updated.NRGBAAt(x, y) {
					t.Fatal("update erased unread/waves/lock")
				}
			}
		}
	}
	img := renderMark(colRed, true, true)
	c := img.NRGBAAt(6, 20)
	if c.R <= 2*c.G {
		t.Fatal("unread replaced failed health")
	}
}
func TestDumpMarkAcceptance(t *testing.T) {
	dir := os.Getenv("MURMUR_MARK_PROOF_DIR")
	if dir == "" {
		t.Skip("optional review artifact directory not requested")
	}
	if err := dumpIcons(dir); err != nil {
		t.Fatal(err)
	}
}
