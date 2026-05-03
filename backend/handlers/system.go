package handlers

import (
	"encoding/json"
	"flatnasgo-backend/config"
	"flatnasgo-backend/utils"
	"fmt"
	"io"
	"log"
	stdnet "net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"sort"

	"github.com/gin-gonic/gin"
	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/mem"
	"github.com/shirou/gopsutil/v3/net"
)

type NetworkStat struct {
	Iface string `json:"iface"`
	RxSec uint64 `json:"rx_sec"`
	TxSec uint64 `json:"tx_sec"`
}

var (
	lastNetStats        []net.IOCountersStat
	lastNetTime         time.Time
	lastCalculatedRates []NetworkStat
	netMutex            sync.Mutex

	lastCPUTimes []cpu.TimesStat
	lastCPUTime  time.Time
	cpuMutex     sync.Mutex

	systemStatsCache      gin.H
	systemStatsCacheMu    sync.RWMutex
	systemStatsLastUpdate time.Time
	systemStatsTTL        = 3 * time.Second
)

func calculateTotalTime(t cpu.TimesStat) float64 {
	return t.User + t.System + t.Idle + t.Nice + t.Iowait + t.Irq + t.Softirq + t.Steal + t.Guest + t.GuestNice
}

func GetSystemStats(c *gin.Context) {
	systemStatsCacheMu.RLock()
	if systemStatsCache != nil && time.Since(systemStatsLastUpdate) < systemStatsTTL {
		data := systemStatsCache
		systemStatsCacheMu.RUnlock()
		c.JSON(http.StatusOK, gin.H{"success": true, "data": data})
		return
	}
	systemStatsCacheMu.RUnlock()

	systemStatsCacheMu.Lock()
	defer systemStatsCacheMu.Unlock()

	if systemStatsCache != nil && time.Since(systemStatsLastUpdate) < systemStatsTTL {
		c.JSON(http.StatusOK, gin.H{"success": true, "data": systemStatsCache})
		return
	}

	data := collectSystemStats()
	systemStatsCache = data
	systemStatsLastUpdate = time.Now()

	c.JSON(http.StatusOK, gin.H{"success": true, "data": data})
}

