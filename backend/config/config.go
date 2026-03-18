package config

import (
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

//go:embed default.json
var defaultJson []byte

var (
	BaseDir              string
	DataDir              string
	UsersDir             string
	SystemConfigFile     string
	DefaultFile          string
	SecretFile           string
	DocDir               string
	MusicDir             string
	BackgroundsDir       string
	MobileBackgroundsDir string
	IconCacheDir         string
	PublicDir            string
	ConfigVersionsDir    string
	SecretKey            []byte
)

func Init() {
	cwd, err := os.Getwd()
	if err != nil {
		log.Fatal(err)
	}
	baseDirFromEnv := strings.TrimSpace(os.Getenv("BASE_DIR"))
	if baseDirFromEnv != "" {
		BaseDir = baseDirFromEnv
	} else {
		cwdBase := filepath.Base(cwd)
		switch cwdBase {
		case "backend", "frontend":
			repoRoot := filepath.Dir(cwd)
			if dirExists(filepath.Join(repoRoot, "server")) {
				BaseDir = repoRoot
			} else if dirExists(filepath.Join(repoRoot, "win", "server")) {
				BaseDir = filepath.Join(repoRoot, "win")
			} else {
				BaseDir = repoRoot
			}
		case "win":
			BaseDir = cwd
		default:
			if dirExists(filepath.Join(cwd, "server")) {
				BaseDir = cwd
			} else if dirExists(filepath.Join(cwd, "win", "server")) {
				BaseDir = filepath.Join(cwd, "win")
			} else {
				BaseDir = cwd
			}
		}
	}

	DataDir = filepath.Join(BaseDir, "server", "data")
	UsersDir = filepath.Join(DataDir, "users")
	SystemConfigFile = filepath.Join(DataDir, "system.json")
	DefaultFile = filepath.Join(DataDir, "default.json")
	SecretFile = filepath.Join(DataDir, "secret.key")
	DocDir = filepath.Join(BaseDir, "server", "doc")
	MusicDir = filepath.Join(BaseDir, "server", "music")
	BackgroundsDir = filepath.Join(BaseDir, "server", "PC")
	MobileBackgroundsDir = filepath.Join(BaseDir, "server", "APP")
	IconCacheDir = filepath.Join(DataDir, "icon-cache")
	PublicDir = filepath.Join(BaseDir, "server", "public")
	ConfigVersionsDir = filepath.Join(DataDir, "config_versions")

	ensureDirs()
	ensureSystemConfig()
	ensureDataFile()
	ensureAdditionalDataFiles()
	loadSecretKey()
}

func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info != nil && info.IsDir()
}

func ensureDirs() {
	dirs := []string{DataDir, UsersDir, DocDir, MusicDir, BackgroundsDir, MobileBackgroundsDir, IconCacheDir, PublicDir, ConfigVersionsDir}
	for _, dir := range dirs {
		if err := os.MkdirAll(dir, 0755); err != nil {
			log.Printf("Failed to create dir %s: %v", dir, err)
		}
	}
}

func ensureSystemConfig() {
	if _, err := os.Stat(SystemConfigFile); err == nil {
		data, err := os.ReadFile(SystemConfigFile)
		if err != nil {
			log.Printf("Failed to read system config: %v", err)
			return
		}
		var current map[string]interface{}
		if err := json.Unmarshal(data, &current); err != nil {
			log.Printf("Failed to parse system config: %v", err)
			return
		}
		changed := false
		if v, ok := current["authMode"].(string); !ok || strings.TrimSpace(v) == "" {
			current["authMode"] = "single"
			changed = true
		}
		if _, ok := current["enableDocker"].(bool); !ok {
			current["enableDocker"] = true
			changed = true
		}
		if !changed {
			return
		}
		updated, err := json.MarshalIndent(current, "", "  ")
		if err != nil {
			log.Printf("Failed to marshal system config: %v", err)
			return
		}
		if err := os.WriteFile(SystemConfigFile, updated, 0644); err != nil {
			log.Printf("Failed to write system config: %v", err)
		}
		return
	} else if !os.IsNotExist(err) {
		log.Printf("Failed to check system config: %v", err)
		return
	}
	defaultConfig := map[string]interface{}{
		"authMode":     "single",
		"enableDocker": true,
	}
	data, err := json.MarshalIndent(defaultConfig, "", "  ")
	if err != nil {
		log.Printf("Failed to marshal system config: %v", err)
		return
	}
	if err := os.WriteFile(SystemConfigFile, data, 0644); err != nil {
		log.Printf("Failed to write system config: %v", err)
	}
}

