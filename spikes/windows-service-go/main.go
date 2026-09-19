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
	serviceDesc        = "Murmur: демон обмена сообщениями между агентами"

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
	isService, err := svc.IsWindowsService()
	if err != nil {
		fail("не удалось определить режим запуска: %v", err)
	}
	if isService {
		// SCM передаёт «run <имя>» из ImagePath. Без этого svc.Run получил бы имя по
		// умолчанию, диспетчер отверг бы подключение, и служба молча не стартовала бы.
		if len(os.Args) >= 3 && os.Args[1] == "run" {
			runtimeName = os.Args[2]
		}
		_ = svc.Run(svcName(), &daemonHost{})
		return
	}
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
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
	fmt.Fprintln(os.Stderr, "murmur-svc install|uninstall|start|stop|status")
	fmt.Fprintln(os.Stderr, "install читает MURMUR_NODE, MURMUR_ENTRY, MURMUR_WORKDIR, MURMUR_SERVICE_NAME")
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
		return fmt.Errorf("не удалось собрать права каталога: %w", err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return fmt.Errorf("не удалось прочитать права каталога: %w", err)
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
		return false, "у файла нет списка доступа", nil
	}

	system, _ := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	admins, _ := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	const writeMask = uint32(windows.FILE_WRITE_DATA | windows.FILE_APPEND_DATA |
		windows.WRITE_DAC | windows.WRITE_OWNER | windows.DELETE | windows.GENERIC_WRITE | windows.GENERIC_ALL)

	// x/sys/windows этой версии не отдаёт ACE наружу, поэтому список обходится вручную:
	// заголовок ACL и запись ACE имеют фиксированную раскладку.
	hdr := (*aclHeader)(unsafe.Pointer(dacl))
	for i := uint32(0); i < uint32(hdr.AceCount); i++ {
		var acePtr uintptr
		r, _, err := procGetAce.Call(uintptr(unsafe.Pointer(dacl)), uintptr(i), uintptr(unsafe.Pointer(&acePtr)))
		if r == 0 {
			return false, "", err
		}
		ace := (*allowedAce)(unsafe.Pointer(acePtr))
		if ace.Type != accessAllowedAceType {
			continue
		}
		if ace.Mask&writeMask == 0 {
			continue
		}
		sid := (*windows.SID)(unsafe.Pointer(uintptr(unsafe.Pointer(ace)) + unsafe.Offsetof(ace.SidStart)))
		if sid.Equals(system) || sid.Equals(admins) {
			continue
		}
		// Владелец файла получает права по ACE CREATOR OWNER; он администратор, раз
		// файл лежит в закрытом каталоге, но назвать его поимённо честнее.
		return false, "право записи есть у " + sid.String(), nil
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
			return nil, fmt.Errorf("node не найден в PATH, задайте MURMUR_NODE")
		}
		node = found
	}
	entry := os.Getenv("MURMUR_ENTRY")
	if entry == "" {
		return nil, fmt.Errorf("MURMUR_ENTRY не задан: нужен путь к scripts/murmur-daemon.mjs")
	}
	workDir := os.Getenv("MURMUR_WORKDIR")
	if workDir == "" {
		workDir = filepath.Dir(filepath.Dir(entry))
	}
	data := os.Getenv("MURMUR_DATA_DIR")
	if data == "" {
		data = filepath.Join(workDir, ".data")
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
			return nil, fmt.Errorf("%s должен быть абсолютным путём, получено %q", name, p)
		}
		if _, err := os.Stat(p); err != nil && name != "MURMUR_DATA_DIR" {
			return nil, fmt.Errorf("%s: %v", name, err)
		}
	}
	if err := os.MkdirAll(data, 0o755); err != nil {
		return nil, fmt.Errorf("каталог данных %s: %w", data, err)
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
		return fmt.Errorf("диспетчер служб недоступен (нужны права администратора): %w", err)
	}
	defer m.Disconnect()

	if existing, err := m.OpenService(svcName()); err == nil {
		defer existing.Close()
		if ownErr := ownService(existing); ownErr != nil {
			return fmt.Errorf("%v; ничего не тронуто", ownErr)
		}
		return fmt.Errorf("служба %s уже установлена; ничего не тронуто, снимите её командой uninstall", svcName())
	}

	spec, err := resolveSpec()
	if err != nil {
		return err
	}
	exePath, err := os.Executable()
	if err != nil {
		return err
	}
	say("проверка путей: node %s, точка входа %s", spec.Node, spec.Entry)
	say("каталог данных: %s", spec.DataDir)

	// Дальше начинаются изменения на диске.
	if err := secureDir(dataDir()); err != nil {
		return fmt.Errorf("каталог данных %s: %w", dataDir(), err)
	}
	say("каталог данных закрыт от записи обычным пользователем: %s", dataDir())

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
		Description:  serviceDesc,
		StartType:    mgr.StartAutomatic,
		ErrorControl: mgr.ErrorNormal,
	}, "run", svcName())
	if err != nil {
		return fmt.Errorf("создать службу не удалось: %w", err)
	}
	defer s.Close()
	say("служба %s зарегистрирована, автозапуск включён", svcName())

	if err := verifyStart(s); err != nil {
		say("установка не подтвердилась, откатываю")
		_ = stopService(s)
		if derr := s.Delete(); derr != nil {
			return fmt.Errorf("%v; откат не удался, служба осталась в SCM: %v", err, derr)
		}
		return fmt.Errorf("%v. Служба удалена из диспетчера. Намеренно остались: файл запуска %s, состояние %s и журнал %s, они нужны для разбора. Убрать целиком: murmur-svc uninstall", err, specPath(), statePath(), logDir())
	}
	say("демон живёт дольше %s, установка подтверждена", settleTime)
	return nil
}