func collectSystemStats() gin.H {
	v, _ := mem.VirtualMemory()
	cStats, _ := cpu.Info()

	currentTimes, _ := cpu.Times(false)
	var currentLoad, currentLoadUser, currentLoadSystem float64

	cpuMutex.Lock()
	if len(currentTimes) > 0 {
		now := time.Now()
		if !lastCPUTime.IsZero() && len(lastCPUTimes) > 0 {
			deltaTotal := calculateTotalTime(currentTimes[0]) - calculateTotalTime(lastCPUTimes[0])
			if deltaTotal > 0 {
				currentLoadUser = (currentTimes[0].User - lastCPUTimes[0].User) / deltaTotal * 100
				currentLoadSystem = (currentTimes[0].System - lastCPUTimes[0].System) / deltaTotal * 100
				currentLoad = 100 - ((currentTimes[0].Idle - lastCPUTimes[0].Idle) / deltaTotal * 100)
			}
		}
		lastCPUTimes = currentTimes
		lastCPUTime = now
	}
	cpuMutex.Unlock()

	volume := filepath.VolumeName(config.BaseDir)
	if volume == "" {
		volume = "/"
	} else {
		volume = volume + "\\"
	}
	d, _ := disk.Usage(volume)

	currentNet, _ := net.IOCounters(true)
	now := time.Now()

	netMutex.Lock()
	var networkStats []NetworkStat

	duration := now.Sub(lastNetTime).Seconds()

	if lastNetTime.IsZero() || duration < 1.0 {
		if lastCalculatedRates == nil {
			for _, n := range currentNet {
				networkStats = append(networkStats, NetworkStat{
					Iface: n.Name,
					RxSec: 0,
					TxSec: 0,
				})
			}
			lastNetStats = currentNet
			lastNetTime = now
			lastCalculatedRates = networkStats
		} else {
			networkStats = lastCalculatedRates
		}
	} else {
		currMap := make(map[string]net.IOCountersStat)
		for _, n := range currentNet {
			currMap[n.Name] = n
		}

		lastMap := make(map[string]net.IOCountersStat)
		for _, n := range lastNetStats {
			lastMap[n.Name] = n
		}

		for _, curr := range currentNet {
			rxSec := uint64(0)
			txSec := uint64(0)

			if last, ok := lastMap[curr.Name]; ok {
				if curr.BytesRecv >= last.BytesRecv {
					rxSec = uint64(float64(curr.BytesRecv-last.BytesRecv) / duration)
				}
				if curr.BytesSent >= last.BytesSent {
					txSec = uint64(float64(curr.BytesSent-last.BytesSent) / duration)
				}
			}

			networkStats = append(networkStats, NetworkStat{
				Iface: curr.Name,
				RxSec: rxSec,
				TxSec: txSec,
			})
		}

		lastNetStats = currentNet
		lastNetTime = now
		lastCalculatedRates = networkStats
	}
	netMutex.Unlock()

	sort.Slice(networkStats, func(i, j int) bool {
		return networkStats[i].Iface < networkStats[j].Iface
	})

	h, _ := host.Info()

	brand := "Unknown"
	manufacturer := "Unknown"
	speed := 0.0
	if len(cStats) > 0 {
		brand = cStats[0].ModelName
		manufacturer = cStats[0].VendorID
		speed = cStats[0].Mhz / 1000.0
	}

	return gin.H{
		"cpu": gin.H{
			"currentLoad":       currentLoad,
			"currentLoadUser":   currentLoadUser,
			"currentLoadSystem": currentLoadSystem,
			"cores":             runtime.NumCPU(),
			"brand":             brand,
			"manufacturer":      manufacturer,
			"speed":             speed,
		},
		"mem": gin.H{
			"total":     v.Total,
			"used":      v.Used,
			"active":    v.Active,
			"available": v.Available,
		},
		"disk": []gin.H{
			{
				"fs":    d.Fstype,
				"type":  "Fixed",
				"size":  d.Total,
				"used":  d.Used,
				"use":   d.UsedPercent,
				"mount": d.Path,
			},
		},
		"network": networkStats,
		"os": gin.H{
			"distro":   h.Platform,
			"release":  h.PlatformVersion,
			"hostname": h.Hostname,
			"arch":     h.KernelArch,
		},
		"uptime": h.Uptime,
	}
}

func GetCustomScripts(c *gin.Context) {
	username := c.GetString("username")
	if username == "" {
		c.JSON(http.StatusOK, gin.H{
			"success": true,
			"css":     []interface{}{},
			"js":      []interface{}{},
		})
		return
	}
	path := filepath.Join(config.DataDir, "custom_scripts.json")
	payload := CustomScriptsPayload{
		CSS: []interface{}{},
		JS:  []interface{}{},
	}
	var data map[string]CustomScriptsPayload
	if err := utils.ReadJSON(path, &data); err == nil {
		if entry, ok := data[username]; ok {
			payload = entry
			if payload.CSS == nil {
				payload.CSS = []interface{}{}
			}
			if payload.JS == nil {
				payload.JS = []interface{}{}
			}
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"css":     payload.CSS,
		"js":      payload.JS,
	})
}

type CustomScriptsPayload struct {
	CSS []interface{} `json:"css"`
	JS  []interface{} `json:"js"`
}

func SaveCustomScripts(c *gin.Context) {
	username := c.GetString("username")
	if username == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
		return
	}
	var payload CustomScriptsPayload
	if err := c.ShouldBindJSON(&payload); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid JSON"})
		return
	}
	if payload.CSS == nil {
		payload.CSS = []interface{}{}
	}
	if payload.JS == nil {
		payload.JS = []interface{}{}
	}
	path := filepath.Join(config.DataDir, "custom_scripts.json")
	var data map[string]CustomScriptsPayload
	if err := utils.ReadJSON(path, &data); err != nil || data == nil {
		data = make(map[string]CustomScriptsPayload)
	}
	data[username] = payload
	if err := utils.WriteJSON(path, data); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save custom scripts"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// IPCache holds the cached public IP information
