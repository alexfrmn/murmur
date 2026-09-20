//go:build windows

package main

// murmur-svc — адаптер службы Windows для демона Murmur.
//
// Зачем он существует. Демон это node-процесс, а диспетчер служб Windows умеет
// запускать только программу, которая отвечает ему на управляющие сообщения. node.exe
// на них не отвечает, поэтому между SCM и демоном нужен хост — ровно то, чем для чужих
// программ служит NSSM. Здесь он свой, потому что должен отдавать наружу то, чего
// задача Планировщика не отдаёт: состояние, pid, код выхода и число перезапусков.
//
// CLI движка (murmur service install|start|stop|status) зовёт этот бинарь; сам он в
// протокол Murmur не лезет и про NATS ничего не знает.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

const (
	defaultServiceName = "MurmurDaemon"

	// Пауза перед перезапуском упавшего демона растёт до потолка: демон, падающий
	// из-за отозванного токена, не чинится частыми перезапусками и не должен молотить
	// брокер.
	restartDelayMin = 2 * time.Second
	restartDelayMax = 60 * time.Second
	// Прожил дольше — запуск считается удачным и пауза сбрасывается.
	healthyRun = 30 * time.Second
	// Подъёмов за час, после которых это падение по кругу, а не работа. Значение по
	// умолчанию; настоящее приходит из описания запуска, то есть из ответа движка.
	restartsPerHourDefault = 5

	// Сколько ждать устойчивого Running при установке и старте.
	startTimeout = 20 * time.Second
	// Сколько демон обязан прожить, чтобы установка назвала себя удавшейся.
	settleTime = 6 * time.Second
)

// runtimeName — имя, под которым служба зарегистрирована в SCM. Диспетчер запускает
// процесс без пользовательского окружения, поэтому имя приходит аргументом командной
// строки, заданным при установке: переменные среды сюда не доезжают.
var runtimeName string

func svcName() string {
	if runtimeName != "" {
		return runtimeName
	}
	if n := os.Getenv("MURMUR_SERVICE_NAME"); n != "" {
		return n
	}
	return defaultServiceName
}

