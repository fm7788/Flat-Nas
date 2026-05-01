package handlers

import (
	"crypto/rand"
	"errors"
	"flatnasgo-backend/config"
	"flatnasgo-backend/models"
	"flatnasgo-backend/utils"
	"fmt"
	"image"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

// Helper to ensure directories exist
func ensureDir(path string) {
	os.MkdirAll(path, 0755)
}

var errUploadPermission = errors.New("upload permission denied")
var errUploadIndex = errors.New("upload invalid index")

type DownloadClaims struct {
	Username string `json:"username"`
	Filename string `json:"filename"`
	jwt.RegisteredClaims
}

func getTransferDir() string {
	return filepath.Join(config.DocDir, "transfer")
}

func getTransferIndexFile() string {
	return filepath.Join(getTransferDir(), "index.json")
}

func getUploadsDir() string {
	return filepath.Join(getTransferDir(), "uploads")
}

func getUserUploadsDir(username string) string {
	return filepath.Join(getTransferDir(), "users", username, "uploads")
}

func getTransferThumbsDir() string {
	return filepath.Join(getTransferDir(), "thumbs")
}

func getTransferThumbFile(filename string, size int) string {
	return filepath.Join(getTransferThumbsDir(), strconv.Itoa(size), filename+".jpg")
}

func isValidUploadID(id string) bool {
	if id == "" {
		return false
	}
	for _, r := range id {
		if (r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F') {
			continue
		}
		return false
	}
	return true
}

func parseThumbSize(raw string) (int, bool) {
	switch raw {
	case "64":
		return 64, true
	case "128":
		return 128, true
	case "256":
		return 256, true
	default:
		return 0, false
	}
}

func authorizeTransferAccess(c *gin.Context, filename string) bool {
	tokenStr := strings.TrimSpace(c.Query("token"))
	if tokenStr != "" {
		claims := &DownloadClaims{}
		tok, err := jwt.ParseWithClaims(tokenStr, claims, func(token *jwt.Token) (interface{}, error) {
			return []byte(config.GetSecretKeyString()), nil
		}, jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}))
		if err == nil && tok != nil && tok.Valid && claims.Filename == filename {
			return true
		}
	}

	if c.GetString("username") != "" {
		return true
	}

	c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
	return false
}

func calcThumbBounds(src image.Image, maxEdge int) image.Rectangle {
	b := src.Bounds()
	w := b.Dx()
	h := b.Dy()
	if w <= 0 || h <= 0 {
		return image.Rect(0, 0, maxEdge, maxEdge)
	}
	if w <= maxEdge && h <= maxEdge {
		return image.Rect(0, 0, w, h)
	}
	if w >= h {
		nh := h * maxEdge / w
		if nh < 1 {
			nh = 1
		}
		return image.Rect(0, 0, maxEdge, nh)
	}
	nw := w * maxEdge / h
	if nw < 1 {
		nw = 1
	}
	return image.Rect(0, 0, nw, maxEdge)
}

func generateTransferThumbs(srcPath, filename string, sizes []int) (map[string]string, error) {
	in, err := os.Open(srcPath)
	if err != nil {
		return nil, err
	}
	defer in.Close()

	src, _, err := image.Decode(in)
	if err != nil {
		return nil, err
	}

	thumbs := make(map[string]string, len(sizes))
	var firstErr error

	for _, size := range sizes {
		dstRect := calcThumbBounds(src, size)
		dst := image.NewRGBA(dstRect)
		xdraw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), xdraw.Over, nil)

		dstPath := getTransferThumbFile(filename, size)
		ensureDir(filepath.Dir(dstPath))
		out, err := os.Create(dstPath)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}

		encodeErr := jpeg.Encode(out, dst, &jpeg.Options{Quality: 82})
		closeErr := out.Close()
		if encodeErr != nil || closeErr != nil {
			os.Remove(dstPath)
			if firstErr == nil {
				if encodeErr != nil {
					firstErr = encodeErr
				} else {
					firstErr = closeErr
				}
			}
			continue
		}

		thumbs[strconv.Itoa(size)] = "/api/transfer/thumb/" + filename + "/" + strconv.Itoa(size)
	}

	if len(thumbs) == 0 && firstErr != nil {
		return nil, firstErr
	}

	return thumbs, nil
}

