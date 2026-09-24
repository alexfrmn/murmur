//go:build windows

package main

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The directory has a protected DACL from creation, before any secret is written.
// Windows ignores Unix permission bits, so os.MkdirTemp alone is insufficient.
func privateInviteToken(value string) (string, func() error, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", nil, err
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;" + user.User.Sid.String() + ")")
	if err != nil {
		return "", nil, err
	}
	nonce := make([]byte, 16)
	if _, err = rand.Read(nonce); err != nil {
		return "", nil, err
	}
	dir := filepath.Join(os.TempDir(), "murmur-key-"+hex.EncodeToString(nonce))
	ptr, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return "", nil, err
	}
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	if err = windows.CreateDirectory(ptr, &sa); err != nil {
		return "", nil, err
	}
	path := filepath.Join(dir, "key")
	remove := func() error {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return os.Remove(dir)
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err == nil {
		_, err = f.WriteString(value)
		closeErr := f.Close()
		if err == nil {
			err = closeErr
		}
	}
	if err != nil {
		_ = remove()
		return "", nil, err
	}
	return path, remove, nil
}
