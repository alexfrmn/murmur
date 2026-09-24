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
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"unsafe"
)

// Read-only, label-independent probe used by the shared setup engine. It never
// opens SCM or installs, starts, stops, repairs, or creates any selected resource.
func printStoreProof(args []string) error {
	if len(args) != 1 {
		return errors.New("store.invalid-pid")
	}
	pid, err := strconv.Atoi(args[0])
	if err != nil || pid <= 0 || uint64(pid) > uint64(^uint32(0)) {
		return errors.New("store.invalid-pid")
	}
	dir := os.Getenv("DATA_DIR")
	if !filepath.IsAbs(dir) || filepath.Clean(dir) != dir {
		return errors.New("store.invalid-path")
	}
	observed, _ := observedStore(dir, pid)
	return json.NewEncoder(os.Stdout).Encode(struct {
		Schema            string  `json:"schema"`
		PID               int     `json:"pid"`
		ObservedStorePath *string `json:"observedStorePath"`
	}{"murmur.store-proof/1", pid, orNil(observed)})
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
	if r, _, err := procRmStartSession.Call(uintptr(unsafe.Pointer(&session)), 0,
		uintptr(unsafe.Pointer(&key[0]))); r != 0 {
		return nil, err
	}
	defer procRmEndSession.Call(uintptr(session))

	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	files := []*uint16{p}
	if r, _, err := procRmRegisterResrc.Call(uintptr(session), 1,
		uintptr(unsafe.Pointer(&files[0])), 0, 0, 0, 0); r != 0 {
		return nil, err
	}

	var needed, count, reason uint32
	count = 0
	r, _, _ := procRmGetList.Call(uintptr(session), uintptr(unsafe.Pointer(&needed)),
		uintptr(unsafe.Pointer(&count)), 0, uintptr(unsafe.Pointer(&reason)))
	if r != errorMoreData || needed == 0 {
		return nil, nil
	}
	infos := make([]rmProcessInfo, needed)
	count = needed
	if r, _, err := procRmGetList.Call(uintptr(session), uintptr(unsafe.Pointer(&needed)),
		uintptr(unsafe.Pointer(&count)), uintptr(unsafe.Pointer(&infos[0])),
		uintptr(unsafe.Pointer(&reason))); r != 0 {
		return nil, err
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