type IPCache struct {
	IP       string
	Location string
	Country  string
	Region   string
	City     string
	Updated  time.Time
	Mutex    sync.RWMutex
}

// IPInfo is a unified struct for IP provider responses
type IPInfo struct {
	IP      string
	City    string
	Region  string
	Country string
	Isp     string
}

var globalIPCache IPCache
var isFetchingIP int32

// StartIPFetcher starts a background goroutine to fetch public IP every 6 hours using fallback chain
func StartIPFetcher() {
	go func() {
		fetchIPAndCache()
		ticker := time.NewTicker(6 * time.Hour)
		for range ticker.C {
			fetchIPAndCache()
		}
	}()
}

// fetchIPFromProvider queries a single IP provider and returns unified IPInfo
func fetchIPFromProvider(provider string) (*IPInfo, error) {
	client := http.Client{Timeout: 3 * time.Second}

	switch provider {
	case "ip-api":
		resp, err := client.Get("http://ip-api.com/json/?lang=zh-CN")
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		var result map[string]interface{}
		if err := json.Unmarshal(body, &result); err != nil {
			return nil, err
		}
		if status, ok := result["status"].(string); ok && status == "fail" {
			return nil, fmt.Errorf("ip-api: status fail")
		}
		info := &IPInfo{}
		if query, ok := result["query"].(string); ok {
			info.IP = query
		}
		if city, ok := result["city"].(string); ok {
			info.City = city
		}
		if region, ok := result["regionName"].(string); ok {
			info.Region = region
		}
		if country, ok := result["country"].(string); ok {
			info.Country = country
		}
		if isp, ok := result["isp"].(string); ok {
			info.Isp = isp
		}
		return info, nil

	case "ipwhois":
		resp, err := client.Get("http://ipwho.is/")
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		var result map[string]interface{}
		if err := json.Unmarshal(body, &result); err != nil {
			return nil, err
		}
		if success, ok := result["success"].(bool); ok && !success {
			return nil, fmt.Errorf("ipwhois: not success")
		}
		info := &IPInfo{}
		if ip, ok := result["ip"].(string); ok {
			info.IP = ip
		}
		if city, ok := result["city"].(string); ok {
			info.City = city
		}
		if region, ok := result["region"].(string); ok {
			info.Region = region
		}
		if country, ok := result["country"].(string); ok {
			info.Country = country
		}
		if isp, ok := result["connection"].(map[string]interface{}); ok {
			if org, exists := isp["org"].(string); exists {
				info.Isp = org
			}
		}
		return info, nil

	case "ipapi-co":
		resp, err := client.Get("https://ipapi.co/json/")
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		var result map[string]interface{}
		if err := json.Unmarshal(body, &result); err != nil {
			return nil, err
		}
		if reason, ok := result["reason"].(string); ok && reason != "" {
			return nil, fmt.Errorf("ipapi.co: %s", reason)
		}
		info := &IPInfo{}
		if ip, ok := result["ip"].(string); ok {
			info.IP = ip
		}
		if city, ok := result["city"].(string); ok {
			info.City = city
		}
		if region, ok := result["region"].(string); ok {
			info.Region = region
		}
		if country, ok := result["country_name"].(string); ok {
			info.Country = country
		}
		if isp, ok := result["org"].(string); ok {
			info.Isp = isp
		}
		return info, nil

	case "freeipapi":
		resp, err := client.Get("https://freeipapi.com/api/json")
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		var result map[string]interface{}
		if err := json.Unmarshal(body, &result); err != nil {
			return nil, err
		}
		info := &IPInfo{}
		if city, ok := result["cityName"].(string); ok {
			info.City = city
		}
		if region, ok := result["regionName"].(string); ok {
			info.Region = region
		}
		if country, ok := result["countryName"].(string); ok {
			info.Country = country
		}
		return info, nil

	default:
		return nil, fmt.Errorf("unknown provider: %s", provider)
	}
}

