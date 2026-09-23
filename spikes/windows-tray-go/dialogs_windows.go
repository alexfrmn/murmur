//go:build windows

package main

import (
	"os/exec"
	"runtime"
	"syscall"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

// openFileName mirrors OPENFILENAMEW; x/sys/windows has no common dialog bindings.
type openFileName struct {
	structSize      uint32
	owner           windows.Handle
	instance        windows.Handle
	filter          *uint16
	customFilter    *uint16
	maxCustomFilter uint32
	filterIndex     uint32
	file            *uint16
	maxFile         uint32
	fileTitle       *uint16
	maxFileTitle    uint32
	initialDir      *uint16
	title           *uint16
	flags           uint32
	fileOffset      uint16
	fileExtension   uint16
	defaultExt      *uint16
	customData      uintptr
	hook            uintptr
	templateName    *uint16
	reserved        uintptr
	reservedValue   uint32
	flagsEx         uint32
}

var (
	comdlg32         = windows.NewLazySystemDLL("comdlg32.dll")
	procGetOpenFile  = comdlg32.NewProc("GetOpenFileNameW")
	procGetSaveFile  = comdlg32.NewProc("GetSaveFileNameW")
	user32           = windows.NewLazySystemDLL("user32.dll")
	procOpenClip     = user32.NewProc("OpenClipboard")
	procEmptyClip    = user32.NewProc("EmptyClipboard")
	procSetClipData  = user32.NewProc("SetClipboardData")
	procCloseClip    = user32.NewProc("CloseClipboard")
	kernel32         = windows.NewLazySystemDLL("kernel32.dll")
	procGlobalAlloc  = kernel32.NewProc("GlobalAlloc")
	procGlobalLock   = kernel32.NewProc("GlobalLock")
	procGlobalUnlock = kernel32.NewProc("GlobalUnlock")
	procMoveMemory   = kernel32.NewProc("RtlMoveMemory")
)

const (
	ofnHideReadOnly    = 0x4
	ofnNoChangeDir     = 0x8
	ofnPathMustExist   = 0x800
	ofnFileMustExist   = 0x1000
	ofnDontAddToRecent = 0x2000000
)

// fileDialog shows the standard Windows Open or Save dialog on a locked OS thread.
func fileDialog(save bool, title, suggested string) (string, bool) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	buf := make([]uint16, 32768)
	copy(buf, windows.StringToUTF16(suggested))
	// Pairs separated and ended by NUL, the list ended by a second NUL; StringToUTF16 rejects NULs.
	filter := append(utf16.Encode([]rune(tr("dialog.filterText")+"\x00*.txt\x00"+tr("dialog.filterAll")+"\x00*.*\x00")), 0)
	titlePtr, _ := windows.UTF16PtrFromString(title)
	ext, _ := windows.UTF16PtrFromString("txt")
	o := openFileName{filter: &filter[0], filterIndex: 1, file: &buf[0], maxFile: uint32(len(buf)), title: titlePtr, defaultExt: ext,
		flags: ofnHideReadOnly | ofnNoChangeDir | ofnPathMustExist | ofnDontAddToRecent}
	o.structSize = uint32(unsafe.Sizeof(o))
	proc := procGetOpenFile
	if save {
		// No overwrite prompt: an existing reply is refused by the flow, which asks for another name.
		proc = procGetSaveFile
	} else {
		o.flags |= ofnFileMustExist
	}
	if ok, _, _ := proc.Call(uintptr(unsafe.Pointer(&o))); ok == 0 {
		return "", false
	}
	return windows.UTF16ToString(buf), true
}

func askYesNo(title, text string) bool {
	t, _ := windows.UTF16PtrFromString(title)
	b, _ := windows.UTF16PtrFromString(text)
	r, _ := windows.MessageBox(0, b, t, windows.MB_YESNO|windows.MB_ICONQUESTION|windows.MB_SETFOREGROUND)
	return r == 6 // IDYES
}

func tell(title, text string) {
	t, _ := windows.UTF16PtrFromString(title)
	b, _ := windows.UTF16PtrFromString(text)
	_, _ = windows.MessageBox(0, b, t, windows.MB_OK|windows.MB_ICONINFORMATION|windows.MB_SETFOREGROUND)
}

// revealAndCopy selects the reply in Explorer, ready to drag into a messenger, and copies its path.
func revealAndCopy(path string) {
	if dir, err := windows.GetWindowsDirectory(); err == nil {
		cmd := exec.Command(dir + `\explorer.exe`)
		cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `explorer.exe /select,"` + path + `"`}
		_ = cmd.Start()
	}
	_ = textToClipboard(path)
}

func textToClipboard(text string) error {
	data := windows.StringToUTF16(text)
	if ok, _, err := procOpenClip.Call(0); ok == 0 {
		return err
	}
	defer procCloseClip.Call()
	procEmptyClip.Call()
	const gmemMoveable, cfUnicodeText = 0x0002, 13
	handle, _, err := procGlobalAlloc.Call(gmemMoveable, uintptr(len(data)*2))
	if handle == 0 {
		return err
	}
	target, _, err := procGlobalLock.Call(handle)
	if target == 0 {
		return err
	}
	procMoveMemory.Call(target, uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)*2))
	procGlobalUnlock.Call(handle)
	if ok, _, err := procSetClipData.Call(cfUnicodeText, handle); ok == 0 {
		return err
	}
	return nil
}

func desktopFolder() string {
	if path, err := windows.KnownFolderPath(windows.FOLDERID_Desktop, 0); err == nil {
		return path
	}
	return ""
}

// browseInfo mirrors BROWSEINFOW.
type browseInfo struct {
	owner       windows.Handle
	root        uintptr
	displayName *uint16
	title       *uint16
	flags       uint32
	callback    uintptr
	param       uintptr
	image       int32
}

var (
	shell32            = windows.NewLazySystemDLL("shell32.dll")
	procBrowseFolder   = shell32.NewProc("SHBrowseForFolderW")
	procPathFromIDList = shell32.NewProc("SHGetPathFromIDListW")
	procTaskMemFree    = windows.NewLazySystemDLL("ole32.dll").NewProc("CoTaskMemFree")
)

// folderDialog picks an existing folder; only the expert "Open an existing profile…" uses it.
func folderDialog(title string) (string, bool) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := windows.CoInitializeEx(0, windows.COINIT_APARTMENTTHREADED); err == nil {
		defer windows.CoUninitialize()
	}
	const returnOnlyFSDirs, newDialogStyle, noNewFolder = 0x1, 0x40, 0x200
	name := make([]uint16, windows.MAX_PATH)
	titlePtr, _ := windows.UTF16PtrFromString(title)
	info := browseInfo{displayName: &name[0], title: titlePtr, flags: returnOnlyFSDirs | newDialogStyle | noNewFolder}
	pidl, _, _ := procBrowseFolder.Call(uintptr(unsafe.Pointer(&info)))
	if pidl == 0 {
		return "", false
	}
	defer procTaskMemFree.Call(pidl)
	path := make([]uint16, 32768)
	if ok, _, _ := procPathFromIDList.Call(pidl, uintptr(unsafe.Pointer(&path[0]))); ok == 0 {
		return "", false
	}
	return windows.UTF16ToString(path), true
}
