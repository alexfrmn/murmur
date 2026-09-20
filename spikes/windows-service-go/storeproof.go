//go:build windows

package main

// Доказательство того, какое хранилище демон держит открытым.
//
// Правило, ради которого этот файл существует: путь хранилища заполняется **только
// фактическим свидетельством**. Описание запуска и переменные окружения говорят, чего мы
// просили, а не что получилось; вывести из них «демон работает с этим store» значит
// повторить ту же болезнь, которую мы весь день выкапываем.
//
// Свидетельство берётся у диспетчера перезапуска Windows (Restart Manager): он отвечает,
// какие процессы держат файл открытым. Совпал pid нашего демона — значит он и держит.

import (
	"fmt"
	"path/filepath"
	"syscall"
	"unsafe"
)

func initialHolderListSize(result uintptr, needed uint32) (uint32, bool, error) {
	switch result {
	case 0:
		if needed != 0 {
			return 0, false, fmt.Errorf("restart-manager returned success with an unexpected holder count")
		}
		return 0, true, nil
	case errorMoreData:
		if needed == 0 {
			return 0, false, fmt.Errorf("restart-manager requested an empty holder buffer")
		}
		return needed, false, nil
	default:
		return 0, false, syscall.Errno(result)
	}
}

var (
	rstrtmgr             = syscall.NewLazyDLL("rstrtmgr.dll")
	procRmStartSession   = rstrtmgr.NewProc("RmStartSession")
	procRmRegisterResrc  = rstrtmgr.NewProc("RmRegisterResources")
	procRmGetList        = rstrtmgr.NewProc("RmGetList")
	procRmEndSession     = rstrtmgr.NewProc("RmEndSession")
	errorMoreData        = uintptr(234)
	cchRmSessionKeyChars = 32
)

type rmUniqueProcess struct {
	ProcessID        uint32
	ProcessStartTime syscall.Filetime
}

type rmProcessInfo struct {
	Process          rmUniqueProcess
	AppName          [256]uint16
	ServiceShortName [64]uint16
	ApplicationType  uint32
	AppStatus        uint32
	TSSessionID      uint32
	Restartable      int32
}

// holdersOf возвращает pid процессов, держащих файл открытым.
func holdersOf(path string) ([]uint32, error) {
	var session uint32
	key := make([]uint16, cchRmSessionKeyChars+1)
	if r, _, _ := procRmStartSession.Call(uintptr(unsafe.Pointer(&session)), 0,
		uintptr(unsafe.Pointer(&key[0]))); r != 0 {
		return nil, syscall.Errno(r)
	}
	defer procRmEndSession.Call(uintptr(session))

	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	files := []*uint16{p}
	if r, _, _ := procRmRegisterResrc.Call(uintptr(session), 1,
		uintptr(unsafe.Pointer(&files[0])), 0, 0, 0, 0); r != 0 {
		return nil, syscall.Errno(r)
	}

	var needed, count, reason uint32
	count = 0
	r, _, _ := procRmGetList.Call(uintptr(session), uintptr(unsafe.Pointer(&needed)),
		uintptr(unsafe.Pointer(&count)), 0, uintptr(unsafe.Pointer(&reason)))
	size, empty, err := initialHolderListSize(r, needed)
	if err != nil {
		return nil, err
	}
	if empty {
		if reason != 0 {
			return nil, fmt.Errorf("restart-manager reported reboot reason %#x without a holder", reason)
		}
		return nil, nil
	}
	infos := make([]rmProcessInfo, size)
	count = size
	if r, _, _ := procRmGetList.Call(uintptr(session), uintptr(unsafe.Pointer(&needed)),
		uintptr(unsafe.Pointer(&count)), uintptr(unsafe.Pointer(&infos[0])),
		uintptr(unsafe.Pointer(&reason))); r != 0 {
		return nil, syscall.Errno(r)
	}
	if count > uint32(len(infos)) {
		return nil, fmt.Errorf("restart-manager returned more holders than the supplied buffer")
	}
	if count == 0 && reason != 0 {
		return nil, fmt.Errorf("restart-manager reported reboot reason %#x without a holder", reason)
	}
	pids := make([]uint32, 0, count)
	for i := uint32(0); i < count; i++ {
		pids = append(pids, infos[i].Process.ProcessID)
	}
	return pids, nil
}

// observedStore отвечает на вопрос «какое хранилище демон держит открытым сейчас».
// Возвращает пустую строку и причину, когда доказательства нет: догадка здесь хуже
// молчания, потому что именно её потом прочитают как измеренный факт.
func observedStore(dataDir string, daemonPID int) (string, string) {
	if dataDir == "" {
		return "", tr("store.missingData")
	}
	if daemonPID <= 0 {
		return "", tr("store.noDaemon")
	}
	store := filepath.Join(dataDir, "murmur.db")
	pids, err := holdersOf(store)
	if err != nil {
		return "", tr("store.manager", err)
	}
	for _, pid := range pids {
		if int(pid) == daemonPID {
			return store, ""
		}
	}
	if len(pids) == 0 {
		return "", tr("store.noHolder")
	}
	return "", tr("store.otherHolder")
}