func removeTransferThumbs(filename string) {
	for _, size := range []int{64, 128, 256} {
		_ = os.Remove(getTransferThumbFile(filename, size))
	}
}

func GetTransferItems(c *gin.Context) {
	ensureDir(getUploadsDir())

	itemType := c.Query("type")
	limitStr := c.Query("limit")
	limit := 100
	if limitStr != "" {
		if l, err := strconv.Atoi(limitStr); err == nil && l > 0 {
			limit = l
		}
	}

	var data models.TransferData
	utils.ReadJSON(getTransferIndexFile(), &data)
	if data.Items == nil {
		data.Items = []models.TransferItem{}
	}

	// Sort by timestamp desc
	sort.Slice(data.Items, func(i, j int) bool {
		return data.Items[i].Timestamp > data.Items[j].Timestamp
	})

	filtered := []models.TransferItem{}
	for _, item := range data.Items {
		switch itemType {
		case "photo":
			if item.Type == "file" && item.File != nil && strings.HasPrefix(item.File.Type, "image/") {
				filtered = append(filtered, item)
			}
		case "file":
			if item.Type == "file" {
				filtered = append(filtered, item)
			}
		case "text":
			if item.Type == "text" {
				filtered = append(filtered, item)
			}
		default:
			filtered = append(filtered, item)
		}
	}

	if len(filtered) > limit {
		filtered = filtered[:limit]
	}

	// 对缺失 thumbs 的图片项进行补充：若磁盘上已有缩略图文件，则填充 URL
	for i := range filtered {
		item := &filtered[i]
		if item.Type != "file" || item.File == nil || !strings.HasPrefix(strings.ToLower(item.File.Type), "image/") {
			continue
		}
		if item.File.Thumbs == nil {
			item.File.Thumbs = make(map[string]string)
		}
		needEnrich := false
		for _, size := range []int{64, 128, 256} {
			if item.File.Thumbs[strconv.Itoa(size)] == "" {
				needEnrich = true
				break
			}
		}
		if !needEnrich {
			continue
		}
		filename := filepath.Base(item.File.Url)
		for _, size := range []int{64, 128, 256} {
			sizeKey := strconv.Itoa(size)
			if item.File.Thumbs[sizeKey] != "" {
				continue
			}
			thumbPath := getTransferThumbFile(filename, size)
			if _, err := os.Stat(thumbPath); err == nil {
				item.File.Thumbs[sizeKey] = "/api/transfer/thumb/" + filename + "/" + sizeKey
			}
		}
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "items": filtered})
}

