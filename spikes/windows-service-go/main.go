//go:build windows

package main

// murmur-svc — адаптер службы Windows для демона Murmur.
//
// Зачем он существует. Демон это node-процесс, а диспетчер служб Windows умеет
// запускать только программу, которая отвечает ему на управляющие сообщения. node.exe
// на них не отвечает, поэтому между SCM и демоном нужен хост — ровно то, чем для
// чужих программ служит NSSM. Здесь он свой, потому что должен отдавать наружу то,
// чего сегодняшняя задача Планировщика не отдаёт: код выхода, время последнего падения
// и причину, по которой служба стоит.
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

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

const (
	defaultServiceName = "MurmurDaemon"
	serviceDesc        = "Murmur: демон обмена сообщениями между агентами"

	// Пауза перед перезапуском упавшего демона растёт до потолка: демон, падающий
	// из-за отозванного токена, не чинится частыми перезапусками и не должен
	// молотить брокер.
	restartDelayMin = 2 * time.Second
	restartDelayMax = 60 * time.Second
	// Прожил дольше — считаем запуск удачным и сбрасываем паузу.
	healthyRun = 30 * time.Second
)

// runtimeName — имя, под которым служба зарегистрирована в SCM. Диспетчер запускает
// процесс без пользовательского окружения, поэтому имя приходит аргументом командной
// строки, заданным при установке: переменные среды сюда не доезжают.
var runtimeName string

// svcName допускает переопределение именем из окружения: приёмку службы нельзя гонять
// на боевом имени, пока рядом живёт демон под задачей Планировщика.
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
		runService()
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
		mustDo(control("start"))
	case "stop":
		mustDo(control("stop"))
	case "status":
		mustDo(printStatus())
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "murmur-svc install|uninstall|start|stop|status")
	fmt.Fprintln(os.Stderr, "install читает MURMUR_NODE, MURMUR_ENTRY и MURMUR_WORKDIR")
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

// ---------- установка ----------

type launchSpec struct {
	Node    string `json:"node"`
	Entry   string `json:"entry"`
	WorkDir string `json:"workDir"`
}

// specPath лежит рядом с логами в ProgramData: служба стартует до входа пользователя,
// и профиль в этот момент может быть ещё не смонтирован — %LOCALAPPDATA% там читать
// нечего.
func specPath() string {
	base := os.Getenv("ProgramData")
	if base == "" {
		base = os.TempDir()
	}
	// Имя службы входит в путь: иначе вторая служба, поднятая для приёмки, молча
	// затирает описание запуска первой.
	return filepath.Join(base, "Murmur", svcName()+".json")
}

func logDir() string {
	base := os.Getenv("ProgramData")
	if base == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, "Murmur", "logs", svcName())
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

func install() error {
	spec, err := resolveSpec()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(specPath()), 0o755); err != nil {
		return err
	}
	buf, err := json.MarshalIndent(spec, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(specPath(), buf, 0o644); err != nil {
		return err
	}

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
	// Путь к exe уходит в SCM как есть; кавычки вокруг него ставит библиотека, иначе
	// каталог с пробелом разобрался бы как имя программы плюс аргумент.
	s, err := m.CreateService(svcName(), exePath, mgr.Config{
		DisplayName:  svcName(),
		Description:  serviceDesc,
		StartType:    mgr.StartAutomatic,
		ErrorControl: mgr.ErrorNormal,
	}, "run", svcName())
	if err != nil {
		return err
	}
	defer s.Close()
	return nil
}

func uninstall() error {
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
	return s.Delete()
}

func control(action string) error {
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

	if action == "start" {
		return s.Start()
	}
	_, err = s.Control(svc.Stop)
	return err
}

// ---------- статус ----------

// ServiceStatus — фрагмент, который CLI кладёт в поле service ответа status --json.
// Имена полей совпадают с CONTRACT.md намеренно: перекладывать их по дороге негде.
type ServiceStatus struct {
	State        string `json:"state"`
	Manager      string `json:"manager"`
	Since        string `json:"since"`
	PID          int    `json:"pid"`
	LastExitCode *int   `json:"lastExitCode"`
}

