package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadSecretKeyTrimsWhitespace(t *testing.T) {
	dir := t.TempDir()
	secretPath := filepath.Join(dir, "secret.key")
	if err := os.WriteFile(secretPath, []byte("abc123\n"), 0600); err != nil {
		t.Fatalf("write secret: %v", err)
	}

	SecretFile = secretPath
	SecretKey = nil

	loadSecretKey()

	if string(SecretKey) != "abc123" {
		t.Fatalf("expected trimmed secret, got %q", string(SecretKey))
	}
}