func verifyStart(s *mgr.Service) error {
	_ = os.Remove(daemonPIDPath())
	if err := s.Start(); err != nil {
		return fmt.Errorf("диспетчер отказался запускать службу: %w", err)
	}
	if err := waitState(s, svc.Running, startTimeout); err != nil {
		return err
	}
	say("служба в состоянии Running")

	pid, err := waitDaemonPID(startTimeout)
	if err != nil {
		return err
	}
	say("демон запущен, pid %d", pid)

	deadline := time.Now().Add(settleTime)
	for time.Now().Before(deadline) {
		time.Sleep(500 * time.Millisecond)
		q, err := s.Query()
		if err != nil {
			return fmt.Errorf("состояние службы прочитать не удалось: %w", err)
		}
		if q.State != svc.Running {
			return fmt.Errorf("служба ушла из Running через %s после старта", time.Until(deadline).Round(time.Second))
		}
		if !processAlive(pid) {
			if newPID, err := readDaemonPID(); err == nil && newPID != pid {
				return fmt.Errorf("демон перезапустился в первые секунды (pid %d сменился на %d): он падает по кругу", pid, newPID)
			}
			return fmt.Errorf("демон с pid %d не прожил и нескольких секунд", pid)
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
			return fmt.Errorf("состояние службы прочитать не удалось: %w", err)
		}
		last = q.State
		if q.State == want {
			return nil
		}
		if q.State == svc.Stopped && want == svc.Running {
			return fmt.Errorf("служба остановилась сразу после запуска (код %d, служебный код %d). Журнал: %s",
				q.Win32ExitCode, q.ServiceSpecificExitCode, logDir())
		}
		time.Sleep(300 * time.Millisecond)
	}
	return fmt.Errorf("служба не дошла до нужного состояния за %s, осталась в %d", timeout, last)
}

func waitDaemonPID(timeout time.Duration) (int, error) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if pid, err := readDaemonPID(); err == nil && processAlive(pid) {
			return pid, nil
		}
		time.Sleep(300 * time.Millisecond)
	}
	return 0, fmt.Errorf("демон не поднялся за %s. Журнал: %s", timeout, logDir())
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
		return fmt.Errorf("диспетчер служб недоступен (нужны права администратора): %w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(svcName())
	if err != nil {
		// Службы в диспетчере нет — но файлы после отката установки есть, и это ровно
		// та команда, на которую откат сослался. Отказаться здесь значит не выполнить
		// собственное обещание.
		say("службы %s в диспетчере нет, убираю оставшиеся файлы", svcName())
		removeLeftovers()
		return nil
	}
	defer s.Close()
	if err := ownService(s); err != nil {
		return err
	}
	_ = stopService(s)
	if err := s.Delete(); err != nil {
		return err
	}
	say("служба %s удалена", svcName())
	removeLeftovers()
	return nil
}

