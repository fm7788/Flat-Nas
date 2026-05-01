package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"github.com/gin-gonic/gin"
)

var dockerClient *client.Client
var dockerHostUsed string
var dockerInitError error
var updateStatus UpdateCheckStatus
var updateStatusMu sync.RWMutex
var containerUpdateCache = map[string]bool{}
var containerUpdateMu sync.RWMutex
var statsCache = map[string]statsCacheEntry{}
var statsCacheMu sync.RWMutex
var statsCollectMu sync.Mutex
var statsCollecting atomic.Bool
var lastStatsCollect time.Time
var statsTTL = 10 * time.Second

func InitDocker() {
	if !dockerEnabled() {
		dockerClient = nil
		dockerHostUsed = ""
		dockerInitError = nil
		return
	}
	host := resolveDockerHost()
	opts := []client.Opt{client.WithAPIVersionNegotiation()}
	if host == "" {
		opts = append(opts, client.FromEnv)
	} else {
		opts = append(opts, client.WithHost(host))
	}
	var err error
	dockerClient, err = client.NewClientWithOpts(opts...)
	dockerHostUsed = host
	if err != nil {
		log.Printf("Failed to init docker client: %v", err)
		dockerClient = nil
		dockerInitError = err
	} else {
		dockerInitError = nil
	}
}

func dockerEnabled() bool {
	return getCachedSystemConfig().EnableDocker
}

func resolveDockerHost() string {
	sysConfig := getCachedSystemConfig()
	if strings.TrimSpace(sysConfig.DockerHost) != "" {
		host := normalizeDockerHost(sysConfig.DockerHost)
		if !isHostIncompatible(host) {
			return host
		}
	}
	if env := strings.TrimSpace(os.Getenv("DOCKER_HOST")); env != "" {
		host := normalizeDockerHost(env)
		if !isHostIncompatible(host) {
			return host
		}
	}
	return defaultDockerHost()
}

