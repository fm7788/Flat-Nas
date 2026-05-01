package handlers

import (
	"flatnasgo-backend/config"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
)

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

	for _, file := range files {
		filename := filepath.Base(file.Filename)
		ext := strings.ToLower(filepath.Ext(filename))

		// Simple validation
		if ext != ".mp3" && ext != ".flac" && ext != ".wav" && ext != ".m4a" && ext != ".ogg" {
			errors = append(errors, fmt.Sprintf("%s: unsupported format", filename))
			continue
		}

		if err := c.SaveUploadedFile(file, filepath.Join(config.MusicDir, filename)); err != nil {
			errors = append(errors, fmt.Sprintf("%s: %v", filename, err))
			continue
		}
		count++
	}

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
