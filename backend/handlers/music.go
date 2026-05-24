package handlers

import (
	"flatnasgo-backend/config"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
)

func isSupportedMusicFile(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	return ext == ".mp3" || ext == ".flac" || ext == ".wav" || ext == ".m4a" || ext == ".ogg"
}

// UploadMusic handles music file uploads
func UploadMusic(c *gin.Context) {
	form, err := c.MultipartForm()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Bad Request"})
		return
	}

	files := form.File["files"]
	var count int
	var errors []string
	username := c.GetString("username")
	if username == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
		return
	}

	assetMetaMu.Lock()
	store, metaErr := loadAssetMetaStoreUnlocked()
	if metaErr != nil {
		assetMetaMu.Unlock()
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load metadata"})
		return
	}

	for _, file := range files {
		filename := filepath.Base(file.Filename)

		// Simple validation
		if !isSupportedMusicFile(filename) {
			errors = append(errors, fmt.Sprintf("%s: unsupported format", filename))
			continue
		}

		if err := c.SaveUploadedFile(file, filepath.Join(config.MusicDir, filename)); err != nil {
			errors = append(errors, fmt.Sprintf("%s: %v", filename, err))
			continue
		}
		owner := username
		store.Music[normalizeAssetKey(filename)] = assetMetaEntry{Owner: &owner}
		count++
	}

	if count > 0 {
		if err := saveAssetMetaStoreUnlocked(store); err != nil {
			assetMetaMu.Unlock()
			c.JSON(http.StatusInternalServerError, gin.H{
				"success": false,
				"error":   "Failed to save metadata",
			})
			return
		}
	}
	assetMetaMu.Unlock()

	if count == 0 && len(errors) > 0 {
		c.JSON(http.StatusInternalServerError, gin.H{
			"success": false,
			"error":   strings.Join(errors, "; "),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"count":   count,
		"errors":  errors,
	})
}

type deleteMusicRequest struct {
	Path string `json:"path"`
}

// DeleteMusic handles deletion of a music file
func DeleteMusic(c *gin.Context) {
	var req deleteMusicRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
		return
	}

	if req.Path == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Path is required"})
		return
	}
	username := c.GetString("username")
	if username == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
		return
	}

	normalizedPath := normalizeAssetKey(req.Path)
	musicPath := filepath.Join(config.MusicDir, normalizedPath)

	absPath, err := filepath.Abs(musicPath)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid path"})
		return
	}

	// Security: ensure the path is within MusicDir
	absMusicDir, _ := filepath.Abs(config.MusicDir)
	if !strings.HasPrefix(absPath, absMusicDir) {
		c.JSON(http.StatusForbidden, gin.H{"error": "Permission denied"})
		return
	}

	if _, err := os.Stat(absPath); os.IsNotExist(err) {
		c.JSON(http.StatusNotFound, gin.H{"error": "File not found"})
		return
	}

	assetMetaMu.Lock()
	store, metaErr := loadAssetMetaStoreUnlocked()
	if metaErr != nil {
		assetMetaMu.Unlock()
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load metadata"})
		return
	}
	if store.Music == nil {
		store.Music = map[string]assetMetaEntry{}
	}
	if _, ok := store.Music[normalizedPath]; !ok && isSupportedMusicFile(normalizedPath) {
		store.Music[normalizedPath] = assetMetaEntry{Owner: nil}
	}
	entry := store.Music[normalizedPath]
	if username != "admin" {
		if entry.Owner == nil || strings.TrimSpace(*entry.Owner) == "" || strings.TrimSpace(*entry.Owner) != username {
			assetMetaMu.Unlock()
			c.JSON(http.StatusForbidden, gin.H{"error": "Permission denied"})
			return
		}
	}
	if err := os.Remove(absPath); err != nil {
		assetMetaMu.Unlock()
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete file"})
		return
	}
	delete(store.Music, normalizedPath)
	if err := saveAssetMetaStoreUnlocked(store); err != nil {
		assetMetaMu.Unlock()
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save metadata"})
		return
	}
	assetMetaMu.Unlock()

	c.JSON(http.StatusOK, gin.H{"success": true})
}