func isHostIncompatible(host string) bool {
	v := strings.TrimSpace(host)
	if v == "" {
		return false
	}
	lower := strings.ToLower(v)
	if runtime.GOOS == "windows" {
		return strings.HasPrefix(lower, "unix://")
	}
	if strings.HasPrefix(lower, "npipe://") {
		return true
	}
	if strings.Contains(lower, "pipe/docker_engine") {
		return true
	}
	if strings.Contains(lower, `\\.\pipe\`) {
		return true
	}
	if strings.Contains(lower, "//./pipe/") {
		return true
	}
	return false
}

func normalizeDockerHost(raw string) string {
	v := strings.TrimSpace(raw)
	if v == "" {
		return ""
	}
	lower := strings.ToLower(v)
	if strings.HasPrefix(lower, "unix://") ||
		strings.HasPrefix(lower, "npipe://") ||
		strings.HasPrefix(lower, "tcp://") ||
		strings.HasPrefix(lower, "http://") ||
		strings.HasPrefix(lower, "https://") {
		return v
	}
	if strings.HasPrefix(v, "//./pipe/") {
		return "npipe:////./pipe/" + strings.TrimPrefix(v, "//./pipe/")
	}
	if strings.HasPrefix(v, `\\.\pipe\`) {
		return "npipe:////./pipe/" + strings.TrimPrefix(v, `\\.\pipe\`)
	}
	if strings.HasPrefix(v, "/") {
		return "unix://" + v
	}
	if runtime.GOOS == "windows" && strings.Contains(v, "pipe/docker_engine") {
		return "npipe:////./pipe/docker_engine"
	}
	if strings.Count(v, ":") == 1 && !strings.Contains(v, "://") {
		return "tcp://" + v
	}
	return v
}

func defaultDockerHost() string {
	switch runtime.GOOS {
	case "windows":
		return "npipe:////./pipe/docker_engine"
	case "linux", "darwin":
		return "unix:///var/run/docker.sock"
	default:
		return ""
	}
}

func getDockerClient() *client.Client {
	if !dockerEnabled() {
		return nil
	}
	host := resolveDockerHost()
	if dockerClient == nil || host != dockerHostUsed {
		InitDocker()
	}
	return dockerClient
}

type DockerState string

const (
	DockerStateDisabled    DockerState = "disabled"
	DockerStateUnavailable DockerState = "unavailable"
	DockerStateReady       DockerState = "ready"
)

func dockerStateFromClient(dc *client.Client) DockerState {
	if !dockerEnabled() {
		return DockerStateDisabled
	}
	if dc == nil {
		return DockerStateUnavailable
	}
	return DockerStateReady
}

func dockerUnavailableError() string {
	if !dockerEnabled() {
		return "Docker is disabled"
	}
	if dockerInitError != nil {
		return dockerInitError.Error()
	}
	return "Docker not available"
}

type UpdateFailure struct {
	Name  string `json:"name"`
	Error string `json:"error"`
}

type UpdateCheckStatus struct {
	LastCheck    int64           `json:"lastCheck"`
	IsChecking   bool            `json:"isChecking"`
	LastError    string          `json:"lastError"`
	CheckedCount int             `json:"checkedCount"`
	TotalCount   int             `json:"totalCount,omitempty"`
	UpdateCount  int             `json:"updateCount"`
	Failures     []UpdateFailure `json:"failures,omitempty"`
}

type DockerNetIO struct {
	Rx uint64 `json:"rx"`
	Tx uint64 `json:"tx"`
}

type DockerBlockIO struct {
	Read  uint64 `json:"read"`
	Write uint64 `json:"write"`
}

type DockerStatsLite struct {
	CpuPercent float64        `json:"cpuPercent"`
	MemUsage   uint64         `json:"memUsage"`
	MemLimit   uint64         `json:"memLimit"`
	MemPercent float64        `json:"memPercent"`
	NetIO      *DockerNetIO   `json:"netIO,omitempty"`
	BlockIO    *DockerBlockIO `json:"blockIO,omitempty"`
}

type statsCacheEntry struct {
	Stats DockerStatsLite
	Ts    time.Time
}

type DockerContainerResponse struct {
	types.Container
	HasUpdate bool             `json:"hasUpdate"`
	Stats     *DockerStatsLite `json:"stats,omitempty"`
}

func fetchContainerStats(ctx context.Context, dc *client.Client, id string) (*DockerStatsLite, error) {
	resp, err := dc.ContainerStats(ctx, id, false)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var parsed types.StatsJSON
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, err
	}
	stats := calculateStats(&parsed)
	return &stats, nil
}

func calculateStats(s *types.StatsJSON) DockerStatsLite {
	var cpuPercent float64
	cpuStats := s.CPUStats
	preCPUStats := s.PreCPUStats
	cpuDelta := float64(cpuStats.CPUUsage.TotalUsage - preCPUStats.CPUUsage.TotalUsage)
	systemDelta := float64(cpuStats.SystemUsage - preCPUStats.SystemUsage)
	onlineCPUs := float64(cpuStats.OnlineCPUs)
	if onlineCPUs == 0 && len(cpuStats.CPUUsage.PercpuUsage) > 0 {
		onlineCPUs = float64(len(cpuStats.CPUUsage.PercpuUsage))
	}
	if systemDelta > 0 && cpuDelta > 0 && onlineCPUs > 0 {
		cpuPercent = (cpuDelta / systemDelta) * onlineCPUs * 100.0
	}

	memUsage := s.MemoryStats.Usage
	if v, ok := s.MemoryStats.Stats["cache"]; ok && memUsage > v {
		memUsage -= v
	} else if v, ok := s.MemoryStats.Stats["inactive_file"]; ok && memUsage > v {
		memUsage -= v
	}
	memLimit := s.MemoryStats.Limit
	memPercent := 0.0
	if memLimit > 0 {
		memPercent = float64(memUsage) / float64(memLimit) * 100.0
	}

	var netRx uint64
	var netTx uint64
	if s.Networks != nil {
		for _, n := range s.Networks {
			netRx += n.RxBytes
			netTx += n.TxBytes
		}
	}
	var blockRead uint64
	var blockWrite uint64
	for _, entry := range s.BlkioStats.IoServiceBytesRecursive {
		switch strings.ToLower(entry.Op) {
		case "read":
			blockRead += entry.Value
		case "write":
			blockWrite += entry.Value
		}
	}

	var netIO *DockerNetIO
	if netRx > 0 || netTx > 0 {
		netIO = &DockerNetIO{Rx: netRx, Tx: netTx}
	}
	var blockIO *DockerBlockIO
	if blockRead > 0 || blockWrite > 0 {
		blockIO = &DockerBlockIO{Read: blockRead, Write: blockWrite}
	}

	return DockerStatsLite{
		CpuPercent: cpuPercent,
		MemUsage:   memUsage,
		MemLimit:   memLimit,
		MemPercent: memPercent,
		NetIO:      netIO,
		BlockIO:    blockIO,
	}
}

func collectStatsIfNeeded(dc *client.Client, containers []types.Container) {
	running := make([]types.Container, 0)
	for _, ctn := range containers {
		if strings.EqualFold(ctn.State, "running") {
			running = append(running, ctn)
		}
	}

	statsCollectMu.Lock()
	defer statsCollectMu.Unlock()

	now := time.Now()
	allFresh := true
	statsCacheMu.RLock()
	for _, ctn := range running {
		entry, ok := statsCache[ctn.ID]
		if !ok || now.Sub(entry.Ts) > statsTTL {
			allFresh = false
			break
		}
	}
	statsCacheMu.RUnlock()
	if allFresh && now.Sub(lastStatsCollect) < statsTTL {
		return
	}

	type task struct{ id string }
	tasks := make(chan task, len(running))
	for _, ctn := range running {
		tasks <- task{id: ctn.ID}
	}
	close(tasks)

	const workerCount = 5
	var wg sync.WaitGroup
	for w := 0; w < workerCount; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for t := range tasks {
				ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
				stats, err := fetchContainerStats(ctx, dc, t.id)
				cancel()
				if err != nil || stats == nil {
					continue
				}
				statsCacheMu.Lock()
				statsCache[t.id] = statsCacheEntry{Stats: *stats, Ts: time.Now()}
				statsCacheMu.Unlock()
			}
		}()
	}
	wg.Wait()
	lastStatsCollect = time.Now()

	runningIDs := make(map[string]struct{}, len(running))
	for _, ctn := range running {
		runningIDs[ctn.ID] = struct{}{}
	}
	statsCacheMu.Lock()
	for id := range statsCache {
		if _, ok := runningIDs[id]; !ok {
			delete(statsCache, id)
		}
	}
	statsCacheMu.Unlock()
}

func ListContainers(c *gin.Context) {
	if !dockerEnabled() {
		c.JSON(http.StatusOK, gin.H{
			"success": false,
			"state":   string(DockerStateDisabled),
			"error":   dockerUnavailableError(),
			"data":    []interface{}{},
		})
		return
	}
	dc := getDockerClient()
	if dc == nil {
		c.JSON(http.StatusOK, gin.H{
			"success": false,
			"state":   string(DockerStateUnavailable),
			"error":   dockerUnavailableError(),
			"data":    []interface{}{},
		})
		return
	}

	containers, err := dc.ContainerList(context.Background(), container.ListOptions{All: true})
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "error": err.Error(), "data": []interface{}{}})
		return
	}

	if statsCollecting.CompareAndSwap(false, true) {
		go func() {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("Recovered from panic in collectStatsIfNeeded: %v", r)
				}
				statsCollecting.Store(false)
			}()
			collectStatsIfNeeded(dc, containers)
		}()
	}

	containerUpdateMu.RLock()
	updateMap := make(map[string]bool, len(containerUpdateCache))
	for k, v := range containerUpdateCache {
		updateMap[k] = v
	}
	containerUpdateMu.RUnlock()

	statsCacheMu.RLock()
	statsMap := make(map[string]statsCacheEntry, len(statsCache))
	for k, v := range statsCache {
		statsMap[k] = v
	}
	statsCacheMu.RUnlock()

	enriched := make([]DockerContainerResponse, 0, len(containers))
	now := time.Now()
	for _, ctn := range containers {
		hasUpdate := updateMap[ctn.ID]
		var stats *DockerStatsLite
		if entry, ok := statsMap[ctn.ID]; ok && now.Sub(entry.Ts) < statsTTL*3 {
			copyStats := entry.Stats
			stats = &copyStats
		}
		enriched = append(enriched, DockerContainerResponse{
			Container: ctn,
			HasUpdate: hasUpdate,
			Stats:     stats,
		})
	}

	updateStatusMu.RLock()
	us := updateStatus
	updateStatusMu.RUnlock()
	c.JSON(http.StatusOK, gin.H{
		"success":      true,
		"state":        string(DockerStateReady),
		"data":         enriched,
		"updateStatus": us,
	})
}

func GetDockerStatus(c *gin.Context) {
	if !dockerEnabled() {
		c.JSON(http.StatusOK, gin.H{
			"state":     string(DockerStateDisabled),
			"hasUpdate": false,
		})
		return
	}
	dc := getDockerClient()
	if dc == nil {
		c.JSON(http.StatusOK, gin.H{
			"state":     string(DockerStateUnavailable),
			"hasUpdate": false,
		})
		return
	}
	updateStatusMu.RLock()
	hasUpdate := updateStatus.UpdateCount > 0
	updateStatusMu.RUnlock()
	c.JSON(http.StatusOK, gin.H{
		"state":     string(DockerStateReady),
		"hasUpdate": hasUpdate,
	})
}

func ContainerAction(c *gin.Context) {
	username := c.GetString("username")
	if username != "admin" {
		c.JSON(http.StatusForbidden, gin.H{"error": "Permission denied"})
		return
	}

	id := c.Param("id")
	action := c.Param("action")

	if !dockerEnabled() {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"success": false,
			"state":   string(DockerStateDisabled),
			"error":   dockerUnavailableError(),
		})
		return
	}
	dc := getDockerClient()
	if dc == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"success": false,
			"state":   string(DockerStateUnavailable),
			"error":   dockerUnavailableError(),
		})
		return
	}

	ctx := context.Background()
	var err error

	switch action {
	case "start":
		err = dc.ContainerStart(ctx, id, container.StartOptions{})
	case "stop":
		err = dc.ContainerStop(ctx, id, container.StopOptions{})
	case "restart":
		err = dc.ContainerRestart(ctx, id, container.StopOptions{})
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid action"})
		return
	}

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "state": string(DockerStateReady)})
}

func GetDockerInfo(c *gin.Context) {
	if !dockerEnabled() {
		c.JSON(http.StatusOK, gin.H{
			"success":    false,
			"state":      string(DockerStateDisabled),
			"error":      dockerUnavailableError(),
			"socketPath": resolveDockerHost(),
		})
		return
	}
	dc := getDockerClient()
	if dc == nil {
		c.JSON(http.StatusOK, gin.H{
			"success":    false,
			"state":      string(DockerStateUnavailable),
			"error":      dockerUnavailableError(),
			"socketPath": resolveDockerHost(),
		})
		return
	}
	info, err := dc.Info(context.Background())
	if err != nil {
		c.JSON(http.StatusOK, gin.H{
			"success":    false,
			"state":      string(DockerStateUnavailable),
			"error":      err.Error(),
			"socketPath": dc.DaemonHost(),
		})
		return
	}
	version, err := dc.ServerVersion(context.Background())
	if err != nil {
		c.JSON(http.StatusOK, gin.H{
			"success":    true,
			"state":      string(DockerStateReady),
			"info":       info,
			"version":    types.Version{},
			"socketPath": dc.DaemonHost(),
		})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success":    true,
		"state":      string(DockerStateReady),
		"info":       info,
		"version":    version,
		"socketPath": dc.DaemonHost(),
	})
}

type DockerDebugSnapshot struct {
	State              string `json:"state"`
	EnableDocker       bool   `json:"enableDocker"`
	DockerHostRaw      string `json:"dockerHostRaw"`
	DockerHostEnv      string `json:"dockerHostEnv"`
	DockerHostResolved string `json:"dockerHostResolved"`
	ClientAvailable    bool   `json:"clientAvailable"`
	DaemonHost         string `json:"daemonHost"`
	PingOk             bool   `json:"pingOk"`
	PingError          string `json:"pingError"`
	InitError          string `json:"initError"`
}

type DockerLogExport struct {
	GeneratedAt      int64               `json:"generatedAt"`
	Docker           DockerDebugSnapshot `json:"docker"`
	UpdateStatus     UpdateCheckStatus   `json:"updateStatus"`
	UpdatedContainer []string            `json:"updatedContainer,omitempty"`
}

func buildDockerDebugSnapshot() DockerDebugSnapshot {
	sysConfig := getCachedSystemConfig()

	dockerHostRaw := strings.TrimSpace(sysConfig.DockerHost)
	dockerHostEnv := strings.TrimSpace(os.Getenv("DOCKER_HOST"))
	dockerHostResolved := resolveDockerHost()

	enabled := sysConfig.EnableDocker
	dc := getDockerClient()
	clientAvailable := dc != nil
	daemonHost := ""
	pingOk := false
	pingError := ""
	if dc != nil {
		daemonHost = dc.DaemonHost()
		if _, err := dc.Ping(context.Background()); err != nil {
			pingError = err.Error()
		} else {
			pingOk = true
		}
	}

	initError := ""
	if dockerInitError != nil {
		initError = dockerInitError.Error()
	}

	return DockerDebugSnapshot{
		State:              string(dockerStateFromClient(dc)),
		EnableDocker:       enabled,
		DockerHostRaw:      dockerHostRaw,
		DockerHostEnv:      dockerHostEnv,
		DockerHostResolved: dockerHostResolved,
		ClientAvailable:    clientAvailable,
		DaemonHost:         daemonHost,
		PingOk:             pingOk,
		PingError:          pingError,
		InitError:          initError,
	}
}

func GetDockerDebug(c *gin.Context) {
	snapshot := buildDockerDebugSnapshot()
	c.JSON(http.StatusOK, snapshot)
}

func ExportDockerLogs(c *gin.Context) {
	updateStatusMu.RLock()
	us := updateStatus
	updateStatusMu.RUnlock()

	containerUpdateMu.RLock()
	updated := make([]string, 0, len(containerUpdateCache))
	for id, hasUpdate := range containerUpdateCache {
		if hasUpdate {
			updated = append(updated, id)
		}
	}
	containerUpdateMu.RUnlock()

	payload := DockerLogExport{
		GeneratedAt:      time.Now().UnixMilli(),
		Docker:           buildDockerDebugSnapshot(),
		UpdateStatus:     us,
		UpdatedContainer: updated,
	}
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to export logs"})
		return
	}
	filename := fmt.Sprintf("docker-logs-%s.json", time.Now().Format("20060102-150405"))
	c.Header("Content-Type", "application/json")
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", filename))
	c.Data(http.StatusOK, "application/json", data)
}

type InspectLite struct {
	NetworkMode string `json:"networkMode"`
	Ports       []int  `json:"ports"`
}

func ContainerInspectLite(c *gin.Context) {
	if !dockerEnabled() {
		c.JSON(http.StatusOK, gin.H{
			"success": false,
			"state":   string(DockerStateDisabled),
			"error":   dockerUnavailableError(),
		})
		return
	}
	dc := getDockerClient()
	if dc == nil {
		c.JSON(http.StatusOK, gin.H{
			"success": false,
			"state":   string(DockerStateUnavailable),
			"error":   dockerUnavailableError(),
		})
		return
	}
	id := c.Param("id")
	ctx := context.Background()
	inspected, err := dc.ContainerInspect(ctx, id)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "error": err.Error()})
		return
	}
	networkMode := string(inspected.HostConfig.NetworkMode)
	ports := []int{}
	if inspected.NetworkSettings != nil && inspected.NetworkSettings.Ports != nil {
		for _, bindings := range inspected.NetworkSettings.Ports {
			for _, b := range bindings {
				if b.HostPort != "" {
					if v, err := strconv.Atoi(b.HostPort); err == nil && v > 0 && v <= 65535 {
						ports = append(ports, v)
					}
				}
			}
		}
	}
	if len(ports) == 0 && strings.EqualFold(networkMode, "host") {
		if inspected.Config != nil {
			for p := range inspected.Config.ExposedPorts {
				s := string(p)
				if idx := strings.IndexByte(s, '/'); idx > 0 {
					s = s[:idx]
				}
				if v, err := strconv.Atoi(s); err == nil && v > 0 && v <= 65535 {
					ports = append(ports, v)
				}
			}
		}
	}
	data := InspectLite{NetworkMode: networkMode, Ports: ports}
	c.JSON(http.StatusOK, gin.H{"success": true, "state": string(DockerStateReady), "data": data})
}

func TriggerUpdateCheck(c *gin.Context) {
	username := c.GetString("username")
	if username != "admin" {
		c.JSON(http.StatusForbidden, gin.H{"error": "Permission denied"})
		return
	}
	if !dockerEnabled() {
		c.JSON(http.StatusOK, gin.H{
			"success": false,
			"state":   string(DockerStateDisabled),
			"error":   dockerUnavailableError(),
		})
		return
	}
	dc := getDockerClient()
	if dc == nil {
		c.JSON(http.StatusOK, gin.H{
			"success": false,
			"state":   string(DockerStateUnavailable),
			"error":   dockerUnavailableError(),
		})
		return
	}
	updateStatusMu.Lock()
	if updateStatus.IsChecking {
		updateStatusMu.Unlock()
		c.JSON(http.StatusOK, gin.H{"success": true, "state": string(DockerStateReady)})
		return
	}
	updateStatus.IsChecking = true
	updateStatus.LastError = ""
	updateStatus.CheckedCount = 0
	updateStatus.UpdateCount = 0
	updateStatus.Failures = nil
	updateStatusMu.Unlock()
	go func() {
		ctx := context.Background()
		list, err := dc.ContainerList(ctx, container.ListOptions{All: false})
		total := 0
		if err == nil {
			total = len(list)
		}
		updateStatusMu.Lock()
		updateStatus.TotalCount = total
		updateStatusMu.Unlock()
		if err != nil {
			updateStatusMu.Lock()
			updateStatus.LastError = err.Error()
			updateStatus.IsChecking = false
			updateStatus.LastCheck = time.Now().UnixMilli()
			updateStatusMu.Unlock()
			return
		}
		updates := make(map[string]bool, len(list))
		for _, ctn := range list {
			updateStatusMu.Lock()
			updateStatus.CheckedCount++
			updateStatusMu.Unlock()

			imageRef, ok := resolveTaggedImageRef(ctn.Image)
			if !ok {
				updates[ctn.ID] = false
				continue
			}
			pullCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
			rc, err := dc.ImagePull(pullCtx, imageRef, types.ImagePullOptions{})
			cancel()
			if err != nil {
				addUpdateFailure(ctn, err)
				updates[ctn.ID] = false
				continue
			}
			_, _ = io.Copy(io.Discard, rc)
			_ = rc.Close()

			inspected, _, err := dc.ImageInspectWithRaw(ctx, imageRef)
			if err != nil {
				addUpdateFailure(ctn, err)
				updates[ctn.ID] = false
				continue
			}
			if inspected.ID != "" && inspected.ID != ctn.ImageID {
				updateStatusMu.Lock()
				updateStatus.UpdateCount++
				updateStatusMu.Unlock()
				updates[ctn.ID] = true
			} else {
				updates[ctn.ID] = false
			}
		}
		containerUpdateMu.Lock()
		containerUpdateCache = updates
		containerUpdateMu.Unlock()
		updateStatusMu.Lock()
		updateStatus.IsChecking = false
		updateStatus.LastCheck = time.Now().UnixMilli()
		updateStatusMu.Unlock()
	}()
	c.JSON(http.StatusOK, gin.H{"success": true, "state": string(DockerStateReady)})
}

func resolveTaggedImageRef(image string) (string, bool) {
	image = strings.TrimSpace(image)
	if image == "" {
		return "", false
	}
	if strings.Contains(image, "@") {
		return "", false
	}
	lastColon := strings.LastIndex(image, ":")
	lastSlash := strings.LastIndex(image, "/")
	if lastColon > lastSlash {
		return image, true
	}
	return "", false
}

func addUpdateFailure(ctn types.Container, err error) {
	name := ctn.ID
	if len(ctn.Names) > 0 {
		name = strings.TrimPrefix(ctn.Names[0], "/")
	}
	updateStatusMu.Lock()
	updateStatus.Failures = append(updateStatus.Failures, UpdateFailure{
		Name:  name,
		Error: err.Error(),
	})
	updateStatusMu.Unlock()
}
