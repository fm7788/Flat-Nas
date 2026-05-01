package handlers

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"flatnasgo-backend/config"
)

// WeatherPoller periodically fetches weather for all configured cities
type WeatherPoller struct {
	mu      sync.RWMutex
	ticker  *time.Ticker
	running bool
	// track last poll times per city for error-retry logic
	lastPoll map[string]time.Time
}

var sharedWeatherPoller = &WeatherPoller{
	lastPoll: make(map[string]time.Time),
}

// NewWeatherPoller creates a new poller
func NewWeatherPoller() *WeatherPoller {
	return sharedWeatherPoller
}

// Start launches the background polling loop. Call once at server startup.
func (p *WeatherPoller) Start() {
	p.mu.Lock()
	if p.running {
		p.mu.Unlock()
		return
	}
	p.running = true
	p.mu.Unlock()

	// Run immediately on startup
	go func() {
		p.RunOnce()
		// Then poll every 30 minutes
		p.ticker = time.NewTicker(30 * time.Minute)
		defer p.ticker.Stop()
		for range p.ticker.C {
			p.RunOnce()
		}
	}()
	log.Println("[WeatherPoller] Started (30min interval)")
}

// RunOnce fetches weather for all known cities
func (p *WeatherPoller) RunOnce() {
	log.Println("[WeatherPoller] Running full poll...")
	cities := p.collectAllCities()
	if len(cities) == 0 {
		log.Println("[WeatherPoller] No cities to poll")
		return
	}

	for _, city := range cities {
		p.pollCity(city)
		// Small delay between cities to avoid rate limiting
		time.Sleep(1 * time.Second)
	}
	log.Printf("[WeatherPoller] Poll complete for %d cities\n", len(cities))
}

// TriggerSingleCity immediately fetches weather for a single city (for new city cold-start)
func (p *WeatherPoller) TriggerSingleCity(city string) {
	if city == "" {
		return
	}
	log.Printf("[WeatherPoller] Triggering single city poll: %s", city)
	go p.pollCity(city)
}

// pollCity fetches weather for one city and writes to widget_cache
func (p *WeatherPoller) pollCity(city string) error {
	// Check if this city has an error status in cache that's still within 1min TTL
	cacheKey := city + "|openmeteo|||"
	var cached WeatherData
	hasCache, isFresh, item, _ := sharedWidgetCache.Get(widgetCacheKindWeather, cacheKey, &cached)
	if hasCache && item != nil && item.SourceStatus == "error" && isFresh {
		// Error cache still within 1min TTL, skip retry
		return fmt.Errorf("city %s in error cooldown", city)
	}

	// Try Open-Meteo first (with geocoding cache)
	data, err := fetchOpenMeteoWithGeoCache(city, sharedGeoCache)
	if err == nil && data != nil {
		_ = sharedWidgetCache.Set(widgetCacheKindWeather, cacheKey, data, 0, "ok")
		p.mu.Lock()
		p.lastPoll[city] = time.Now()
		p.mu.Unlock()
		return nil
	}

	// Fallback to Amap if configured
	amapKey := ""
	// Try to get Amap key from default.json (global config)
	var defaultData map[string]interface{}
	if err := readDefaultData(&defaultData); err == nil {
		if appCfg, ok := defaultData["appConfig"].(map[string]interface{}); ok {
			if key, ok := appCfg["amapKey"].(string); ok {
				amapKey = key
			}
		}
	}

	if amapKey != "" {
		log.Printf("[WeatherPoller] Open-Meteo failed for %s, trying Amap fallback", city)
		amapData, amapErr := fetchAmap(city, amapKey)
		if amapErr == nil && amapData != nil {
			_ = sharedWidgetCache.Set(widgetCacheKindWeather, city+"|amap|"+amapKey+"|||", amapData, 0, "ok")
			p.mu.Lock()
			p.lastPoll[city] = time.Now()
			p.mu.Unlock()
			return nil
		}
		log.Printf("[WeatherPoller] Amap also failed for %s: %v", city, amapErr)
	}

	// Mark as error with 1min TTL for retry
	_ = sharedWidgetCache.MarkStatus(widgetCacheKindWeather, cacheKey, "error")
	// Set error entry with 1min TTL
	_ = sharedWidgetCache.Set(widgetCacheKindWeather, cacheKey, &WeatherData{
		City: city,
		Text: "获取失败",
		Temp: "--",
	}, 60*time.Second, "error")

	p.mu.Lock()
	p.lastPoll[city] = time.Now()
	p.mu.Unlock()
	return fmt.Errorf("all weather sources failed for %s", city)
}

// collectAllCities scans all user data files and extracts unique city names from weather widgets
func (p *WeatherPoller) collectAllCities() []string {
	citySet := make(map[string]bool)

	// Scan all user JSON files
	scanDir := func(dir string) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			ext := filepath.Ext(entry.Name())
			if ext != ".json" {
				continue
			}
			filePath := filepath.Join(dir, entry.Name())
			var data map[string]interface{}
			if err := readJSONFile(filePath, &data); err != nil {
				continue
			}
			extractCitiesFromData(data, citySet)
		}
	}

	// Scan users directory
	scanDir(config.UsersDir)
	// Also scan admin data file (data.json)
	adminFile := filepath.Join(config.DataDir, "data.json")
	var adminData map[string]interface{}
	if err := readJSONFile(adminFile, &adminData); err == nil {
		extractCitiesFromData(adminData, citySet)
	}

	cities := make([]string, 0, len(citySet))
	for city := range citySet {
		if city != "" {
			cities = append(cities, city)
		}
	}
	return cities
}

// extractCitiesFromData extracts city names from widget configs
func extractCitiesFromData(data map[string]interface{}, citySet map[string]bool) {
	widgets, ok := data["widgets"]
	if !ok {
		return
	}
	widgetList, ok := widgets.([]interface{})
	if !ok {
		return
	}
	for _, w := range widgetList {
		widget, ok := w.(map[string]interface{})
		if !ok {
			continue
		}
		wType, _ := widget["type"].(string)
		if wType == "weather" || wType == "clockweather" || wType == "clock" {
			if data, ok := widget["data"].(map[string]interface{}); ok {
				if city, ok := data["city"].(string); ok && city != "" {
					citySet[city] = true
				}
			}
		}
	}
}

// TriggerPollForNewCities compares old and new city lists, triggers poll for new ones
func (p *WeatherPoller) TriggerPollForNewCities(oldCities, newCities []string) {
	oldSet := make(map[string]bool)
	for _, c := range oldCities {
		oldSet[c] = true
	}
	for _, c := range newCities {
		if !oldSet[c] {
			log.Printf("[WeatherPoller] New city detected: %s, triggering immediate poll", c)
			p.TriggerSingleCity(c)
		}
	}
}

// GetCitiesFromData extracts city list from a data payload (for use in SaveData hook)
func GetCitiesFromPayload(data map[string]interface{}) []string {
	citySet := make(map[string]bool)
	extractCitiesFromData(data, citySet)
	cities := make([]string, 0, len(citySet))
	for city := range citySet {
		if city != "" {
			cities = append(cities, city)
		}
	}
	return cities
}

// --- Helper functions ---

func readJSONFile(path string, v interface{}) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}

func readDefaultData(v interface{}) error {
	return readJSONFile(config.DefaultFile, v)
}
