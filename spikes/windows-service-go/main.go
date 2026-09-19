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
	"strings"
	"sync"
	"time"

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
	// Больше стольких подъёмов за час — это не работа, а падение по кругу. Служба
	// обязана уйти в failed: бесконечная попытка выглядит как жизнь и ей не является.
	restartsPerHourLimit = 8

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

// trustedOwner отвечает на вопрос, кем создан файл, который служба собирается исполнить.
// Владелец из непривилегированных означает подмену, и читать такой файл нельзя.
func trustedOwner(path string) (bool, string, error) {
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return false, "", err
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return false, "", err
	}
	for _, wk := range []windows.WELL_KNOWN_SID_TYPE{windows.WinLocalSystemSid, windows.WinBuiltinAdministratorsSid} {
		if sid, err := windows.CreateWellKnownSid(wk); err == nil && owner.Equals(sid) {
			return true, owner.String(), nil
		}
	}
	return false, owner.String(), nil
}

// ---------- установка ----------

type launchSpec struct {
	Node    string `json:"node"`
	Entry   string `json:"entry"`
	WorkDir string `json:"workDir"`
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
	// Абсолютные пути обязательны: служба стартует с рабочим каталогом System32, и
	// относительный путь там означает совсем другой файл.
	for name, p := range map[string]string{"MURMUR_NODE": node, "MURMUR_ENTRY": entry, "MURMUR_WORKDIR": workDir} {
		if !filepath.IsAbs(p) {
			return nil, fmt.Errorf("%s должен быть абсолютным путём, получено %q", name, p)
		}
		if _, err := os.Stat(p); err != nil {
			return nil, fmt.Errorf("%s: %v", name, err)
		}
	}
	return &launchSpec{Node: node, Entry: entry, WorkDir: workDir}, nil
}

// install ставит службу и заканчивается проверкой, что она работает.
//
// Команда, вернувшая ноль, обязана означать работающую систему. Прежняя версия
// возвращала успех сразу после CreateService и один раз уже соврала: запись в SCM
// создана, служба не стартует, три команды подряд вернули ноль. Поэтому здесь есть
// откат: не подтвердилось — служба удаляется, и в системе не остаётся половины.
func install() error {
	spec, err := resolveSpec()
	if err != nil {
		return err
	}
	say("проверка путей: node %s, точка входа %s", spec.Node, spec.Entry)

	if err := secureDir(dataDir()); err != nil {
		return fmt.Errorf("каталог данных %s: %w", dataDir(), err)
	}
	say("каталог данных закрыт от записи обычным пользователем: %s", dataDir())

	// Файл мог быть создан кем угодно до нас — каталог до этой установки был открыт
	// на создание. Убираем и пишем заново уже под защищённым DACL.
	_ = os.Remove(specPath())
	buf, err := json.MarshalIndent(spec, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(specPath(), buf, 0o600); err != nil {
		return err
	}
	_ = os.Remove(statePath())

	exePath, err := os.Executable()
	if err != nil {
		return err
	}
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("диспетчер служб недоступен (нужны права администратора): %w", err)
	}
	defer m.Disconnect()

	if s, err := m.OpenService(svcName()); err == nil {
		s.Close()
		return fmt.Errorf("служба %s уже установлена", svcName())
	}
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
		// Точный перечень того, что осталось. Прежняя формулировка «в системе ничего не
		// осталось» была шире факта: каталог данных и файл запуска пишутся до создания
		// службы и переживают откат. Журнал лежит там же, и он нужен для разбора.
		return fmt.Errorf("%v. Служба удалена из диспетчера. Намеренно остались: файл запуска %s, состояние %s и журнал %s, они нужны для разбора. Убрать целиком: murmur-svc uninstall", err, specPath(), statePath(), logDir())
	}
	say("демон живёт дольше %s, установка подтверждена", settleTime)
	return nil
}

// verifyStart: запустить, дождаться устойчивого Running, убедиться, что демон поднялся
// и прожил settleTime. Запрос диспетчеру — это не факт запуска.
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
	PID     int     `json:"pid"`
	// Неизвестное приходит как null, никогда как пустая строка и никогда как ноль:
	// пустая строка неотличима от измеренного отсутствия.
	LastExitCode     *int    `json:"lastExitCode"`
	LastFailureAt    *string `json:"lastFailureAt"`
	RestartsLastHour int     `json:"restartsLastHour"`
}

func orNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func printStatus() error {
	st := readState()
	out := ServiceStatus{
		State:            "unknown",
		Manager:          "windows-service",
		Since:            orNil(st.StartedAt),
		LastExitCode:     st.LastExitCode,
		LastFailureAt:    orNil(st.LastFailureAt),
		RestartsLastHour: st.restartsLastHour(),
	}

	m, err := mgr.Connect()
	if err == nil {
		defer m.Disconnect()
		s, oerr := m.OpenService(svcName())
		if oerr != nil {
			// Служба не установлена — это не «неизвестно», это «не запущена».
			out.State, out.Manager = "stopped", "none"
		} else {
			defer s.Close()
			if q, qerr := s.Query(); qerr == nil {
				out.State = stateName(q)
				out.PID = int(q.ProcessId)
			}
		}
	}
	// Падение по кругу с точки зрения диспетчера выглядит работой: служба жива, демон
	// умирает. Счётчик — единственное место, где это видно.
	if out.State == "running" && out.RestartsLastHour > restartsPerHourLimit {
		out.State = "failed"
	}

	buf, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(buf))
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
	ok, owner, err := trustedOwner(specPath())
	if err != nil {
		return nil, fmt.Errorf("владелец файла службы не определён (%s): %w", specPath(), err)
	}
	if !ok {
		return nil, fmt.Errorf("файл службы принадлежит %s, а не системе или администраторам — читать его нельзя", owner)
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

		if n := st.restartsLastHour(); n > restartsPerHourLimit {
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