func main() {
	if nativeVersionRequested(os.Args[1:]) {
		if err := writeNativeVersion(os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	options, parseErr := parseHelperArguments(os.Args[1:])
	setLocale(options.locale)
	if parseErr != nil {
		fail("%v", parseErr)
	}
	args := options.positionals
	isService, err := svc.IsWindowsService()
	if err != nil {
		fail("%s", tr("error.mode", err))
	}
	if isService {
		// SCM передаёт «run <имя>» из ImagePath. Без этого svc.Run получил бы имя по
		// умолчанию, диспетчер отверг бы подключение, и служба молча не стартовала бы.
		// Сверяем исходные аргументы: языковой флаг намеренно не входит в доверенную
		// строку SCM, поэтому фоновый журнал всегда остаётся английским.
		if len(os.Args) == 3 && os.Args[1] == "run" {
			runtimeName = os.Args[2]
		}
		mustDo(validateServiceName(svcName()))
		mustDo(svc.Run(svcName(), &daemonHost{}))
		return
	}
	if len(args) < 1 {
		usage()
		os.Exit(2)
	}
	mustDo(validateServiceName(svcName()))
	switch args[0] {
	case "install":
		mustDo(install())
	case "uninstall":
		mustDo(uninstall())
	case "start":
		mustDo(startAndVerify())
	case "stop":
		mustDo(stop())
	case "status":
		mustDo(printStatus())
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, tr("usage.line"))
	fmt.Fprintln(os.Stderr, tr("usage.environment"))
}

func mustDo(err error) {
	if err != nil {
		fail("%v", err)
	}
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}

func say(format string, args ...any) {
	fmt.Printf(format+"\n", args...)
}

// ---------- пути и права ----------

func dataDir() string {
	base := os.Getenv("ProgramData")
	if base == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, "Murmur")
}

// Имя службы входит в путь: иначе вторая служба, поднятая для приёмки, молча затирает
// описание запуска первой.
func specPath() string      { return filepath.Join(dataDir(), svcName()+".json") }
func statePath() string     { return filepath.Join(dataDir(), svcName()+".state.json") }
func daemonPIDPath() string { return filepath.Join(dataDir(), svcName()+".daemon-pid") }
func logDir() string        { return filepath.Join(dataDir(), "logs", svcName()) }

// secureDir закрывает каталог данных от непривилегированного пользователя.
//
// Проверено на живой машине: свежий подкаталог %ProgramData% наследует
// BUILTIN\Users:(CI)(WD,AD,WEA,WA) и CREATOR OWNER:(F). Файла с описанием запуска там
// может ещё не быть, а значит обычный пользователь вправе создать его первым — и стать
// его владельцем с полным доступом. Служба исполняет указанный в нём путь под учётной
// записью SYSTEM, то есть это прямое повышение привилегий. Поэтому DACL задаётся явно и
// с запретом наследования: SYSTEM и администраторы — полный доступ, остальные — чтение.
func secureDir(path string) error {
	if err := os.MkdirAll(path, 0o755); err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString("D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)")
	if err != nil {
		return trError("acl.build", err, err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return trError("acl.read", err, err)
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil, nil, dacl, nil)
}

// Раскладка заголовка ACL и разрешающей записи ACE по документации Windows.
type aclHeader struct {
	AclRevision uint8
	Sbz1        uint8
	AclSize     uint16
	AceCount    uint16
	Sbz2        uint16
}

type allowedAce struct {
	Type     uint8
	Flags    uint8
	Size     uint16
	Mask     uint32
	SidStart uint32
}

const accessAllowedAceType = 0

var (
	advapi32   = syscall.NewLazyDLL("advapi32.dll")
	procGetAce = advapi32.NewProc("GetAce")
)

// trustedFile отвечает на вопрос, может ли непривилегированный пользователь подменить
// файл, который служба исполнит под учётной записью SYSTEM.
//
// Проверяется список доступа, а не владелец. Владелец здесь ничего не доказывает: файл,
// созданный администратором из-под своей учётной записи, принадлежит этой учётной
// записи, а не группе, — моя прежняя проверка по владельцу отвергала обычную установку.
// Значение имеет ровно одно: есть ли у кого-то вне системы и администраторов право
// писать в этот файл.
func trustedFile(path string) (bool, string, error) {
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return false, "", err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return false, "", err
	}
	if dacl == nil {
		return false, tr("acl.noList"), nil
	}

	system, _ := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	admins, _ := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	const writeMask = uint32(windows.FILE_WRITE_DATA | windows.FILE_APPEND_DATA |
		windows.WRITE_DAC | windows.WRITE_OWNER | windows.DELETE | windows.GENERIC_WRITE | windows.GENERIC_ALL)

	// x/sys/windows этой версии не отдаёт ACE наружу, поэтому список обходится вручную:
	// заголовок ACL и запись ACE имеют фиксированную раскладку.
	hdr := (*aclHeader)(unsafe.Pointer(dacl))
	for i := uint32(0); i < uint32(hdr.AceCount); i++ {
		// Принимаем сразу типизированный указатель: GetAce пишет адрес записи в нашу
		// переменную, и хранить его промежуточно в целом числе незачем. Через uintptr
		// это была бы та самая подмена, на которую ругается go vet: между приведениями
		// сборщик мусора вправе переместить объект.
		var ace *allowedAce
		r, _, err := procGetAce.Call(uintptr(unsafe.Pointer(dacl)), uintptr(i), uintptr(unsafe.Pointer(&ace)))
		if r == 0 {
			return false, "", err
		}
		if ace.Type != accessAllowedAceType {
			continue
		}
		if ace.Mask&writeMask == 0 {
			continue
		}
		// unsafe.Add вместо арифметики по uintptr: приведение указателя через целое
		// небезопасно — сборщик мусора вправе переместить объект между двумя шагами, и
		// go vet справедливо это ловит.
		sid := (*windows.SID)(unsafe.Add(unsafe.Pointer(ace), unsafe.Offsetof(ace.SidStart)))
		if sid.Equals(system) || sid.Equals(admins) {
			continue
		}
		// Владелец файла получает права по ACE CREATOR OWNER; он администратор, раз
		// файл лежит в закрытом каталоге, но назвать его поимённо честнее.
		return false, tr("acl.writer", sid.String()), nil
	}
	return true, "", nil
}

// ---------- установка ----------

type launchSpec struct {
	Node    string `json:"node"`
	Entry   string `json:"entry"`
	WorkDir string `json:"workDir"`
	// DataDir — абсолютный путь канонического каталога данных. Без него демон возьмёт
	// каталог по умолчанию относительно своего рабочего каталога: установка положит
	// данные в одно место, демон будет писать в другое, и человек посмотрит не туда.
	DataDir string `json:"dataDir"`
	// RestartsPerHourLimit приходит из ответа движка, а не из константы: иначе при
	// изменении порога значок и движок разъедутся.
	RestartsPerHourLimit int `json:"restartsPerHourLimit"`
}

func resolveSpec() (*launchSpec, error) {
	node := os.Getenv("MURMUR_NODE")
	if node == "" {
		found, err := exec.LookPath("node")
		if err != nil {
			return nil, errors.New(tr("error.node"))
		}
		node = found
	}
	entry := os.Getenv("MURMUR_ENTRY")
	if entry == "" {
		return nil, errors.New(tr("error.entry"))
	}
	workDir := os.Getenv("MURMUR_WORKDIR")
	if workDir == "" {
		workDir = filepath.Dir(filepath.Dir(entry))
	}
	data, err := selectedDataDir(filepath.Join(workDir, ".data"))
	if err != nil {
		return nil, err
	}
	if err := rejectMetadataOverlap(data, dataDir()); err != nil {
		return nil, err
	}
	limit := restartsPerHourDefault
	if v := os.Getenv("MURMUR_RESTARTS_PER_HOUR_LIMIT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	// Абсолютные пути обязательны: служба стартует с рабочим каталогом System32, и
	// относительный путь там означает совсем другой файл.
	for name, p := range map[string]string{"MURMUR_NODE": node, "MURMUR_ENTRY": entry, "MURMUR_WORKDIR": workDir, "MURMUR_DATA_DIR": data} {
		if !filepath.IsAbs(p) {
			return nil, errors.New(tr("error.path", name, p))
		}
		if _, err := os.Stat(p); err != nil && name != "MURMUR_DATA_DIR" {
			return nil, fmt.Errorf("%s: %v", name, err)
		}
	}
	if err := os.MkdirAll(data, 0o755); err != nil {
		return nil, trError("error.profileDir", err, data, err)
	}
	return &launchSpec{Node: node, Entry: entry, WorkDir: workDir, DataDir: data, RestartsPerHourLimit: limit}, nil
}

// install ставит службу и заканчивается проверкой, что она работает.
//
// Команда, вернувшая ноль, обязана означать работающую систему. Прежняя версия
// возвращала успех сразу после CreateService и один раз уже соврала: запись в SCM
// создана, служба не стартует, три команды подряд вернули ноль. Поэтому здесь есть
// откат: не подтвердилось — служба удаляется, и в системе не остаётся половины.
func install() error {
	// Решение о том, состоится ли установка, принимается ДО единого изменения на диске.
	// Прежний порядок отказывал «служба уже установлена» уже после того, как перезаписал
	// её описание запуска и снёс состояние: команда возвращала верный код и портила
	// работающую службу. Наличие проверки и её своевременность — разные вещи.
	m, err := mgr.Connect()
	if err != nil {
		return trError("error.admin", err, err)
	}
	defer m.Disconnect()

	if existing, err := m.OpenService(svcName()); err == nil {
		defer existing.Close()
		if ownErr := ownService(existing); ownErr != nil {
			return errors.New(tr("error.unchanged", ownErr))
		}
		return errors.New(tr("error.alreadyInstalled", svcName()))
	} else if !serviceAbsent(err) {
		return trError("error.existingCheck", err, err)
	}

	spec, err := resolveSpec()
	if err != nil {
		return err
	}
	exePath, err := os.Executable()
	if err != nil {
		return err
	}
	say("%s", tr("install.paths", spec.Node, spec.Entry))
	say("%s", tr("data.path", spec.DataDir))

	// Дальше начинаются изменения на диске.
	if err := secureDir(dataDir()); err != nil {
		return trError("error.profileDir", err, dataDir(), err)
	}
	say("%s", tr("data.secured", dataDir()))

	_ = os.Remove(specPath())
	buf, err := json.MarshalIndent(spec, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(specPath(), buf, 0o600); err != nil {
		return err
	}
	_ = os.Remove(statePath())

	s, err := m.CreateService(svcName(), exePath, mgr.Config{
		DisplayName:  svcName(),
		Description:  tr("service.description"),
		StartType:    mgr.StartAutomatic,
		ErrorControl: mgr.ErrorNormal,
	}, "run", svcName())
	if err != nil {
		return trError("error.create", err, err)
	}
	defer s.Close()
	say("%s", tr("install.registered", svcName()))

	if err := verifyStart(s); err != nil {
		say("%s", tr("install.rollback"))
		_ = stopService(s)
		if derr := s.Delete(); derr != nil {
			return errors.New(tr("install.rollbackFailed", err, derr))
		}
		return errors.New(tr("install.rollbackEvidence", err, specPath(), statePath(), logDir()))
	}
	say("%s", tr("daemon.settled", settleTime))
	return nil
}

func verifyStart(s *mgr.Service) error {
	before, err := s.Query()
	if err != nil {
		return err
	}
	if before.State == svc.Stopped {
		_ = os.Remove(daemonPIDPath())
		if err := s.Start(); err != nil {
			return trError("error.start", err, err)
		}
		if err := waitState(s, svc.Running, startTimeout); err != nil {
			return err
		}
	} else if before.State != svc.Running {
		return fmt.Errorf("service.transition-in-progress: retry after the current operation")
	}
	// Repeated start observes the existing process; it must not remove its PID
	// witness before discovering that SCM already has a running service.
	say("%s", tr("service.running"))

	pid, err := waitDaemonPID(startTimeout)
	if err != nil {
		return err
	}
	say("%s", tr("daemon.pid", pid))

	deadline := time.Now().Add(settleTime)
	for time.Now().Before(deadline) {
		time.Sleep(500 * time.Millisecond)
		q, err := s.Query()
		if err != nil {
			return trError("error.serviceState", err, err)
		}
		if q.State != svc.Running {
			return errors.New(tr("service.leftRunning", time.Until(deadline).Round(time.Second)))
		}
		if !processAlive(pid) {
			if newPID, err := readDaemonPID(); err == nil && newPID != pid {
				return errors.New(tr("daemon.restartEarly", pid, newPID))
			}
			return errors.New(tr("daemon.didNotLive", pid))
		}
	}
	return nil
}

func waitState(s *mgr.Service, want svc.State, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var last svc.State
	for time.Now().Before(deadline) {
		q, err := s.Query()
		if err != nil {
			return trError("error.serviceState", err, err)
		}
		last = q.State
		if q.State == want {
			return nil
		}
		if q.State == svc.Stopped && want == svc.Running {
			return errors.New(tr("error.startStopped", q.Win32ExitCode, q.ServiceSpecificExitCode, logDir()))
		}
		time.Sleep(300 * time.Millisecond)
	}
	return errors.New(tr("error.startTimeout", timeout, last))
}

func waitDaemonPID(timeout time.Duration) (int, error) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if pid, err := readDaemonPID(); err == nil && processAlive(pid) {
			return pid, nil
		}
		time.Sleep(300 * time.Millisecond)
	}
	return 0, errors.New(tr("daemon.didNotStart", timeout, logDir()))
}

func readDaemonPID() (int, error) {
	buf, err := os.ReadFile(daemonPIDPath())
	if err != nil {
		return 0, err
	}
	var pid int
	if _, err := fmt.Sscanf(strings.TrimSpace(string(buf)), "%d", &pid); err != nil {
		return 0, err
	}
	return pid, nil
}

func processAlive(pid int) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil {
		return false
	}
	const stillActive = 259
	return code == stillActive
}