func printStatus() error {
	st := ServiceStatus{State: "unknown", Manager: "windows-service"}

	m, err := mgr.Connect()
	if err == nil {
		defer m.Disconnect()
		if s, oerr := m.OpenService(svcName()); oerr == nil {
			defer s.Close()
			if q, qerr := s.Query(); qerr == nil {
				switch q.State {
				case svc.Running:
					st.State = "running"
				case svc.Stopped:
					st.State = "stopped"
					// ServiceSpecificExitCode отличает «остановлена по команде» от
					// «упала»: без этого оба случая выглядят одинаково.
					if q.ServiceSpecificExitCode != 0 {
						code := int(q.ServiceSpecificExitCode)
						st.LastExitCode = &code
						st.State = "failed"
					}
				case svc.StartPending, svc.ContinuePending:
					st.State = "running"
				case svc.StopPending, svc.PausePending, svc.Paused:
					st.State = "stopped"
				}
				st.PID = int(q.ProcessId)
			}
		} else {
			// Служба не установлена — это не «неизвестно», это «не запущена».
			st.State = "stopped"
			st.Manager = "none"
		}
	}
	if since, ok := readSince(); ok {
		st.Since = since
	}

	buf, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(buf))
	return nil
}

// readSince берёт момент последнего удачного старта из отметки, которую пишет сама
// служба: SCM время старта не хранит.
func readSince() (string, bool) {
	buf, err := os.ReadFile(startedAtPath())
	if err != nil {
		return "", false
	}
	s := strings.TrimSpace(string(buf))
	return s, s != ""
}

func startedAtPath() string {
	return filepath.Join(filepath.Dir(specPath()), svcName()+".started-at")
}

func writeSince(t time.Time) {
	_ = os.WriteFile(startedAtPath(), []byte(t.UTC().Format(time.RFC3339)), 0o644)
}

// ---------- служба ----------

type daemonHost struct {
	mu   sync.Mutex
	cmd  *exec.Cmd
	stop bool
}

func runService() {
	_ = svc.Run(svcName(), &daemonHost{})
}

func (h *daemonHost) Execute(args []string, r <-chan svc.ChangeRequest, s chan<- svc.Status) (bool, uint32) {
	const accepted = svc.AcceptStop | svc.AcceptShutdown
	s <- svc.Status{State: svc.StartPending}

	spec, err := resolveSpecFromFile()
	if err != nil {
		logLine("старт невозможен: %v", err)
		// Ненулевой код превращает «остановлена» в «упала» для наблюдателя.
		return false, 1
	}
	if err := os.MkdirAll(logDir(), 0o755); err != nil {
		logLine("каталог логов недоступен: %v", err)
		return false, 1
	}

	done := make(chan struct{})
	go h.supervise(spec, done)

	s <- svc.Status{State: svc.Running, Accepts: accepted}
	writeSince(time.Now())

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
		case <-done:
			// Надзор сдался сам — служба обязана уйти в остановленное состояние с
			// ненулевым кодом, а не делать вид, что работает.
			return false, 2
		}
	}
}

func resolveSpecFromFile() (*launchSpec, error) {
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

func (h *daemonHost) supervise(spec *launchSpec, done chan<- struct{}) {
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
		out, err := os.OpenFile(filepath.Join(logDir(), "daemon.log"),
			os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err == nil {
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
			return
		}

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

		if time.Since(startedAt) >= healthyRun {
			delay = restartDelayMin
		}
		logLine("демон завершился (%v), перезапуск через %s", waitErr, delay)
		time.Sleep(delay)
		if delay *= 2; delay > restartDelayMax {
			delay = restartDelayMax
		}
	}
}

func (h *daemonHost) terminate() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.stop = true
	if h.cmd != nil && h.cmd.Process != nil {
		// Windows не знает сигналов, поэтому дочерний процесс снимается Kill.
		// Демон переживает это штатно: незавершённое лежит в SQLite, не в памяти.
		_ = h.cmd.Process.Kill()
	}
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
