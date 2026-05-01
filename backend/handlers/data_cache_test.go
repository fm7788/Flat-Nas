package handlers

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"flatnasgo-backend/config"
	"flatnasgo-backend/models"

	"github.com/gin-gonic/gin"
)

func TestGetDataSupportsETagRevalidation(t *testing.T) {
	gin.SetMode(gin.TestMode)

	tempDir := t.TempDir()
	dataDir := filepath.Join(tempDir, "data")
	usersDir := filepath.Join(dataDir, "users")
	if err := os.MkdirAll(usersDir, 0755); err != nil {
		t.Fatalf("mkdir users dir: %v", err)
	}

	systemFile := filepath.Join(dataDir, "system.json")
	dataFile := filepath.Join(dataDir, "data.json")
	if err := os.WriteFile(systemFile, []byte(`{"authMode":"single","enableDocker":true}`), 0644); err != nil {
		t.Fatalf("write system config: %v", err)
	}
	if err := os.WriteFile(dataFile, []byte(`{"groups":[],"widgets":[],"rssFeeds":[],"rssCategories":[],"version":1}`), 0644); err != nil {
		t.Fatalf("write data file: %v", err)
	}

	oldDataDir := config.DataDir
	oldUsersDir := config.UsersDir
	oldSystemConfigFile := config.SystemConfigFile
	oldSysConfigCache := sysConfigCache
	oldSysConfigCacheMod := sysConfigCacheMod
	oldGetDataCache := getDataCache
	config.DataDir = dataDir
	config.UsersDir = usersDir
	config.SystemConfigFile = systemFile
	sysConfigCache = models.SystemConfig{}
	sysConfigCacheMod = time.Time{}
	getDataCache = map[string]getDataCacheEntry{}
	t.Cleanup(func() {
		config.DataDir = oldDataDir
		config.UsersDir = oldUsersDir
		config.SystemConfigFile = oldSystemConfigFile
		sysConfigCache = oldSysConfigCache
		sysConfigCacheMod = oldSysConfigCacheMod
		getDataCache = oldGetDataCache
	})

	router := gin.New()
	router.GET("/api/data", GetData)

	firstRecorder := httptest.NewRecorder()
	firstRequest := httptest.NewRequest(http.MethodGet, "/api/data", nil)
	router.ServeHTTP(firstRecorder, firstRequest)
	if firstRecorder.Code != http.StatusOK {
		t.Fatalf("expected first request 200, got %d", firstRecorder.Code)
	}
	etag := firstRecorder.Header().Get("ETag")
	if etag == "" {
		t.Fatal("expected ETag header on first response")
	}
	if got := firstRecorder.Header().Get("Cache-Control"); got != "private, no-cache, must-revalidate" {
		t.Fatalf("unexpected Cache-Control %q", got)
	}

	secondRecorder := httptest.NewRecorder()
	secondRequest := httptest.NewRequest(http.MethodGet, "/api/data", nil)
	secondRequest.Header.Set("If-None-Match", etag)
	router.ServeHTTP(secondRecorder, secondRequest)
	if secondRecorder.Code != http.StatusNotModified {
		t.Fatalf(
			"expected second request 304, got %d (first=%q second=%q)",
			secondRecorder.Code,
			etag,
			secondRecorder.Header().Get("ETag"),
		)
	}
	if got := secondRecorder.Header().Get("ETag"); got != etag {
		t.Fatalf("expected same ETag %q, got %q", etag, got)
	}
}

func TestNormalizeEmbeddedAssetRefsCachesDataImage(t *testing.T) {
	tempDir := t.TempDir()
	oldIconCacheDir := config.IconCacheDir
	config.IconCacheDir = tempDir
	t.Cleanup(func() {
		config.IconCacheDir = oldIconCacheDir
	})

	payload := map[string]interface{}{
		"groups": []interface{}{
			map[string]interface{}{
				"title": "demo",
				"items": []interface{}{
					map[string]interface{}{
						"title": "demo-item",
						"icon":  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yR4QAAAAASUVORK5CYII=",
					},
				},
			},
		},
	}

	if !normalizeEmbeddedAssetRefs(payload) {
		t.Fatal("expected embedded asset refs to be normalized")
	}

	groups := payload["groups"].([]interface{})
	group := groups[0].(map[string]interface{})
	items := group["items"].([]interface{})
	item := items[0].(map[string]interface{})
	icon, _ := item["icon"].(string)
	if !strings.HasPrefix(icon, "/icon-cache/") {
		t.Fatalf("expected cached icon path, got %q", icon)
	}
	if _, err := os.Stat(filepath.Join(tempDir, filepath.Base(icon))); err != nil {
		t.Fatalf("expected cached icon file to exist: %v", err)
	}
}