// removeLeftovers убирает то, что создала установка, кроме журнала: журнал переживает
// удаление намеренно, разбирать отказ по нему будут уже после.
func removeLeftovers() {
	removed := 0
	for _, p := range []string{specPath(), statePath(), daemonPIDPath()} {
		if err := os.Remove(p); err == nil {
			say("убран %s", p)
			removed++
		}
	}
	if removed == 0 {
		say("убирать нечего")
	}
	say("журнал оставлен: %s", logDir())
}

func startAndVerify() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("диспетчер служб недоступен (нужны права администратора): %w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(svcName())
	if err != nil {
		return fmt.Errorf("служба %s не установлена", svcName())
	}
	defer s.Close()
	if err := ownService(s); err != nil {
		return err
	}
	if err := verifyStart(s); err != nil {
		return err
	}
	say("служба запущена и подтверждена")
	return nil
}

func stop() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("диспетчер служб недоступен (нужны права администратора): %w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(svcName())
	if err != nil {
		return fmt.Errorf("служба %s не установлена", svcName())
	}
	defer s.Close()
	if err := ownService(s); err != nil {
		return err
	}
	if err := stopService(s); err != nil {
		return err
	}
	say("служба остановлена")
	return nil
}

func stopService(s *mgr.Service) error {
	if _, err := s.Control(svc.Stop); err != nil {
		return err
	}
	return waitState(s, svc.Stopped, startTimeout)
}

// ---------- состояние ----------

// runState — то, чего SCM не знает: сколько раз надзор поднимал демона и чем он
// закончил в прошлый раз.
type runState struct {
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
	State   string  `json:"state"`
	Manager string  `json:"manager"`
	Since   *string `json:"since"`
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

func printStatus() error {
	spec, specErr := resolveSpecFromFile()
	st, stateErr := readStateChecked()

	out := ServiceStatus{
		State:                "unknown",
		Manager:              "windows-service",
		RestartsPerHourLimit: limitOf(spec),
	}
	if stateErr == nil {
		n := st.restartsLastHour()
		out.RestartsLastHour = &n
		out.Since = orNil(st.StartedAt)
		out.LastExitCode = st.LastExitCode
		out.LastFailureAt = orNil(st.LastFailureAt)
	} else {
		out.RestartsUnknownReason = orNil(stateErr.Error())
	}

	m, err := mgr.Connect()
	if err == nil {
		defer m.Disconnect()
		s, oerr := m.OpenService(svcName())
		if oerr != nil {
			out.State, out.Manager = "stopped", "none"
		} else {
			defer s.Close()
			if ownErr := ownService(s); ownErr != nil {
				// Имя службы задаётся снаружи, значит совпадение с чужой возможно.
				// Отвечать за чужой профиль мы не вправе — и молчать об этом тоже.
				out.State, out.Manager = "unknown", "foreign"
				out.ObservedStoreReason = orNil(ownErr.Error())
			} else if q, qerr := s.Query(); qerr == nil {
				out.State = stateName(q)
				out.PID = int(q.ProcessId)
			}
		}
	}

	if out.Manager != "foreign" {
		daemonPID, _ := readDaemonPID()
		if daemonPID > 0 && processAlive(daemonPID) {
			out.DaemonPID = &daemonPID
		}
		dataDir := ""
		if specErr == nil {
			dataDir = spec.DataDir
		}
		if path, why := observedStore(dataDir, daemonPID); path != "" {
			out.ObservedStorePath = &path
		} else {
			out.ObservedStoreReason = orNil(why)
		}
	}

	if out.State == "running" && out.RestartsLastHour != nil && *out.RestartsLastHour >= limitOf(spec) {
		out.State = "failed"
	}

	buf, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(buf))
	return nil
}

