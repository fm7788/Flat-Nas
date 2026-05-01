package handlers

import (
	"encoding/json"
	"flatnasgo-backend/config"
	"flatnasgo-backend/utils"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

type ConfigVersion struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	CreatedAt int64  `json:"createdAt"`
	Size      int64  `json:"size"`
}

type VersionFile struct {
	ID        string                 `json:"id"`
	Label     string                 `json:"label"`
	CreatedAt int64                  `json:"createdAt"`
	Data      map[string]interface{} `json:"data"`
}

func GetConfigVersions(c *gin.Context) {
	files, err := os.ReadDir(config.ConfigVersionsDir)
	if err != nil {
		// If dir doesn't exist, return empty list
		if os.IsNotExist(err) {
			c.JSON(http.StatusOK, gin.H{"versions": []ConfigVersion{}})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to read versions directory"})
		return
	}

	var versions []ConfigVersion
	for _, f := range files {
		if f.IsDir() || !strings.HasSuffix(f.Name(), ".json") {
			continue
		}

		// Read file to get label and created time
		content, err := os.ReadFile(filepath.Join(config.ConfigVersionsDir, f.Name()))
		if err != nil {
			continue
		}

		var vf VersionFile
		if err := json.Unmarshal(content, &vf); err != nil {
			continue
		}

		versions = append(versions, ConfigVersion{
			ID:        vf.ID,
			Label:     vf.Label,
			CreatedAt: vf.CreatedAt,
			Size:      int64(len(content)),
		})
	}

	// Sort by CreatedAt desc
	sort.Slice(versions, func(i, j int) bool {
		return versions[i].CreatedAt > versions[j].CreatedAt
	})

	c.JSON(http.StatusOK, gin.H{"versions": versions})
}

func SaveConfigVersion(c *gin.Context) {
	username := c.GetString("username")
	if username == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
		return
	}

	var payload struct {
		Label string `json:"label"`
	}
	if err := c.ShouldBindJSON(&payload); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid JSON"})
		return
	}

	sysConfig := getCachedSystemConfig()

	userFile := filepath.Join(config.UsersDir, username+".json")
	if username == "admin" && sysConfig.AuthMode == "single" {
		userFile = filepath.Join(config.DataDir, "data.json")
	}

	var currentData map[string]interface{}
	if err := utils.ReadJSON(userFile, &currentData); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User data not found"})
		return
	}

	now := time.Now().UnixMilli()
	id := strconv.FormatInt(now, 10)

	vf := VersionFile{
		ID:        id,
		Label:     payload.Label,
		CreatedAt: now,
		Data:      currentData,
	}

	filename := filepath.Join(config.ConfigVersionsDir, id+".json")
	if err := utils.WriteJSON(filename, vf); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save version"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true})
}

func RestoreConfigVersion(c *gin.Context) {
	username := c.GetString("username")
	if username == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
		return
	}

	var payload struct {
		ID string `json:"id"`
	}
	if err := c.ShouldBindJSON(&payload); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid JSON"})
		return
	}

	filename := filepath.Join(config.ConfigVersionsDir, payload.ID+".json")
	var vf VersionFile
	if err := utils.ReadJSON(filename, &vf); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Version not found"})
		return
	}

	sysConfig := getCachedSystemConfig()

	userFile := filepath.Join(config.UsersDir, username+".json")
	if username == "admin" && sysConfig.AuthMode == "single" {
		userFile = filepath.Join(config.DataDir, "data.json")
	}

	var currentData map[string]interface{}
	utils.ReadJSON(userFile, &currentData)

	newData := vf.Data

	// Preserve critical fields
	if currentData != nil {
		if pwd, ok := currentData["password"]; ok {
			newData["password"] = pwd
		}
		if usr, ok := currentData["username"]; ok {
			newData["username"] = usr
		}
	} else {
		newData["username"] = username
	}
	currentVersion := normalizeVersion(nil)
	if currentData != nil {
		currentVersion = normalizeVersion(currentData["version"])
	}
	newData["version"] = currentVersion + 1

	if err := utils.WriteJSON(userFile, newData); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to restore version"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true})
}

func DeleteConfigVersion(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID is required"})
		return
	}

	if _, err := strconv.ParseInt(id, 10, 64); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid ID"})
		return
	}

	filename := filepath.Join(config.ConfigVersionsDir, id+".json")
	if err := os.Remove(filename); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete version"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true})
}
