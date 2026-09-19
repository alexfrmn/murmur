//go:build darwin

// Review-only Mac entrypoint over the unchanged Windows spike's model/icons.
// No CLI calls, service changes, or claims of Murmur readiness.
package main

import (
    "errors"
    "fmt"
    "fyne.io/systray"
)

func main() {
    systray.Run(func() {
        ico := iconBytes(colGrey, false)
        if len(ico) <= 22 { panic("icon generation failed") }
        systray.SetIcon(ico[22:]) // Common generator embeds a PNG after the ICO header.
        systray.SetTitle("Murmur Shared Go")
        verdict := resolve(nil, errors.New("Mac smoke — no runtime connection"))
        systray.SetTooltip(verdict.Reason)
        item := systray.AddMenuItem("Mac smoke: общая модель и fyne/systray", "Read-only UI smoke")
        item.Disable()
        quit := systray.AddMenuItem("Выход", "Quit smoke")
        go func() { <-quit.ClickedCh; systray.Quit() }()
        fmt.Println("SHARED_GO_DARWIN_READY")
    }, func() { fmt.Println("SHARED_GO_DARWIN_EXIT") })
}