func SendText(c *gin.Context) {
	var req struct {
		Text string `json:"text"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid JSON"})
		return
	}

	item := models.TransferItem{
		ID:        fmt.Sprintf("%d", time.Now().UnixNano()),
		Type:      "text",
		Content:   req.Text,
		Timestamp: time.Now().UnixMilli(),
		Sender:    c.GetString("username"),
	}

	// Lock and update index
	indexPath := getTransferIndexFile()

	var data models.TransferData
	utils.ReadJSON(indexPath, &data)

	if data.Items == nil {
		data.Items = []models.TransferItem{}
	}
	data.Items = append([]models.TransferItem{item}, data.Items...)

	if err := utils.WriteJSON(indexPath, data); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save item"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "item": item})
}

type UploadSession struct {
	UploadID    string `json:"uploadId"`
	Username    string `json:"username"`
	FileKey     string `json:"fileKey"`
	FileName    string `json:"fileName"`
	Size        int64  `json:"size"`
	Mime        string `json:"mime"`
	ChunkSize   int64  `json:"chunkSize"`
	TotalChunks int    `json:"totalChunks"`
	CreatedAt   int64  `json:"createdAt"`
	Uploaded    []int  `json:"uploaded"`
}

func UploadInit(c *gin.Context) {
	var req struct {
		FileName  string `json:"fileName"`
		Size      int64  `json:"size"`
		Mime      string `json:"mime"`
		FileKey   string `json:"fileKey"`
		ChunkSize int64  `json:"chunkSize"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid JSON"})
		return
	}
	if req.ChunkSize <= 0 || req.Size <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid chunk size or file size"})
		return
	}

	username := c.GetString("username")
	uploadId := fmt.Sprintf("%x", time.Now().UnixNano()) // Simple ID

	totalChunks := int((req.Size + req.ChunkSize - 1) / req.ChunkSize)

	session := UploadSession{
		UploadID:    uploadId,
		Username:    username,
		FileKey:     req.FileKey,
		FileName:    req.FileName,
		Size:        req.Size,
		Mime:        req.Mime,
		ChunkSize:   req.ChunkSize,
		TotalChunks: totalChunks,
		CreatedAt:   time.Now().UnixMilli(),
		Uploaded:    []int{},
	}

	userDir := getUserUploadsDir(username)
	ensureDir(userDir)
	sessionFile := filepath.Join(userDir, uploadId+".json")
	if err := utils.WriteJSON(sessionFile, session); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to initialize upload"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"success":     true,
		"uploadId":    uploadId,
		"chunkSize":   req.ChunkSize,
		"totalChunks": totalChunks,
		"uploaded":    []int{},
	})
}

func UploadChunk(c *gin.Context) {
	uploadId := c.PostForm("uploadId")
	indexStr := c.PostForm("index")

	if uploadId == "" || indexStr == "" || !isValidUploadID(uploadId) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Missing params"})
		return
	}

	index, err := strconv.Atoi(indexStr)
	if err != nil || index < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid index"})
		return
	}
	username := c.GetString("username")
	userDir := getUserUploadsDir(username)
	sessionFile := filepath.Join(userDir, uploadId+".json")

	var session UploadSession
	if err := utils.ReadJSON(sessionFile, &session); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}
	if session.Username != username {
		c.JSON(http.StatusForbidden, gin.H{"error": "Permission denied"})
		return
	}
	if index >= session.TotalChunks {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid index"})
		return
	}

	file, err := c.FormFile("chunk")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No file"})
		return
	}

	chunkDir := filepath.Join(userDir, uploadId+"_chunks")
	ensureDir(chunkDir)
	chunkPath := filepath.Join(chunkDir, fmt.Sprintf("%d", index))

	if err := c.SaveUploadedFile(file, chunkPath); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Save failed"})
		return
	}

	err = utils.WithFileLock(sessionFile, func() error {
		var current UploadSession
		if err := utils.ReadJSONUnlocked(sessionFile, &current); err != nil {
			return err
		}
		if current.Username != username {
			return errUploadPermission
		}
		if index >= current.TotalChunks {
			return errUploadIndex
		}
		uploaded := make(map[int]struct{}, len(current.Uploaded)+1)
		for _, v := range current.Uploaded {
			uploaded[v] = struct{}{}
		}
		uploaded[index] = struct{}{}
		current.Uploaded = current.Uploaded[:0]
		for v := range uploaded {
			current.Uploaded = append(current.Uploaded, v)
		}
		sort.Ints(current.Uploaded)
		return utils.WriteJSONUnlocked(sessionFile, current)
	})
	if err != nil {
		if errors.Is(err, errUploadPermission) {
			c.JSON(http.StatusForbidden, gin.H{"error": "Permission denied"})
			return
		}
		if errors.Is(err, errUploadIndex) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid index"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update session"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true})
}

