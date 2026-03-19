package main

import (
	"flatnasgo-backend/config"
	"flatnasgo-backend/handlers"
	"flatnasgo-backend/middleware"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-contrib/gzip"
	"github.com/gin-gonic/gin"
	socketio "github.com/googollee/go-socket.io"
	"github.com/googollee/go-socket.io/engineio"
	"github.com/googollee/go-socket.io/engineio/transport"
	"github.com/googollee/go-socket.io/engineio/transport/polling"
	"github.com/googollee/go-socket.io/engineio/transport/websocket"
)

func main() {
	fmt.Println("Backend process started")
	config.Init()
	handlers.InitWidgetCache()
	handlers.InitDocker()
	handlers.StartIPFetcher()
	handlers.StartDataWarmup()
	handlers.StartThumbSync()

	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Next()
	})
	r.Use(gin.Logger())
	r.Use(middleware.RecoveryMiddleware())
	r.Use(middleware.GzipDecompressMiddleware())

	// Gzip 压缩中间件 - 大幅减少网络传输量，适应内网穿透/慢速网络环境
	r.Use(gzip.Gzip(gzip.DefaultCompression))

	// 设置请求体大小限制（增加到 50MB，适应大配置文件）
	r.MaxMultipartMemory = 50 << 20 // 50 MB

	allowedOrigins := map[string]struct{}{}
	rawAllowed := strings.TrimSpace(os.Getenv("CORS_ALLOW_ORIGINS"))
	if rawAllowed != "" {
		for _, origin := range strings.Split(rawAllowed, ",") {
			o := strings.TrimSpace(origin)
			if o != "" {
				allowedOrigins[o] = struct{}{}
			}
		}
	}
	allowAllOrigins := len(allowedOrigins) == 0
	allowOriginFunc := func(origin string) bool {
		if allowAllOrigins {
			return true
		}
		_, ok := allowedOrigins[origin]
		return ok
	}

	// CORS
	r.Use(cors.New(cors.Config{
		AllowOriginFunc: func(origin string) bool {
			return allowOriginFunc(origin)
		},
		AllowMethods:     []string{"GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Authorization", "Accept", "X-Requested-With"},
		ExposeHeaders:    []string{"Content-Length"},
		AllowCredentials: true,
		MaxAge:           12 * time.Hour,
	}))

	// Socket.IO
	server := socketio.NewServer(&engineio.Options{
		Transports: []transport.Transport{
			&polling.Transport{
				CheckOrigin: func(r *http.Request) bool {
					return allowOriginFunc(r.Header.Get("Origin"))
				},
			},
			&websocket.Transport{
				CheckOrigin: func(r *http.Request) bool {
					return allowOriginFunc(r.Header.Get("Origin"))
				},
			},
		},
	})
	server.OnConnect("/", func(s socketio.Conn) error {
		s.SetContext("")
		return nil
	})
	server.OnDisconnect("/", func(s socketio.Conn, reason string) {
	})
	server.OnEvent("/", "join", func(s socketio.Conn, room string) {
		s.Join(room)
	})
	handlers.BindHotHandlers(server)
	handlers.BindWeatherHandlers(server)
	handlers.BindRssHandlers(server) // Added RSS handlers
	handlers.BindMemoHandlers(server)
	handlers.BindTodoHandlers(server)
	handlers.BindNetworkHandlers(server)
	handlers.SetSocketServer(server)
	go server.Serve()
	defer server.Close()

	r.GET("/socket.io/*any", gin.WrapH(server))
	r.POST("/socket.io/*any", gin.WrapH(server))

	// Static Files
	r.Static("/assets", filepath.Join(config.PublicDir, "assets"))
	r.Static("/icons", filepath.Join(config.PublicDir, "icons"))
	// index.html 禁止强缓存，避免部署新版本后浏览器仍用旧页面引用已不存在的 chunk（如 LoginModal-xxx.js）导致白屏/加载失败
	indexPath := filepath.Join(config.PublicDir, "index.html")
	r.GET("/", func(c *gin.Context) {
		c.Header("Cache-Control", "no-cache, no-store, must-revalidate")
		c.File(indexPath)
	})
	r.GET("/index.html", func(c *gin.Context) {
		c.Header("Cache-Control", "no-cache, no-store, must-revalidate")
		c.File(indexPath)
	})
	r.StaticFile("/favicon.ico", filepath.Join(config.PublicDir, "favicon.ico"))
	r.Static("/music", config.MusicDir)
	r.Static("/backgrounds", config.BackgroundsDir)
	r.Static("/mobile_backgrounds", config.MobileBackgroundsDir)
	r.Static("/icon-cache", config.IconCacheDir)
	r.Static("/public", config.PublicDir)
	r.Any("/proxy", handlers.ProxyRequest)

	// Middleware to serve static files from config.PublicDir if they exist
	r.Use(func(c *gin.Context) {
		if strings.HasPrefix(c.Request.URL.Path, "/api") || strings.HasPrefix(c.Request.URL.Path, "/socket.io") {
			c.Next()
			return
		}

		// Check if file exists in PublicDir
		reqPath := c.Request.URL.Path
		filePath := filepath.Join(config.PublicDir, reqPath)
		info, err := os.Stat(filePath)
		if err == nil && !info.IsDir() {
			c.File(filePath)
			c.Abort()
			return
		}

		c.Next()
	})

	// NoRoute handler for SPA（与上面 index 一致：不缓存，避免引用旧 chunk）
	r.NoRoute(func(c *gin.Context) {
		if !strings.HasPrefix(c.Request.URL.Path, "/api") && !strings.HasPrefix(c.Request.URL.Path, "/socket.io") {
			c.Header("Cache-Control", "no-cache, no-store, must-revalidate")
			c.File(filepath.Join(config.PublicDir, "index.html"))
		}
	})

	// API Routes
	api := r.Group("/api")
	{
		api.POST("/login", handlers.Login)
		api.GET("/data", middleware.OptionalAuthMiddleware(), handlers.GetData)
		api.GET("/version", middleware.OptionalAuthMiddleware(), handlers.GetVersion)
		api.GET("/system-config", handlers.GetSystemConfig)
		api.GET("/ip", handlers.GetIP) // Added GetIP
		api.GET("/hot", handlers.GetHot)
		api.GET("/rss", handlers.GetRss)
		api.GET("/weather", handlers.GetWeather)                                                   // Added Weather
		api.GET("/custom-scripts", middleware.OptionalAuthMiddleware(), handlers.GetCustomScripts) // Added Custom Scripts
		api.GET("/docker-status", handlers.GetDockerStatus)                                        // Added Docker Status
		api.GET("/docker/debug", handlers.GetDockerDebug)
		api.GET("/config/proxy-status", handlers.GetProxyStatus)
		api.GET("/widgets/:id", handlers.GetWidget) // Added Widget Data
		api.GET("/memo/:id", middleware.AuthMiddleware(), handlers.GetMemo)

		// Icon Routes
		api.GET("/ali-icons", handlers.GetAliIcons)
		api.GET("/get-icon-base64", handlers.GetIconBase64)
		api.POST("/icon-cache", handlers.CacheIcon)

		// Amap Proxy Routes
		api.GET("/amap/weather", handlers.GetAmapWeather)
		api.GET("/amap/ip", handlers.ProxyAmapIP)

		api.GET("/ping", handlers.Ping)                   // Added Ping
		api.GET("/rtt", handlers.RTT)                     // Added RTT for frontend latency check
		api.POST("/visitor/track", handlers.TrackVisitor) // Public endpoint
		api.GET("/transfer/file/:filename", middleware.OptionalAuthMiddleware(), handlers.ServeFile)
		api.GET("/transfer/thumb/:filename/:size", middleware.OptionalAuthMiddleware(), handlers.ServeThumb)
		api.GET("/music-list", handlers.GetMusicList) // Added Music List

		// Protected Routes
		authorized := api.Group("/")
		authorized.Use(middleware.AuthMiddleware())
		{
			// User Management
			authorized.GET("/admin/users", handlers.GetUsers)
			authorized.POST("/admin/users", handlers.AddUser)
			authorized.DELETE("/admin/users/:usr", handlers.DeleteUser)
			authorized.POST("/admin/license", handlers.UploadLicense)

			authorized.POST("/save", handlers.SaveData) // Added SaveData
			authorized.PUT("/memo/:id", handlers.SaveMemo)
			authorized.POST("/system-config", handlers.UpdateSystemConfig) // Added SystemConfig Update
			authorized.POST("/data/import", handlers.ImportData)           // Added ImportData
			authorized.POST("/default/save", handlers.SaveDefault)
			authorized.POST("/reset", handlers.ResetData)
			authorized.GET("/system/stats", handlers.GetSystemStats)
			authorized.GET("/docker/containers", handlers.ListContainers)
			authorized.GET("/docker/info", handlers.GetDockerInfo)
			authorized.GET("/docker/export-logs", handlers.ExportDockerLogs)
			authorized.GET("/docker/container/:id/inspect-lite", handlers.ContainerInspectLite)
			authorized.POST("/docker/check-updates", handlers.TriggerUpdateCheck)
			authorized.POST("/docker/container/:id/:action", handlers.ContainerAction)
			authorized.POST("/custom-scripts", handlers.SaveCustomScripts)

			// Wallpaper
			authorized.GET("/wallpaper/proxy", handlers.ProxyWallpaper)
			authorized.POST("/wallpaper/resolve", handlers.ResolveWallpaper)
			authorized.POST("/wallpaper/fetch", handlers.FetchWallpaper)

			// Backgrounds Management
			authorized.GET("/backgrounds", handlers.ListBackgrounds)
			authorized.GET("/mobile_backgrounds", handlers.ListMobileBackgrounds)
			authorized.DELETE("/backgrounds/:name", handlers.DeleteBackground)
			authorized.DELETE("/mobile_backgrounds/:name", handlers.DeleteMobileBackground)
			authorized.POST("/backgrounds/upload", handlers.UploadBackground)
			authorized.POST("/mobile_backgrounds/upload", handlers.UploadMobileBackground)
			authorized.POST("/music/upload", handlers.UploadMusic) // Added Music Upload

			// Transfer
			api.GET("/transfer/items", handlers.GetTransferItems)
			authorized.POST("/transfer/text", handlers.SendText)
			authorized.POST("/transfer/upload/init", handlers.UploadInit)
			authorized.POST("/transfer/upload/chunk", handlers.UploadChunk)
			authorized.POST("/transfer/upload/complete", handlers.UploadComplete)
			authorized.POST("/transfer/download-token", handlers.DownloadToken)
			authorized.DELETE("/transfer/items/:id", handlers.DeleteItem)
			authorized.POST("/transfer/generate-thumb/:filename/:size", handlers.GenerateThumb)
			authorized.POST("/transfer/regenerate-thumbs", handlers.RegenerateThumbs)

			// Config Versions
			authorized.GET("/config-versions", handlers.GetConfigVersions)
			authorized.POST("/config-versions", handlers.SaveConfigVersion)
			authorized.POST("/config-versions/restore", handlers.RestoreConfigVersion)
			authorized.DELETE("/config-versions/:id", handlers.DeleteConfigVersion)
		}
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	log.Printf("Server starting on :%s", port)
	if err := r.Run(":" + port); err != nil {
		log.Fatal("Server failed to start: ", err)
	}
	log.Println("Server stopped")
	select {}
}
