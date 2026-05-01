package handlers

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sync"

	"flatnasgo-backend/config"
)

// GeoCoord stores geocoding result for a city
type GeoCoord struct {
	Lat  float64 `json:"lat"`
	Lon  float64 `json:"lon"`
	Name string  `json:"name"` // Standard name from Open-Meteo
}

// GeocodingCache provides persistent storage for city -> lat/lon mappings
type GeocodingCache struct {
	mu       sync.RWMutex
	filePath string
	coords   map[string]*GeoCoord
}

var sharedGeoCache = &GeocodingCache{
	coords: make(map[string]*GeoCoord),
}

// InitGeocodingCache loads the cache from disk
func InitGeocodingCache() {
	sharedGeoCache.filePath = filepath.Join(config.DataDir, "geocoding_cache.json")
	sharedGeoCache.load()
}

func (c *GeocodingCache) load() {
	c.mu.Lock()
	defer c.mu.Unlock()

	if _, err := os.Stat(c.filePath); os.IsNotExist(err) {
		return
	}

	data, err := os.ReadFile(c.filePath)
	if err != nil {
		log.Printf("[GeocodingCache] Failed to read cache: %v", err)
		return
	}

	if err := json.Unmarshal(data, &c.coords); err != nil {
		log.Printf("[GeocodingCache] Failed to unmarshal cache: %v", err)
	}
	log.Printf("[GeocodingCache] Loaded %d entries", len(c.coords))
}

// Get returns a cached coordinate if found
func (c *GeocodingCache) Get(city string) (*GeoCoord, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	coord, ok := c.coords[city]
	return coord, ok
}

// Set stores a coordinate and triggers async save
func (c *GeocodingCache) Set(city string, coord *GeoCoord) {
	c.mu.Lock()
	c.coords[city] = coord
	c.mu.Unlock()
	go c.save()
}

func (c *GeocodingCache) save() {
	c.mu.RLock()
	data, err := json.Marshal(c.coords)
	c.mu.RUnlock()

	if err != nil {
		log.Printf("[GeocodingCache] Failed to marshal: %v", err)
		return
	}

	if err := os.WriteFile(c.filePath, data, 0644); err != nil {
		log.Printf("[GeocodingCache] Failed to write cache: %v", err)
	}
}
