// Minimal macOS smoke for the shared Windows/macOS Go tray candidate.
// It performs no Murmur operations and claims no runtime health.
package main

import (
    "bytes"
    "fmt"
    "image"
    "image/color"
    "image/png"

    "github.com/getlantern/systray"
)

func main() {
    systray.Run(onReady, func() { fmt.Println("MURMUR_GO_SMOKE_EXIT") })
}

func onReady() {
    icon := image.NewRGBA(image.Rect(0, 0, 32, 32))
    for y := 0; y < 32; y++ {
        for x := 0; x < 32; x++ {
            if (x-16)*(x-16)+(y-16)*(y-16) < 12*12 {
                icon.SetRGBA(x, y, color.RGBA{R: 108, G: 79, B: 217, A: 255})
            }
        }
    }
    var buffer bytes.Buffer
    if err := png.Encode(&buffer, icon); err != nil { panic(err) }
    systray.SetIcon(buffer.Bytes())
    systray.SetTitle("Murmur Go")
    systray.SetTooltip("Murmur — Go smoke, no runtime connection")
    header := systray.AddMenuItem("Murmur Go — проверка сборки", "No Murmur data")
    header.Disable()
    unknown := systray.AddMenuItem("Состояние агента не проверяется", "This is a UI smoke")
    unknown.Disable()
    systray.AddSeparator()
    quit := systray.AddMenuItem("Выход", "Quit smoke app")
    go func() { <-quit.ClickedCh; systray.Quit() }()
    fmt.Println("MURMUR_GO_SMOKE_READY")
}