func ensureDataFile() {
	dataFile := filepath.Join(DataDir, "data.json")
	if _, err := os.Stat(dataFile); err == nil {
		return
	} else if !os.IsNotExist(err) {
		log.Printf("Failed to check data file: %v", err)
		return
	}

	if len(defaultJson) == 0 {
		log.Printf("Embedded default.json is empty!")
		// Fallback to reading from file if embed fails (shouldn't happen)
		var err error
		defaultJson, err = os.ReadFile(DefaultFile)
		if err != nil {
			if os.IsNotExist(err) {
				log.Printf("Default template not found: %s", DefaultFile)
				return
			}
			log.Printf("Failed to read default template: %v", err)
			return
		}
	}

	if err := os.WriteFile(dataFile, defaultJson, 0644); err != nil {
		log.Printf("Failed to initialize data file: %v", err)
	}
}

func loadSecretKey() {
	if _, err := os.Stat(SecretFile); err == nil {
		keyHex, err := os.ReadFile(SecretFile)
		if err == nil {
			trimmed := strings.TrimSpace(string(keyHex))
			if trimmed != "" {
				SecretKey = []byte(trimmed)
				return
			}
		}
	}
	if len(SecretKey) == 0 {
		bytes := make([]byte, 32)
		if _, err := rand.Read(bytes); err != nil {
			log.Fatal(err)
		}
		keyHex := hex.EncodeToString(bytes)
		if err := os.WriteFile(SecretFile, []byte(keyHex), 0600); err != nil {
			log.Fatal(err)
		}
		SecretKey = []byte(keyHex)
	}
}

func GetSecretKeyString() string {
	return string(SecretKey)
}

func ensureAdditionalDataFiles() {
	// Ensure amap_stats.json
	amapStatsFile := filepath.Join(DataDir, "amap_stats.json")
	if _, err := os.Stat(amapStatsFile); os.IsNotExist(err) {
		initialStats := map[string]interface{}{
			"total":    0,
			"today":    0,
			"lastDate": time.Now().Format("2006-01-02"),
		}
		if data, err := json.MarshalIndent(initialStats, "", "  "); err == nil {
			if err := os.WriteFile(amapStatsFile, data, 0644); err != nil {
				log.Printf("Failed to create amap_stats.json: %v", err)
			}
		}
	}

	// Ensure visitors.json
	visitorsFile := filepath.Join(DataDir, "visitors.json")
	if _, err := os.Stat(visitorsFile); os.IsNotExist(err) {
		initialVisitors := map[string]interface{}{
			"totalVisitors": 0,
			"todayVisitors": 0,
			"lastVisitDate": time.Now().Format("2006-01-02"),
		}
		if data, err := json.MarshalIndent(initialVisitors, "", "  "); err == nil {
			if err := os.WriteFile(visitorsFile, data, 0644); err != nil {
				log.Printf("Failed to create visitors.json: %v", err)
			}
		}
	}

	// Ensure custom_scripts.json
	customScriptsFile := filepath.Join(DataDir, "custom_scripts.json")
	if _, err := os.Stat(customScriptsFile); os.IsNotExist(err) {
		if err := os.WriteFile(customScriptsFile, []byte("{}"), 0644); err != nil {
			log.Printf("Failed to create custom_scripts.json: %v", err)
		}
	}

	// Ensure widget_cache.json
	widgetCacheFile := filepath.Join(DataDir, "widget_cache.json")
	if _, err := os.Stat(widgetCacheFile); os.IsNotExist(err) {
		if err := os.WriteFile(widgetCacheFile, []byte("{}"), 0644); err != nil {
			log.Printf("Failed to create widget_cache.json: %v", err)
		}
	}
}