func uninstall() error {
	m, err := mgr.Connect()
	if err != nil {
		return trError("error.admin", err, err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(svcName())
	if err != nil {
		if !serviceAbsent(err) {
			return trError("error.uninstallState", err, err)
		}
		// Службы в диспетчере нет — но файлы после отката установки есть, и это ровно
		// та команда, на которую откат сослался. Отказаться здесь значит не выполнить
		// собственное обещание.
		if _, err := os.Stat(specPath()); err == nil {
			spec, err := resolveSpecFromFile()
			if err != nil {
				return err
			}
			if err := requireExpectedProfile(spec); err != nil {
				return err
			}
		} else if !os.IsNotExist(err) {
			return err
		}
		say("%s", tr("service.noEntryCleanup", svcName()))
		removeLeftovers()
		return nil
	}
	defer s.Close()
	if err := ownService(s); err != nil {
		return err
	}
	if err := stopService(s); err != nil {
		return fmt.Errorf("service.stop-failed: refusing to delete a running service: %w", err)
	}
	if err := s.Delete(); err != nil {
		return err
	}
	say("%s", tr("service.removed", svcName()))
	removeLeftovers()
	return nil
}

// removeLeftovers убирает то, что создала установка, кроме журнала: журнал переживает
// удаление намеренно, разбирать отказ по нему будут уже после.
func removeLeftovers() {
	removed := 0
	for _, p := range []string{specPath(), statePath(), daemonPIDPath()} {
		if err := os.Remove(p); err == nil {
			say("%s", tr("service.fileRemoved", p))
			removed++
		}
	}
	if removed == 0 {
		say("%s", tr("service.noFiles"))
	}
	say("%s", tr("service.logsRetained", logDir()))
}

func startAndVerify() error {
	m, err := mgr.Connect()
	if err != nil {
		return trError("error.admin", err, err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(svcName())
	if err != nil {
		return errors.New(tr("error.notInstalled", svcName()))
	}
	defer s.Close()
	if err := ownService(s); err != nil {
		return err
	}
	if err := verifyStart(s); err != nil {
		return err
	}
	say("%s", tr("service.started"))
	return nil
}

func stop() error {
	m, err := mgr.Connect()
	if err != nil {
		return trError("error.admin", err, err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(svcName())
	if err != nil {
		return errors.New(tr("error.notInstalled", svcName()))
	}
	defer s.Close()
	if err := ownService(s); err != nil {
		return err
	}
	if err := stopService(s); err != nil {
		return err
	}
	say("%s", tr("service.stopped"))
	return nil
}

func stopService(s *mgr.Service) error {
	q, err := s.Query()
	if err != nil {
		return err
	}
	if q.State == svc.Stopped {
		return nil
	}
	if _, err := s.Control(svc.Stop); err != nil {
		return err
	}
	return waitState(s, svc.Stopped, startTimeout)
}

// ---------- состояние ----------

// runState — то, чего SCM не знает: сколько раз надзор поднимал демона и чем он
// закончил в прошлый раз.
type runState struct {
	HostPID       int         `json:"hostPid"`
	Restarts      []time.Time `json:"restarts"`
	LastExitCode  *int        `json:"lastExitCode"`
	LastFailureAt string      `json:"lastFailureAt"`
	StartedAt     string      `json:"startedAt"`
}

func readState() runState {
	var st runState
	if buf, err := os.ReadFile(statePath()); err == nil {
		_ = json.Unmarshal(buf, &st)
	}
	return st
}

func writeState(st runState) {
	if buf, err := json.MarshalIndent(st, "", "  "); err == nil {
		_ = os.WriteFile(statePath(), buf, 0o600)
	}
}

func (st runState) restartsLastHour() int {
	cutoff := time.Now().Add(-time.Hour)
	n := 0
	for _, t := range st.Restarts {
		if t.After(cutoff) {
			n++
		}
	}
	return n
}

// ServiceStatus — фрагмент, который CLI кладёт в поле service ответа status --json.
// Имена полей совпадают с CONTRACT.md намеренно: перекладывать их по дороге негде.
type ServiceStatus struct {
	Schema          string      `json:"schema"`
	ServiceName     string      `json:"serviceName"`
	Profile         *launchSpec `json:"profile"`
	RestartWindowMs *int64      `json:"restartWindowMs"`
	RestartCount    *int        `json:"restartCount"`
	State           string      `json:"state"`
	Manager         string      `json:"manager"`
	Since           *string     `json:"since"`
	// PID — процесс хоста службы. DaemonPID — процесс самого демона: это разные вещи,
	// и вопрос «жив ли демон» относится ко второму.
	PID       int  `json:"pid"`
	DaemonPID *int `json:"daemonPid"`
	// ObservedStorePath заполняется только фактическим свидетельством: процесс держит
	// этот файл открытым. Описание запуска и окружение говорят, чего мы просили.
	ObservedStorePath   *string `json:"observedStorePath"`
	ObservedStoreReason *string `json:"observedStoreUnknownReason"`
	// Неизвестное приходит как null, никогда как пустая строка и никогда как ноль:
	// пустая строка неотличима от измеренного отсутствия.
	LastExitCode  *int    `json:"lastExitCode"`
	LastFailureAt *string `json:"lastFailureAt"`
	// RestartsLastHour обнуляем: ноль означает «подъёмов не было», а состояние, которое
	// не удалось прочитать, означает «не знаю». Разные вещи.
	RestartsLastHour      *int    `json:"restartsLastHour"`
	RestartsUnknownReason *string `json:"restartsUnknownReason"`
	RestartsPerHourLimit  int     `json:"restartsPerHourLimit"`
}

func limitOf(spec *launchSpec) int {
	if spec != nil && spec.RestartsPerHourLimit > 0 {
		return spec.RestartsPerHourLimit
	}
	return restartsPerHourDefault
}

func orNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// status requests only query rights. Tray users must not need elevation just to
// observe a service; mutations continue using the administrator-only connection.
func connectReadOnly() (*mgr.Mgr, error) {
	h, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return nil, err
	}
	return &mgr.Mgr{Handle: h}, nil
}
func openReadOnly(m *mgr.Mgr, name string) (*mgr.Service, error) {
	encoded, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return nil, err
	}
	h, err := windows.OpenService(m.Handle, encoded, windows.SERVICE_QUERY_STATUS|windows.SERVICE_QUERY_CONFIG)
	if err != nil {
		return nil, err
	}
	return &mgr.Service{Name: name, Handle: h}, nil
}

func printStatus() error {
	out := ServiceStatus{
		Schema: "murmur.windows-service/1", ServiceName: svcName(),
		State: "unknown", Manager: "windows-service",
		RestartsPerHourLimit:  restartsPerHourDefault,
		RestartsUnknownReason: orNil("service.history-host-unverified"),
		ObservedStoreReason:   orNil("service.manager-unavailable"),
	}
	m, err := connectReadOnly()
	if err == nil {
		defer m.Disconnect()
		s, oerr := openReadOnly(m, svcName())
		if oerr != nil {
			if serviceAbsent(oerr) {
				out.State, out.Manager = "stopped", "none"
				out.ObservedStoreReason = orNil("service.not-installed")
			}
		} else {
			defer s.Close()
			if ownErr := ownService(s); ownErr != nil {
				out.Manager = "foreign"
				out.ObservedStoreReason = orNil(ownErr.Error())
			} else if q, qerr := s.Query(); qerr == nil {
				spec, specErr := resolveSpecFromFile()
				if specErr == nil && requireExpectedProfile(spec) == nil {
					out.Profile = spec
					out.RestartsPerHourLimit = limitOf(spec)
					out.State, out.PID = stateName(q), int(q.ProcessId)
					out.ObservedStoreReason = orNil("service.daemon-not-observed")
					st, stateErr := readStateChecked()
					if stateErr != nil {
						out.RestartsUnknownReason = orNil(stateErr.Error())
					} else if q.State == svc.Running && st.HostPID == out.PID && out.PID > 0 {
						out.Since, out.LastExitCode, out.LastFailureAt = orNil(st.StartedAt), st.LastExitCode, orNil(st.LastFailureAt)
						n, window, historyErr := measuredRestarts(st, time.Now())
						if historyErr != nil {
							out.RestartsUnknownReason = orNil(historyErr.Error())
						} else {
							out.RestartCount, out.RestartWindowMs = &n, &window
							out.RestartsUnknownReason = orNil("service.history-window-incomplete")
							if window == int64(time.Hour/time.Millisecond) {
								out.RestartsLastHour, out.RestartsUnknownReason = &n, nil
							}
						}
						daemonPID, _ := readDaemonPID()
						if daemonPID > 0 {
							// A normal user may be denied OpenProcess for a SYSTEM child,
							// while Restart Manager can still observe its open database.
							// Do not discard that stronger direct observation beforehand.
							if path, why := observedStore(spec.DataDir, daemonPID); path != "" {
								out.DaemonPID = &daemonPID
								out.ObservedStorePath, out.ObservedStoreReason = &path, nil
							} else {
								out.ObservedStoreReason = orNil(why)
								if processAlive(daemonPID) {
									out.DaemonPID = &daemonPID
								}
							}
						}
					}
				}
			}
		}
	}
	if out.State == "running" && out.RestartCount != nil && *out.RestartCount >= out.RestartsPerHourLimit {
		out.State = "failed"
	}
	buf, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(buf))
	return nil
}

// Missing history is unmeasured. It must not become a measured zero after deletion
// or a failed state write.
func readStateChecked() (runState, error) {
	var st runState
	buf, err := os.ReadFile(statePath())
	if err != nil {
		return st, trError("error.readState", err, err)
	}
	if err := json.Unmarshal(buf, &st); err != nil {
		return st, trError("error.parseState", err, err)
	}
	return st, nil
}

// ownService проверяет, что именованная служба — действительно наша: её программа это
// наш бинарь. Тот же класс, что нашли на маковской стороне, где адаптер мог остановить
// чужой профиль с совпавшим именем.
func ownService(s *mgr.Service) error {
	cfg, err := s.Config()
	if err != nil {
		return trError("error.readConfig", err, svcName(), err)
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if err := validateServiceImage(cfg.BinaryPathName, self, svcName()); err != nil {
		return err
	}
	spec, err := resolveSpecFromFile()
	if err != nil {
		return err
	}
	return requireExpectedProfile(spec)
}

func serviceAbsent(err error) bool { return errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) }

// SCM ImagePath is a Windows command line. Splitting on whitespace truncates a
// quoted Program Files executable and strands an otherwise running service.
func validateServiceImage(imagePath, self, name string) error {
	args, err := windows.DecomposeCommandLine(imagePath)
	if err != nil || len(args) != 3 || args[1] != "run" || args[2] != name {
		return fmt.Errorf("service.foreign-image-path: executable and run/service arguments are required")
	}
	binary, err := os.Stat(args[0])
	if err != nil {
		return fmt.Errorf("service.image-path-unavailable: %w", err)
	}
	current, err := os.Stat(self)
	if err != nil {
		return err
	}
	if !os.SameFile(binary, current) {
		return fmt.Errorf("service.foreign-executable: refusing another service binary")
	}
	return nil
}

func stateName(q svc.Status) string {
	switch q.State {
	case svc.Running:
		return "running"
	case svc.Stopped:
		// Остановленная по команде и упавшая различаются кодом выхода. Служебный код
		// ставит сам Execute, win32-код — диспетчер.
		if q.ServiceSpecificExitCode != 0 || (q.Win32ExitCode != 0 && q.Win32ExitCode != 1077) {
			return "failed"
		}
		return "stopped"
	default:
		return "unknown"
	}
}

// ---------- служба ----------

type daemonHost struct {
	mu   sync.Mutex
	cmd  *exec.Cmd
	stop bool
}

// Служебные коды выхода. Они уезжают в ServiceSpecificExitCode и доходят до status,
// иначе настоящий отказ выглядел бы как остановка по желанию человека — серым значком.
const (
	ecSpecFailed    = 10 // описание запуска не прочитано или ему нельзя доверять
	ecDaemonFailed  = 11 // демон не запускается вовсе
	ecRestartStorm  = 12 // падение по кругу
	ecLogDirFailure = 13
)

func (h *daemonHost) Execute(args []string, r <-chan svc.ChangeRequest, s chan<- svc.Status) (bool, uint32) {
	const accepted = svc.AcceptStop | svc.AcceptShutdown
	s <- svc.Status{State: svc.StartPending}

	spec, err := resolveSpecFromFile()
	if err != nil {
		logLine("%s", tr("service.cannotStart", err))
		recordFailure(ecSpecFailed)
		return true, ecSpecFailed
	}
	if err := os.MkdirAll(logDir(), 0o755); err != nil {
		logLine("%s", tr("logs.directory", err))
		recordFailure(ecLogDirFailure)
		return true, ecLogDirFailure
	}

	fatal := make(chan uint32, 1)
	done := make(chan struct{})
	st := readState()
	st.HostPID = os.Getpid()
	st.StartedAt = time.Now().UTC().Format(time.RFC3339Nano)
	writeState(st)
	go h.supervise(spec, fatal, done)
	s <- svc.Status{State: svc.Running, Accepts: accepted}

	for {
		select {
		case c := <-r:
			switch c.Cmd {
			case svc.Interrogate:
				s <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				s <- svc.Status{State: svc.StopPending}
				h.terminate()
				<-done
				return false, 0
			}
		case code := <-fatal:
			// Надзор сдался. Служба обязана уйти в failed с говорящим кодом, иначе
			// правило «серый выигрывает у красного» покажет настоящий отказ как
			// выключенную по желанию человека службу, и красному неоткуда взяться.
			s <- svc.Status{State: svc.StopPending}
			h.terminate()
			<-done
			recordFailure(code)
			return true, code
		}
	}
}

func recordFailure(code uint32) {
	st := readState()
	c := int(code)
	st.LastExitCode = &c
	st.LastFailureAt = time.Now().UTC().Format(time.RFC3339)
	writeState(st)
}

func resolveSpecFromFile() (*launchSpec, error) {
	// Владельца проверяем до чтения: файл задаёт, что служба исполнит под учётной
	// записью SYSTEM, и созданный кем-то ещё он означает подмену.
	ok, why, err := trustedFile(specPath())
	if err != nil {
		return nil, trError("spec.aclRead", err, specPath(), err)
	}
	if !ok {
		return nil, errors.New(tr("spec.insecure", why))
	}
	buf, err := os.ReadFile(specPath())
	if err != nil {
		return nil, trError("spec.read", err, specPath(), err)
	}
	var spec launchSpec
	if err := json.Unmarshal(buf, &spec); err != nil {
		return nil, trError("spec.parse", err, err)
	}
	if spec.Node == "" || spec.Entry == "" {
		return nil, errors.New(tr("spec.required"))
	}
	return &spec, nil
}

func (h *daemonHost) supervise(spec *launchSpec, fatal chan<- uint32, done chan<- struct{}) {
	defer close(done)
	delay := restartDelayMin

	for {
		h.mu.Lock()
		if h.stop {
			h.mu.Unlock()
			return
		}
		cmd := exec.Command(spec.Node, spec.Entry)
		cmd.Dir = spec.WorkDir
		// Каталог данных уезжает в окружение дочернего процесса тем же значением, что
		// записано в описании запуска: служба и командная строка обязаны приходить к
		// одному месту по одному правилу.
		//
		// Имя переменной проверено по исходнику демона: scripts/murmur-daemon.mjs читает
		// DATA_DIR и при её отсутствии берёт «.data» относительно рабочего каталога.
		// DATA_DIR is canonical. The legacy name is passed with the same value only
		// for existing auxiliary consumers; it does not name a future migration.
		cmd.Env = append(os.Environ(),
			"DATA_DIR="+spec.DataDir,
			"MURMUR_DATA_DIR="+spec.DataDir)
		out, ferr := os.OpenFile(filepath.Join(logDir(), "daemon.log"),
			os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if ferr == nil {
			cmd.Stdout, cmd.Stderr = out, out
		}
		startErr := cmd.Start()
		h.cmd = cmd
		h.mu.Unlock()

		if startErr != nil {
			logLine("%s", tr("daemon.failedStart", startErr))
			if out != nil {
				out.Close()
			}
			fatal <- ecDaemonFailed
			return
		}
		_ = os.WriteFile(daemonPIDPath(), []byte(fmt.Sprint(cmd.Process.Pid)), 0o600)

		startedAt := time.Now()
		waitErr := cmd.Wait()
		if out != nil {
			out.Close()
		}

		h.mu.Lock()
		stopping := h.stop
		h.mu.Unlock()
		if stopping {
			return
		}

		st := readState()
		st.Restarts = append(trimRestarts(st.Restarts), time.Now())
		if code := exitCode(waitErr); code != nil {
			st.LastExitCode = code
		}
		st.LastFailureAt = time.Now().UTC().Format(time.RFC3339)
		writeState(st)

		if n := st.restartsLastHour(); n >= limitOf(spec) {
			logLine("%s", tr("daemon.restartStorm", n))
			fatal <- ecRestartStorm
			return
		}

		if time.Since(startedAt) >= healthyRun {
			delay = restartDelayMin
		}
		logLine("%s", tr("daemon.exited", waitErr, delay, st.restartsLastHour()))
		time.Sleep(delay)
		if delay *= 2; delay > restartDelayMax {
			delay = restartDelayMax
		}
	}
}

func trimRestarts(in []time.Time) []time.Time {
	cutoff := time.Now().Add(-24 * time.Hour)
	out := in[:0]
	for _, t := range in {
		if t.After(cutoff) {
			out = append(out, t)
		}
	}
	return out
}

func exitCode(err error) *int {
	var ee *exec.ExitError
	if err != nil && asExitError(err, &ee) {
		c := ee.ExitCode()
		return &c
	}
	return nil
}

func asExitError(err error, target **exec.ExitError) bool {
	ee, ok := err.(*exec.ExitError)
	if ok {
		*target = ee
	}
	return ok
}

func (h *daemonHost) terminate() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.stop = true
	if h.cmd != nil && h.cmd.Process != nil {
		// Windows не знает сигналов, поэтому дочерний процесс снимается Kill. Демон
		// переживает это штатно: незавершённое лежит в SQLite, не в памяти.
		_ = h.cmd.Process.Kill()
	}
	_ = os.Remove(daemonPIDPath())
}

func logLine(format string, args ...any) {
	_ = os.MkdirAll(logDir(), 0o755)
	f, err := os.OpenFile(filepath.Join(logDir(), "service.log"),
		os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s %s\n", time.Now().UTC().Format(time.RFC3339), fmt.Sprintf(format, args...))
}