var ipProviders = []string{"ip-api", "ipwhois", "ipapi-co", "freeipapi"}

func fetchIPAndCache() bool {
	if !atomic.CompareAndSwapInt32(&isFetchingIP, 0, 1) {
		return false
	}
	defer atomic.StoreInt32(&isFetchingIP, 0)

	for _, provider := range ipProviders {
		info, err := fetchIPFromProvider(provider)
		if err != nil {
			log.Printf("[IPFetcher] %s failed: %v", provider, err)
			continue
		}
		if info.City != "" {
			location := info.City
			if info.Region != "" {
				location = info.Region + " " + location
			}
			if info.Country != "" {
				location = info.Country + " " + location
			}
			if info.Isp != "" {
				location = location + " " + info.Isp
			}
			globalIPCache.Mutex.Lock()
			globalIPCache.IP = info.IP
			globalIPCache.City = info.City
			globalIPCache.Region = info.Region
			globalIPCache.Country = info.Country
			globalIPCache.Location = location
			globalIPCache.Updated = time.Now()
			globalIPCache.Mutex.Unlock()
			log.Printf("[IPFetcher] Success via %s: %s", provider, info.City)
			return true
		}
	}
	log.Println("[IPFetcher] All providers failed")
	return false
}

func GetIP(c *gin.Context) {
	clientIp, clientIpSource := extractClientIP(c.Request)
	refresh := strings.TrimSpace(c.Query("refresh"))
	refreshed := false
	if refresh == "1" || strings.EqualFold(refresh, "true") {
		fetchIPAndCache()
		refreshed = true
	}

	globalIPCache.Mutex.RLock()
	ip := globalIPCache.IP
	location := globalIPCache.Location
	country := globalIPCache.Country
	region := globalIPCache.Region
	city := globalIPCache.City
	updated := globalIPCache.Updated
	globalIPCache.Mutex.RUnlock()

	// Check if cache is still valid (30 min TTL)
	cacheValid := ip != "" && time.Since(updated) < 30*time.Minute

	if cacheValid {
		c.JSON(http.StatusOK, gin.H{
			"success":        true,
			"ip":             ip,
			"location":       location,
			"country":        country,
			"region":         region,
			"city":           city,
			"queryIp":        ip,
			"clientIp":       clientIp,
			"clientIpSource": clientIpSource,
			"cached":         true,
		})
		return
	}

	// Cache expired or empty, try to fetch
	if refreshed {
		// Just tried and failed
		c.JSON(http.StatusOK, gin.H{
			"success":        false,
			"ip":             clientIp,
			"clientIp":       clientIp,
			"clientIpSource": clientIpSource,
		})
		return
	}

	// Try fetching now
	if fetchIPAndCache() {
		globalIPCache.Mutex.RLock()
		c.JSON(http.StatusOK, gin.H{
			"success":        true,
			"ip":             globalIPCache.IP,
			"location":       globalIPCache.Location,
			"country":        globalIPCache.Country,
			"region":         globalIPCache.Region,
			"city":           globalIPCache.City,
			"queryIp":        globalIPCache.IP,
			"clientIp":       clientIp,
			"clientIpSource": clientIpSource,
			"cached":         false,
		})
		globalIPCache.Mutex.RUnlock()
		return
	}

	// All failed
	c.JSON(http.StatusOK, gin.H{
		"success":        false,
		"ip":             clientIp,
		"clientIp":       clientIp,
		"clientIpSource": clientIpSource,
	})
}

func extractClientIP(r *http.Request) (string, string) {
	if r == nil {
		return "", "unknown"
	}
	headerKeys := []string{"CF-Connecting-IP", "True-Client-IP", "X-Real-IP"}
	for _, key := range headerKeys {
		if ip := normalizeIPString(r.Header.Get(key)); ip != "" {
			return ip, "header"
		}
	}
	if ip := firstXForwardedForIP(r.Header.Get("X-Forwarded-For")); ip != "" {
		return ip, "header"
	}
	if ip := normalizeIPString(r.RemoteAddr); ip != "" {
		return ip, "remoteAddr"
	}
	return "", "unknown"
}

