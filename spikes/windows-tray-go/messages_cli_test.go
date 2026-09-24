package main

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestMessagesAgainstRealCLIInDisposableHome(t *testing.T) {
	node, err := exec.LookPath("node")
	root, _ := filepath.Abs(filepath.Join("..", ".."))
	if err != nil || !fileExists(filepath.Join(root, "packages", "setup", "dist", "src", "cli.js")) {
		t.Skip("built setup engine and Node required")
	}
	home := t.TempDir()
	for _, key := range []string{"HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA"} {
		t.Setenv(key, home)
	}
	b := cliBinding{Node: node, Entry: filepath.Join(root, "packages", "setup", "bin", "murmur.mjs"), Profile: filepath.Join(home, "identity")}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	cli := func(args ...string) ([]byte, error) { return runSetupCLI(ctx, b, b.arguments(args)[1:]...) }
	if _, err := cli("init", "--agent-id", "fixture-messages", "--broker-url", "nats://127.0.0.1:1", "--json"); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(b.Profile, "agent-config.json")
	beforeConfig, err := os.ReadFile(config)
	if err != nil {
		t.Fatal(err)
	}
	script := `import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
const {SQLiteMessageStore,SQLiteDedupeOutboxStore}=await import(pathToFileURL(process.argv[1]).href);
const dir=process.argv[2],store=path.join(dir,'murmur.db');
new SQLiteMessageStore(store).close();new SQLiteDedupeOutboxStore(store).close();
const db=new DatabaseSync(store);
const insert=db.prepare("INSERT INTO local_messages(id,conversation_id,msg_id,direction,sender,text,created_at,wake_status) VALUES(?,'c',?,'inbound','synthetic-contact','synthetic message',?,?)");
for(const [i,state] of ['handled','pending',null].entries())insert.run(String(i),String(i),'2026-09-24T09:00:00Z',state);
db.close();
writeFileSync(path.join(dir,'read-state.json'),JSON.stringify({schema:'murmur.read/1',agentId:'fixture-messages',rowid:0}));`
	cmd := exec.CommandContext(ctx, node, "--input-type=module", "-e", script, filepath.Join(root, "packages", "core", "dist", "src", "index.js"), b.Profile)
	cmd.Env = b.environment()
	hideConsole(cmd)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("fixture setup: %v %s", err, out)
	}
	cursorPath := filepath.Join(b.Profile, "read-state.json")
	beforeCursor, _ := os.ReadFile(cursorPath)
	unread, err := readMessages(cli, "fixture-messages", false)
	if err != nil || unread.Unread == nil || *unread.Unread != 3 {
		t.Fatalf("read: %#v %v", unread, err)
	}
	afterCursor, _ := os.ReadFile(cursorPath)
	if !bytes.Equal(beforeCursor, afterCursor) {
		t.Fatal("reading advanced cursor")
	}
	read, err := readMessages(cli, "fixture-messages", true)
	if err != nil || read.Unread == nil || *read.Unread != 0 {
		t.Fatalf("mark/read: %#v %v", read, err)
	}
	for i, m := range read.Messages {
		prior := unread.Messages[i].AssistantRead
		if (prior == nil) != (m.AssistantRead == nil) || (prior != nil && *prior != *m.AssistantRead) || m.Unread == nil || *m.Unread {
			t.Fatal("user read mark changed Assistant state")
		}
	}
	afterConfig, _ := os.ReadFile(config)
	if !bytes.Equal(beforeConfig, afterConfig) {
		t.Fatal("reading or marking changed Identity configuration")
	}
}
