package utils

import (
	"encoding/json"
	"os"
	"sync"
)

var fileLocks sync.Map

func GetLock(filename string) *sync.Mutex {
	lock, _ := fileLocks.LoadOrStore(filename, &sync.Mutex{})
	return lock.(*sync.Mutex)
}

func WithFileLock(filename string, fn func() error) error {
	lock := GetLock(filename)
	lock.Lock()
	defer lock.Unlock()
	return fn()
}

func ReadJSONUnlocked(filename string, v interface{}) error {
	data, err := os.ReadFile(filename)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}

func WriteJSONUnlocked(filename string, v interface{}) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	tempFile := filename + ".tmp"
	if err := os.WriteFile(tempFile, data, 0644); err != nil {
		return err
	}
	return os.Rename(tempFile, filename)
}

func AtomicWriteFile(filename string, data []byte) error {
	lock := GetLock(filename)
	lock.Lock()
	defer lock.Unlock()

	tempFile := filename + ".tmp"
	if err := os.WriteFile(tempFile, data, 0644); err != nil {
		return err
	}
	// On Windows, rename might fail if destination exists and is open. 
    // os.Rename in Go on Windows replaces existing file if possible.
	return os.Rename(tempFile, filename)
}

func ReadJSON(filename string, v interface{}) error {
	lock := GetLock(filename)
	lock.Lock()
	defer lock.Unlock()

	data, err := os.ReadFile(filename)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}

func WriteJSON(filename string, v interface{}) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return AtomicWriteFile(filename, data)
}