func UploadComplete(c *gin.Context) {
	var req struct {
		UploadId string `json:"uploadId"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid JSON"})
		return
	}
	if !isValidUploadID(req.UploadId) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid upload ID"})
		return
	}

	username := c.GetString("username")
	userDir := getUserUploadsDir(username)
	sessionFile := filepath.Join(userDir, req.UploadId+".json")

	var session UploadSession
	if err := utils.ReadJSON(sessionFile, &session); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}
	if session.Username != username {
		c.JSON(http.StatusForbidden, gin.H{"error": "Permission denied"})
		return
	}
	if session.TotalChunks <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid upload session"})
		return
	}

	// Assemble
	chunkDir := filepath.Join(userDir, req.UploadId+"_chunks")

	// Use random filename to prevent guessing
	randBytes := make([]byte, 16)
	if _, err := rand.Read(randBytes); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to finalize upload"})
		return
	}
	finalName := fmt.Sprintf("%x%s", randBytes, filepath.Ext(session.FileName))

	finalPath := filepath.Join(getUploadsDir(), finalName)
	ensureDir(getUploadsDir())

	outFile, err := os.Create(finalPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Create file failed"})
		return
	}
	defer outFile.Close()

	for i := 0; i < session.TotalChunks; i++ {
		chunkPath := filepath.Join(chunkDir, fmt.Sprintf("%d", i))
		in, err := os.Open(chunkPath)
		if err != nil {
			outFile.Close()
			os.Remove(finalPath)
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("Missing chunk %d", i)})
			return
		}
		_, err = io.Copy(outFile, in)
		in.Close()
		if err != nil {
			outFile.Close()
			os.Remove(finalPath)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to assemble file"})
			return
		}
	}

	// Cleanup
	os.RemoveAll(chunkDir)
	os.Remove(sessionFile)

	// Add to index
	item := models.TransferItem{
		ID:        fmt.Sprintf("%d", time.Now().UnixNano()),
		Type:      "file",
		Timestamp: time.Now().UnixMilli(),
		Sender:    username,
		File: &models.TransferFile{
			Name: session.FileName,
			Size: session.Size,
			Type: session.Mime,
			Url:  "/api/transfer/file/" + finalName,
		},
	}

	if strings.HasPrefix(strings.ToLower(session.Mime), "image/") {
		thumbs, err := generateTransferThumbs(finalPath, finalName, []int{64, 128, 256})
		if err != nil {
			log.Printf("transfer thumb generation failed for %s: %v", finalName, err)
		}
		if len(thumbs) > 0 {
			item.File.Thumbs = thumbs
		}
	}

	var data models.TransferData
	utils.ReadJSON(getTransferIndexFile(), &data)
	if data.Items == nil {
		data.Items = []models.TransferItem{}
	}
	data.Items = append([]models.TransferItem{item}, data.Items...)
	if err := utils.WriteJSON(getTransferIndexFile(), data); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save item"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "item": item})
}

func DownloadToken(c *gin.Context) {
	var body struct {
		Url string `json:"url"`
	}
	_ = c.ShouldBindJSON(&body)
	u, err := url.Parse(body.Url)
	if err != nil || u.Path == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid url"})
		return
	}
	username := c.GetString("username")
	if username == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
		return
	}
	name := filepath.Base(u.Path)
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid url"})
		return
	}
	if _, err := os.Stat(filepath.Join(getUploadsDir(), name)); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "File not found"})
		return
	}
	claims := DownloadClaims{
		Username: username,
		Filename: name,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(10 * time.Minute)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			Subject:   "download",
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString([]byte(config.GetSecretKeyString()))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to issue token"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "token": signed})
}

func DeleteItem(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Missing ID"})
		return
	}

	username := c.GetString("username")
	if username == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
		return
	}

	var data models.TransferData
	utils.ReadJSON(getTransferIndexFile(), &data)

	newList := []models.TransferItem{}
	var deletedItem *models.TransferItem
	for _, item := range data.Items {
		if item.ID == id {
			// IDOR Check
			if item.Sender != username && username != "admin" {
				c.JSON(http.StatusForbidden, gin.H{"error": "Permission denied"})
				return
			}
			deletedItem = &item
			continue
		}
		newList = append(newList, item)
	}

	if deletedItem != nil {
		data.Items = newList
		if err := utils.WriteJSON(getTransferIndexFile(), data); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save"})
			return
		}

		// Delete file if needed
		if deletedItem.Type == "file" && deletedItem.File != nil {
			filename := filepath.Base(deletedItem.File.Url)
			_ = os.Remove(filepath.Join(getUploadsDir(), filename))
			removeTransferThumbs(filename)
		}
	}

	c.JSON(http.StatusOK, gin.H{"success": true})
}

func ServeFile(c *gin.Context) {
	filename := filepath.Base(c.Param("filename"))
	if filename == "" {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "Invalid filename"})
		return
	}
	if !authorizeTransferAccess(c, filename) {
		return
	}
	path := filepath.Join(getUploadsDir(), filename)
	c.File(path)
}

func ServeThumb(c *gin.Context) {
	filename := filepath.Base(c.Param("filename"))
	if filename == "" {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "Invalid filename"})
		return
	}

	size, ok := parseThumbSize(c.Param("size"))
	if !ok {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "Invalid size"})
		return
	}

	if !authorizeTransferAccess(c, filename) {
		return
	}

	path := getTransferThumbFile(filename, size)
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		c.AbortWithStatus(http.StatusNotFound)
		return
	}

	etag := fmt.Sprintf(`W/"%x-%x"`, info.Size(), info.ModTime().UnixNano())
	c.Header("Cache-Control", "public, max-age=31536000, immutable")
	c.Header("ETag", etag)
	c.Header("Content-Type", "image/jpeg")
	if c.GetHeader("If-None-Match") == etag {
		c.Status(http.StatusNotModified)
		return
	}

	c.File(path)
}

var transferIndexMutex sync.Mutex

func GenerateThumb(c *gin.Context) {
	filename := filepath.Base(c.Param("filename"))
	if filename == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid filename"})
		return
	}

	size, ok := parseThumbSize(c.Param("size"))
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid size"})
		return
	}

	if !authorizeTransferAccess(c, filename) {
		return
	}

	thumbPath := getTransferThumbFile(filename, size)
	if _, err := os.Stat(thumbPath); err == nil {
		c.JSON(http.StatusOK, gin.H{"success": true, "message": "Thumbnail already exists"})
		return
	}

	filePath := filepath.Join(getUploadsDir(), filename)
	if _, err := os.Stat(filePath); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Original file not found"})
		return
	}

	thumbs, err := generateTransferThumbs(filePath, filename, []int{size})
	if err != nil {
		log.Printf("Failed to generate thumbnail for %s: %v", filename, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate thumbnail"})
		return
	}

	transferIndexMutex.Lock()
	defer transferIndexMutex.Unlock()

	var data models.TransferData
	if err := utils.ReadJSON(getTransferIndexFile(), &data); err != nil {
		log.Printf("Failed to read transfer index: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update index"})
		return
	}

	updated := false
	for i := range data.Items {
		if data.Items[i].Type == "file" && data.Items[i].File != nil {
			fileUrl := data.Items[i].File.Url
			if strings.HasSuffix(fileUrl, "/"+filename) {
				if data.Items[i].File.Thumbs == nil {
					data.Items[i].File.Thumbs = make(map[string]string)
				}
				for k, v := range thumbs {
					data.Items[i].File.Thumbs[k] = v
				}
				updated = true
				break
			}
		}
	}

	if updated {
		if err := utils.WriteJSON(getTransferIndexFile(), data); err != nil {
			log.Printf("Failed to write transfer index: %v", err)
		}
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "thumbs": thumbs})
}

func RegenerateThumbs(c *gin.Context) {
	transferIndexMutex.Lock()
	defer transferIndexMutex.Unlock()

	var data models.TransferData
	if err := utils.ReadJSON(getTransferIndexFile(), &data); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to read transfer index"})
		return
	}

	stats := gin.H{
		"processed": 0,
		"generated": 0,
		"errors":    []string{},
	}

	for i := range data.Items {
		if data.Items[i].Type != "file" || data.Items[i].File == nil {
			continue
		}

		fileUrl := data.Items[i].File.Url
		if !strings.HasPrefix(strings.ToLower(data.Items[i].File.Type), "image/") {
			continue
		}

		filename := filepath.Base(fileUrl)
		if !isValidUploadID(strings.TrimSuffix(filename, filepath.Ext(filename))) {
			continue
		}

		stats["processed"] = stats["processed"].(int) + 1

		filePath := filepath.Join(getUploadsDir(), filename)
		if _, err := os.Stat(filePath); err != nil {
			stats["errors"] = append(stats["errors"].([]string), fmt.Sprintf("File not found: %s", filename))
			continue
		}

		existingThumbs := data.Items[i].File.Thumbs
		if existingThumbs == nil {
			existingThumbs = make(map[string]string)
		}

		sizesToGenerate := []int{}
		for _, size := range []int{64, 128, 256} {
			sizeKey := strconv.Itoa(size)
			thumbPath := getTransferThumbFile(filename, size)
			if _, err := os.Stat(thumbPath); err != nil || existingThumbs[sizeKey] == "" {
				sizesToGenerate = append(sizesToGenerate, size)
			}
		}

		if len(sizesToGenerate) > 0 {
			thumbs, err := generateTransferThumbs(filePath, filename, sizesToGenerate)
			if err != nil {
				stats["errors"] = append(stats["errors"].([]string), fmt.Sprintf("Failed to generate for %s: %v", filename, err))
				continue
			}

			if data.Items[i].File.Thumbs == nil {
				data.Items[i].File.Thumbs = make(map[string]string)
			}
			for k, v := range thumbs {
				data.Items[i].File.Thumbs[k] = v
			}
			stats["generated"] = stats["generated"].(int) + len(thumbs)
		}
	}

	if err := utils.WriteJSON(getTransferIndexFile(), data); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save index"})
		return
	}

	c.JSON(http.StatusOK, stats)
}

var thumbSyncRunning bool

func StartThumbSync() {
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()

		time.Sleep(30 * time.Second)

		for {
			syncThumbs()
			<-ticker.C
		}
	}()
}

func syncThumbs() {
	if thumbSyncRunning {
		return
	}
	thumbSyncRunning = true
	defer func() { thumbSyncRunning = false }()

	transferIndexMutex.Lock()
	defer transferIndexMutex.Unlock()

	var data models.TransferData
	if err := utils.ReadJSON(getTransferIndexFile(), &data); err != nil {
		return
	}

	generated := 0
	maxPerCycle := 10

	for i := range data.Items {
		if generated >= maxPerCycle {
			break
		}

		if data.Items[i].Type != "file" || data.Items[i].File == nil {
			continue
		}

		if !strings.HasPrefix(strings.ToLower(data.Items[i].File.Type), "image/") {
			continue
		}

		fileUrl := data.Items[i].File.Url
		filename := filepath.Base(fileUrl)

		filePath := filepath.Join(getUploadsDir(), filename)
		if _, err := os.Stat(filePath); err != nil {
			continue
		}

		existingThumbs := data.Items[i].File.Thumbs
		if existingThumbs == nil {
			existingThumbs = make(map[string]string)
		}

		sizesToGenerate := []int{}
		for _, size := range []int{64, 128, 256} {
			sizeKey := strconv.Itoa(size)
			thumbPath := getTransferThumbFile(filename, size)
			if _, err := os.Stat(thumbPath); err != nil || existingThumbs[sizeKey] == "" {
				sizesToGenerate = append(sizesToGenerate, size)
			}
		}

		if len(sizesToGenerate) > 0 {
			thumbs, err := generateTransferThumbs(filePath, filename, sizesToGenerate)
			if err != nil {
				log.Printf("Thumb sync failed for %s: %v", filename, err)
				continue
			}

			if data.Items[i].File.Thumbs == nil {
				data.Items[i].File.Thumbs = make(map[string]string)
			}
			for k, v := range thumbs {
				data.Items[i].File.Thumbs[k] = v
			}
			generated += len(thumbs)
		}
	}

	if generated > 0 {
		if err := utils.WriteJSON(getTransferIndexFile(), data); err != nil {
			log.Printf("Failed to save transfer index after sync: %v", err)
		} else {
			log.Printf("Thumb sync: generated %d thumbnails", generated)
		}
	}
}