func firstXForwardedForIP(xff string) string {
	raw := strings.TrimSpace(xff)
	if raw == "" {
		return ""
	}
	parts := strings.Split(raw, ",")
	for _, part := range parts {
		if ip := normalizeIPString(part); ip != "" {
			return ip
		}
	}
	return ""
}

func normalizeIPString(raw string) string {
	v := strings.TrimSpace(raw)
	if v == "" {
		return ""
	}
	v = strings.Trim(v, "[]")
	if host, _, err := stdnet.SplitHostPort(v); err == nil {
		v = host
	}
	v = strings.TrimSpace(strings.Trim(v, "[]"))
	ip := stdnet.ParseIP(v)
	if ip == nil {
		return ""
	}
	return ip.String()
}

func getLocationString(data map[string]interface{}) string {
	parts := []string{}
	if country, ok := data["country"].(string); ok {
		parts = append(parts, country)
	}
	if region, ok := data["regionName"].(string); ok {
		parts = append(parts, region)
	}
	if city, ok := data["city"].(string); ok {
		parts = append(parts, city)
	}
	if isp, ok := data["isp"].(string); ok {
		parts = append(parts, isp)
	}
	return strings.Join(parts, " ")
}

// Ping handles latency check
func Ping(c *gin.Context) {
	target := c.Query("target")
	if target == "" {
		target = "223.5.5.5"
	}

	// Ping implementation based on OS
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		// -n 1: count 1
		// -w 1000: timeout 1000ms
		cmd = exec.Command("ping", "-n", "1", "-w", "1000", target)
	} else {
		// Linux/Unix
		// -c 1: count 1
		// -W 1: timeout 1 second
		cmd = exec.Command("ping", "-c", "1", "-W", "1", target)
	}
	output, err := cmd.CombinedOutput()

	if err != nil {
		c.JSON(http.StatusOK, gin.H{
			"success": false,
			"error":   "Ping failed",
		})
		return
	}

	outStr := string(output)
	// Look for time=XXms
	// Windows output: "Reply from ... time=12ms ..."
	// Linux output: "... time=12.3 ms"
	// Chinese output: "来自 ... 时间=12ms ..."
	// Regex to capture digits and optional decimals, allowing optional space before ms
	// Modified to be more permissive for Windows GBK output (ignoring the "time" label which might be garbled)
	re := regexp.MustCompile(`[=<]([\d\.]+) ?ms`)
	matches := re.FindStringSubmatch(outStr)

	if len(matches) > 1 {
		c.JSON(http.StatusOK, gin.H{
			"success": true,
			"latency": matches[1] + "ms",
		})
	} else {
		// Try to handle "0ms" or "<1ms"
		if strings.Contains(outStr, "<1ms") {
			c.JSON(http.StatusOK, gin.H{
				"success": true,
				"latency": "<1ms",
			})
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"success": false,
			"error":   "Could not parse latency",
		})
	}
}

// GetMusicList returns list of music files
func GetMusicList(c *gin.Context) {
	var files []string
	err := filepath.Walk(config.MusicDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() {
			ext := strings.ToLower(filepath.Ext(path))
			if ext == ".mp3" || ext == ".flac" || ext == ".wav" || ext == ".m4a" || ext == ".ogg" {
				rel, _ := filepath.Rel(config.MusicDir, path)
				// Convert windows path separator to forward slash for web url
				rel = strings.ReplaceAll(rel, "\\", "/")
				files = append(files, rel)
			}
		}
		return nil
	})

	if err != nil {
		c.JSON(http.StatusInternalServerError, []string{})
		return
	}

	c.JSON(http.StatusOK, files)
}

// RTT handles simple round-trip time check
func RTT(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"time":    time.Now().UnixNano(),
	})
}