// readStateChecked отличает «состояния ещё нет» от «прочитать не удалось»: первое даёт
// честный ноль подъёмов, второе — неизвестность.
func readStateChecked() (runState, error) {
	var st runState
	buf, err := os.ReadFile(statePath())
	if os.IsNotExist(err) {
		return st, nil
	}
	if err != nil {
		return st, fmt.Errorf("файл состояния не прочитан: %w", err)
	}
	if err := json.Unmarshal(buf, &st); err != nil {
		return st, fmt.Errorf("файл состояния не разобран: %w", err)
	}
	return st, nil
}

// ownService проверяет, что именованная служба — действительно наша: её программа это
// наш бинарь. Тот же класс, что нашли на маковской стороне, где адаптер мог остановить
// чужой профиль с совпавшим именем.
func ownService(s *mgr.Service) error {
	cfg, err := s.Config()
	if err != nil {
		return fmt.Errorf("конфигурацию службы %s прочитать не удалось: %w", svcName(), err)
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	bin := strings.Trim(strings.Fields(cfg.BinaryPathName)[0], `"`)
	a, _ := filepath.EvalSymlinks(bin)
	b, _ := filepath.EvalSymlinks(self)
	if a == "" {
		a = bin
	}
	if b == "" {
		b = self
	}
	if !strings.EqualFold(filepath.Clean(a), filepath.Clean(b)) {
		return fmt.Errorf("служба %s принадлежит другой программе (%s) — не трогаю её", svcName(), bin)
	}
	return nil
}

func stateName(q svc.Status) string {
	switch q.State {
	case svc.Running, svc.StartPending, svc.ContinuePending:
		return "running"
	case svc.Stopped:
		// Остановленная по команде и упавшая различаются кодом выхода. Служебный код
		// ставит сам Execute, win32-код — диспетчер.
		if q.ServiceSpecificExitCode != 0 || (q.Win32ExitCode != 0 && q.Win32ExitCode != 1077) {
			return "failed"
		}
		return "stopped"
	default:
		return "stopped"
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
		logLine("старт невозможен: %v", err)
		recordFailure(ecSpecFailed)
		return true, ecSpecFailed
	}
	if err := os.MkdirAll(logDir(), 0o755); err != nil {
		logLine("каталог логов недоступен: %v", err)
		recordFailure(ecLogDirFailure)
		return true, ecLogDirFailure
	}

	fatal := make(chan uint32, 1)
	done := make(chan struct{})
	go h.supervise(spec, fatal, done)

	s <- svc.Status{State: svc.Running, Accepts: accepted}
	st := readState()
	st.StartedAt = time.Now().UTC().Format(time.RFC3339)
	writeState(st)

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
		return nil, fmt.Errorf("права файла службы не прочитаны (%s): %w", specPath(), err)
	}
	if !ok {
		return nil, fmt.Errorf("файл службы доступен на запись не только системе и администраторам (%s) — исполнять его нельзя", why)
	}
	buf, err := os.ReadFile(specPath())
	if err != nil {
		return nil, fmt.Errorf("файл службы не прочитан (%s): %w", specPath(), err)
	}
	var spec launchSpec
	if err := json.Unmarshal(buf, &spec); err != nil {
		return nil, fmt.Errorf("файл службы не разобран: %w", err)
	}
	if spec.Node == "" || spec.Entry == "" {
		return nil, fmt.Errorf("в файле службы нет node или entry")
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
		// MURMUR_DATA_DIR передаётся рядом как имя, предложенное движком, — когда демон
		// начнёт читать его, здесь ничего менять не придётся.
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
			logLine("демон не запустился: %v", startErr)
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
			logLine("демон поднимался %d раз за час — это падение по кругу, не работа", n)
			fatal <- ecRestartStorm
			return
		}

		if time.Since(startedAt) >= healthyRun {
			delay = restartDelayMin
		}
		logLine("демон завершился (%v), перезапуск через %s, подъёмов за час: %d", waitErr, delay, st.restartsLastHour())
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
