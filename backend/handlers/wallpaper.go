package handlers

import (
	"flatnasgo-backend/config"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

type WallpaperResolveRequest struct {
	URL string `json:"url"`
}

func ResolveWallpaper(c *gin.Context) {
	var req WallpaperResolveRequest
	if err := c.BindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
		return
	}

	parsed, err := url.Parse(req.URL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid URL"})
		return
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Unsupported protocol"})
		return
	}
	if IsBlockedHost(parsed.Hostname()) && !isAllowedWallpaperHost(parsed.Hostname()) {
		c.JSON(http.StatusForbidden, gin.H{"error": "Target host is not allowed"})
		return
	}

	client, err := getSharedProxyClient()
	if err != nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	resp, err := client.Head(parsed.String())
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"url": req.URL})
		return
	}
	defer resp.Body.Close()

	finalURL := resp.Request.URL.String()
	c.JSON(http.StatusOK, gin.H{"url": finalURL})
}

type WallpaperFetchRequest struct {
	URL   string `json:"url"`
	Type  string `json:"type"` // "pc" or "mobile"
	Apply bool   `json:"apply"`
}

func FetchWallpaper(c *gin.Context) {
	fmt.Println("DEBUG: FetchWallpaper called")
	var req WallpaperFetchRequest
	if err := c.BindJSON(&req); err != nil {
		fmt.Printf("DEBUG: BindJSON error: %v\n", err)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
		return
	}
	fmt.Printf("DEBUG: FetchWallpaper URL: %s, Type: %s\n", req.URL, req.Type)

	parsed, err := url.Parse(req.URL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid URL"})
		return
	}

	if IsBlockedHost(parsed.Hostname()) && !isAllowedWallpaperHost(parsed.Hostname()) {
		c.JSON(http.StatusForbidden, gin.H{"error": "Target host is not allowed"})
		return
	}

	client, err := getSharedProxyClient()
	if err != nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	resp, err := client.Get(req.URL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to download image"})
		return
	}
	defer resp.Body.Close()

	ct := resp.Header.Get("Content-Type")
	ext := ".jpg"
	if strings.Contains(ct, "png") {
		ext = ".png"
	} else if strings.Contains(ct, "webp") {
		ext = ".webp"
	} else if strings.Contains(ct, "gif") {
		ext = ".gif"
	} else if strings.Contains(ct, "svg") {
		ext = ".svg"
	} else if strings.Contains(ct, "jpeg") {
		ext = ".jpg"
	}

	targetDir := config.BackgroundsDir
	urlPrefix := "/backgrounds"
	prefix := "api_bg"
	if req.Type == "mobile" {
		targetDir = config.MobileBackgroundsDir
		urlPrefix = "/mobile_backgrounds"
		prefix = "api_mbg"
	}

	// Use username if available in context, otherwise admin/default
	username := "admin" // Default
	if u, exists := c.Get("username"); exists {
		username = u.(string)
	}

	filename := fmt.Sprintf("%s_%s_%d%s", prefix, username, time.Now().UnixMilli(), ext)
	outPath := filepath.Join(targetDir, filename)

	out, err := os.Create(outPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create file"})
		return
	}
	defer out.Close()

	_, err = io.Copy(out, resp.Body)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save file"})
		return
	}

	webPath := fmt.Sprintf("%s/%s", urlPrefix, filename)
	c.JSON(http.StatusOK, gin.H{"success": true, "path": webPath, "filename": filename})
}

func ListBackgrounds(c *gin.Context) {
	listBackgrounds(c, config.BackgroundsDir)
}

func ListMobileBackgrounds(c *gin.Context) {
	listBackgrounds(c, config.MobileBackgroundsDir)
}

func listBackgrounds(c *gin.Context, dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		c.JSON(http.StatusOK, []string{})
		return
	}

	var fileInfos []os.FileInfo
	for _, entry := range entries {
		if !entry.IsDir() {
			info, err := entry.Info()
			if err == nil {
				fileInfos = append(fileInfos, info)
			}
		}
	}

	// Sort by ModTime Descending (Newest first)
	sort.Slice(fileInfos, func(i, j int) bool {
		return fileInfos[i].ModTime().After(fileInfos[j].ModTime())
	})

	var names []string
	for _, info := range fileInfos {
		name := info.Name()
		lower := strings.ToLower(name)
		if strings.HasSuffix(lower, ".jpg") || strings.HasSuffix(lower, ".jpeg") ||
			strings.HasSuffix(lower, ".png") || strings.HasSuffix(lower, ".gif") ||
			strings.HasSuffix(lower, ".webp") || strings.HasSuffix(lower, ".svg") {
			names = append(names, name)
		}
	}
	c.JSON(http.StatusOK, names)
}

func DeleteBackground(c *gin.Context) {
	deleteBackground(c, config.BackgroundsDir)
}

func DeleteMobileBackground(c *gin.Context) {
	deleteBackground(c, config.MobileBackgroundsDir)
}

func deleteBackground(c *gin.Context, dir string) {
	name := c.Param("name")
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Name required"})
		return
	}
	if strings.Contains(name, "..") || strings.Contains(name, "/") || strings.Contains(name, "\\") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid name"})
		return
	}

	// IDOR Check
	username := c.GetString("username")
	if username == "" {
		// Should not happen if authorized, but safe guard
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
		return
	}

	// Admin can delete anything. Users can only delete their own (files containing their username)
	if username != "admin" {
		// Heuristic check based on filename format: prefix_username_timestamp.ext
		// We check if "_username_" exists in the filename.
		if !strings.Contains(name, "_"+username+"_") {
			c.JSON(http.StatusForbidden, gin.H{"error": "Permission denied"})
			return
		}
	}

	path := filepath.Join(dir, name)
	if err := os.Remove(path); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

func UploadBackground(c *gin.Context) {
	uploadBackground(c, config.BackgroundsDir, "/backgrounds")
}

func UploadMobileBackground(c *gin.Context) {
	uploadBackground(c, config.MobileBackgroundsDir, "/mobile_backgrounds")
}

func uploadBackground(c *gin.Context, dir string, webPrefix string) {
	form, err := c.MultipartForm()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Bad Request"})
		return
	}

	type UploadedFile struct {
		Filename string `json:"filename"`
		Path     string `json:"path"`
	}
	var uploaded []UploadedFile

	files := form.File["files"]
	for _, file := range files {
		filename := filepath.Base(file.Filename)
		if err := c.SaveUploadedFile(file, filepath.Join(dir, filename)); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save " + filename})
			return
		}
		uploaded = append(uploaded, UploadedFile{
			Filename: filename,
			Path:     fmt.Sprintf("%s/%s", webPrefix, filename),
		})
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "files": uploaded})
}
