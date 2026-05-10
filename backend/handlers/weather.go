package handlers

import (
	"crypto"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"sync"

	"github.com/gin-gonic/gin"
	socketio "github.com/googollee/go-socket.io"
)

// WeatherPayload defines the structure for socket events
type WeatherPayload struct {
	City       string `json:"city"`
	Source     string `json:"source"`
	Key        string `json:"key"`
	ProjectId  string `json:"projectId"`
	KeyId      string `json:"keyId"`
	PrivateKey string `json:"privateKey"`
}

type WeatherData struct {
	Temp     string       `json:"temp"`
	City     string       `json:"city"`
	Text     string       `json:"text"`
	Humidity string       `json:"humidity"`
	Today    WeatherRange `json:"today"`
	Forecast []WeatherDay `json:"forecast"`
}

type WeatherRange struct {
	Min string `json:"min"`
	Max string `json:"max"`
}

type WeatherDay struct {
	Date     string `json:"date"`
	MinTempC string `json:"mintempC"`
	MaxTempC string `json:"maxtempC"`
}

// UAPIResponse struct removed

// OpenMeteo Response Structures
type OpenMeteoGeocodingResponse struct {
	Results []struct {
		Latitude    float64 `json:"latitude"`
		Longitude   float64 `json:"longitude"`
		Name        string  `json:"name"`
		CountryCode string  `json:"country_code"`
		Country     string  `json:"country"`
	} `json:"results"`
}

type OpenMeteoWeatherResponse struct {
	Current struct {
		Temperature2m      float64 `json:"temperature_2m"`
		RelativeHumidity2m int     `json:"relative_humidity_2m"`
		WeatherCode        int     `json:"weather_code"`
	} `json:"current"`
	Daily struct {
		Time             []string  `json:"time"`
		WeatherCode      []int     `json:"weather_code"`
		Temperature2mMax []float64 `json:"temperature_2m_max"`
		Temperature2mMin []float64 `json:"temperature_2m_min"`
	} `json:"daily"`
}

type cachedAmapResponse struct {
	Body        []byte
	Timestamp   time.Time
	StatusCode  int
	ContentType string
}

var (
	amapRawCache = make(map[string]cachedAmapResponse)
	amapRawMutex sync.RWMutex
)

// AmapResponse maps the response from Amap
type AmapResponse struct {
	Status    string `json:"status"`
	Info      string `json:"info"`
	Forecasts []struct {
		City  string `json:"city"`
		Casts []struct {
			Date         string `json:"date"`
			DayWeather   string `json:"dayweather"`
			NightWeather string `json:"nightweather"`
			DayTemp      string `json:"daytemp"`
			NightTemp    string `json:"nighttemp"`
		} `json:"casts"`
	} `json:"forecasts"`
	Lives []struct {
		Province      string `json:"province"`
		City          string `json:"city"`
		Adcode        string `json:"adcode"`
		Weather       string `json:"weather"`
		Temperature   string `json:"temperature"`
		Winddirection string `json:"winddirection"`
		Windpower     string `json:"windpower"`
		Humidity      string `json:"humidity"`
		Reporttime    string `json:"reporttime"`
	} `json:"lives"`
}

func BindWeatherHandlers(server *socketio.Server) {
	server.OnEvent("/", "weather:fetch", func(s socketio.Conn, msg WeatherPayload) {
		payload := normalizeWeatherPayload(msg)
		if strings.TrimSpace(payload.City) == "" {
			s.Emit("weather:error", gin.H{"city": msg.City, "error": "city is required"})
			return
		}
		cacheKey := buildWeatherCacheKey(payload)
		var cached WeatherData
		hasCache, isFresh, _, err := sharedWidgetCache.Get(widgetCacheKindWeather, cacheKey, &cached)
		if err == nil && hasCache {
			s.Emit("weather:data", gin.H{"city": payload.City, "data": cached})
		}
		if hasCache && isFresh {
			return
		}
		if hasCache {
			go refreshWeatherAsync(server, payload)
			return
		}
		data, err := fetchWeatherFromSource(payload)
		if err != nil {
			_ = sharedWidgetCache.MarkStatus(widgetCacheKindWeather, cacheKey, "error")
			s.Emit("weather:error", gin.H{"city": payload.City, "error": err.Error()})
			return
		}
		if err := sharedWidgetCache.Set(widgetCacheKindWeather, cacheKey, data, weatherTTL(payload), "ok"); err != nil {
			s.Emit("weather:error", gin.H{"city": payload.City, "error": err.Error()})
			return
		}
		s.Emit("weather:data", gin.H{"city": payload.City, "data": data})
	})
}

func WarmWeatherCache(payloads []WeatherPayload) {
	for _, payload := range payloads {
		normalized := normalizeWeatherPayload(payload)
		if strings.TrimSpace(normalized.City) == "" {
			continue
		}
		data, err := fetchWeatherFromSource(normalized)
		if err != nil {
			_ = sharedWidgetCache.MarkStatus(widgetCacheKindWeather, buildWeatherCacheKey(normalized), "error")
			continue
		}
		_ = sharedWidgetCache.Set(widgetCacheKindWeather, buildWeatherCacheKey(normalized), data, weatherTTL(normalized), "ok")
	}
}

func GetWeather(c *gin.Context) {
	city := c.Query("city")
	source := c.Query("source")
	key := c.Query("key")
	projectId := c.Query("projectId")
	keyId := c.Query("keyId")
	privateKey := c.Query("privateKey")

	if city == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "City is required"})
		return
	}

	payload := WeatherPayload{
		City:       city,
		Source:     source,
		Key:        key,
		ProjectId:  projectId,
		KeyId:      keyId,
		PrivateKey: privateKey,
	}
	payload = normalizeWeatherPayload(payload)
	cacheKey := buildWeatherCacheKey(payload)
	var cached WeatherData
	hasCache, _, item, err := sharedWidgetCache.Get(widgetCacheKindWeather, cacheKey, &cached)
	if err == nil && hasCache {
		// For frontend: return whatever is cached, regardless of TTL
		// Only block if it's an error entry within 1min cooldown
		if item != nil && item.SourceStatus == "error" {
			now := time.Now().UnixMilli()
			if (now - item.UpdatedAt) < (item.TTL * 1000) {
				c.JSON(http.StatusServiceUnavailable, gin.H{"success": false, "error": "weather fetch failed, retrying..."})
				return
			}
			// Error entry expired, fall through to on-demand fetch
		} else {
			c.JSON(http.StatusOK, gin.H{"success": true, "data": cached})
			// If cache is stale, trigger background refresh (only if source is not poller-managed)
			if item != nil && item.TTL > 0 && (time.Now().UnixMilli()-item.UpdatedAt) > (item.TTL*1000) {
				go refreshWeatherHTTP(payload)
			}
			return
		}
	}

	// Cache miss or expired error: on-demand fetch (fallback for new cities not yet polled)
	data, fetchErr := fetchWeatherFromSource(payload)
	if fetchErr != nil {
		_ = sharedWidgetCache.Set(widgetCacheKindWeather, cacheKey, &WeatherData{
			City: city,
			Text: "获取失败",
			Temp: "--",
		}, 60*time.Second, "error")
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": fetchErr.Error()})
		return
	}
	// Normal cache: permanent TTL (0 means no expiry for poller-managed cities)
	_ = sharedWidgetCache.Set(widgetCacheKindWeather, cacheKey, data, 0, "ok")
	c.JSON(http.StatusOK, gin.H{"success": true, "data": data})
}

func GetAmapWeather(c *gin.Context) {
	city := c.Query("city")
	key := c.Query("key")
	extensions := c.Query("extensions")
	if extensions == "" {
		extensions = "base"
	}
	if city == "" || key == "" {
		c.JSON(http.StatusBadRequest, gin.H{"status": "0", "info": "City and Key are required"})
		return
	}

	cacheKey := city + "|" + key + "|" + extensions
	amapRawMutex.RLock()
	if item, ok := amapRawCache[cacheKey]; ok {
		if time.Since(item.Timestamp) < 2*time.Hour {
			if item.ContentType != "" {
				c.Header("Content-Type", item.ContentType)
			}
			c.Status(item.StatusCode)
			_, _ = c.Writer.Write(item.Body)
			amapRawMutex.RUnlock()
			return
		}
	}
	amapRawMutex.RUnlock()

	targetURL := fmt.Sprintf(
		"https://restapi.amap.com/v3/weather/weatherInfo?city=%s&key=%s&extensions=%s",
		url.QueryEscape(city),
		url.QueryEscape(key),
		url.QueryEscape(extensions),
	)

	client, err := getSharedProxyClient()
	if err != nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	resp, err := client.Get(targetURL)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"status": "0", "info": "Failed to connect to Amap API"})
		return
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"status": "0", "info": "Failed to read Amap API response"})
		return
	}

	if resp.StatusCode == http.StatusOK {
		amapRawMutex.Lock()
		amapRawCache[cacheKey] = cachedAmapResponse{
			Body:        body,
			Timestamp:   time.Now(),
			StatusCode:  resp.StatusCode,
			ContentType: resp.Header.Get("Content-Type"),
		}
		amapRawMutex.Unlock()
	}

	if contentType := resp.Header.Get("Content-Type"); contentType != "" {
		c.Header("Content-Type", contentType)
	}
	c.Status(resp.StatusCode)
	_, _ = c.Writer.Write(body)
}

// ProxyAmapIP proxies requests to Amap IP API
func ProxyAmapIP(c *gin.Context) {
	targetURL := "https://restapi.amap.com/v3/ip"
	proxyRequest(c, targetURL)
}

func proxyRequest(c *gin.Context, targetURL string) {
	// Preserve query parameters
	queryParams := c.Request.URL.Query()
	u, _ := url.Parse(targetURL)
	u.RawQuery = queryParams.Encode()

	// Create request
	req, err := http.NewRequest(c.Request.Method, u.String(), c.Request.Body)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"status": "0", "info": "Failed to create request"})
		return
	}

	// Copy headers
	for k, v := range c.Request.Header {
		req.Header[k] = v
	}

	// Execute request
	client, err := getSharedProxyClient()
	if err != nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"status": "0", "info": "Failed to connect to Amap API"})
		return
	}
	defer resp.Body.Close()

	// Copy response headers
	for k, v := range resp.Header {
		c.Header(k, v[0])
	}
	c.Status(resp.StatusCode)

	// Copy response body
	io.Copy(c.Writer, resp.Body)
}

func normalizeWeatherPayload(p WeatherPayload) WeatherPayload {
	p.City = strings.TrimSpace(p.City)
	p.Source = strings.TrimSpace(strings.ToLower(p.Source))
	p.Key = strings.TrimSpace(p.Key)
	p.ProjectId = strings.TrimSpace(p.ProjectId)
	p.KeyId = strings.TrimSpace(p.KeyId)
	p.PrivateKey = strings.TrimSpace(p.PrivateKey)
	return p
}

func buildGeocodingCandidates(city string) []string {
	raw := strings.TrimSpace(city)
	if raw == "" {
		return nil
	}
	candidates := []string{raw}
	suffixes := []string{
		"特别行政区", "自治州", "自治县", "自治区", "地区",
		"省", "市", "区", "县", "盟",
	}
	for _, suffix := range suffixes {
		trimmed := strings.TrimSpace(strings.TrimSuffix(raw, suffix))
		if trimmed != "" && trimmed != raw {
			candidates = append(candidates, trimmed)
		}
	}
	seen := make(map[string]struct{}, len(candidates))
	unique := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		if _, ok := seen[candidate]; ok {
			continue
		}
		seen[candidate] = struct{}{}
		unique = append(unique, candidate)
	}
	return unique
}

func buildWeatherCacheKey(p WeatherPayload) string {
	p = normalizeWeatherPayload(p)
	return strings.Join([]string{p.City, p.Source, p.Key, p.ProjectId, p.KeyId, p.PrivateKey}, "|")
}

func weatherTTL(p WeatherPayload) time.Duration {
	if strings.EqualFold(strings.TrimSpace(p.Source), "amap") && strings.TrimSpace(p.Key) != "" {
		return 15 * time.Minute
	}
	return 10 * time.Minute
}

func generateQWeatherJWT(projectID, keyID, privateKeyPEM string) (string, error) {
	privBlock := strings.ReplaceAll(privateKeyPEM, "-----BEGIN PRIVATE KEY-----", "")
	privBlock = strings.ReplaceAll(privBlock, "-----END PRIVATE KEY-----", "")
	privBlock = strings.TrimSpace(privBlock)
	privateKeyBytes, err := base64.StdEncoding.DecodeString(privBlock)
	if err != nil {
		return "", fmt.Errorf("decode private key: %v", err)
	}

	privateKey, err := x509.ParsePKCS8PrivateKey(privateKeyBytes)
	if err != nil {
		return "", fmt.Errorf("parse private key: %v", err)
	}

	ed25519Key, ok := privateKey.(ed25519.PrivateKey)
	if !ok {
		return "", fmt.Errorf("private key is not Ed25519")
	}

	headerJSON := fmt.Sprintf(`{"alg":"EdDSA","kid":"%s"}`, keyID)
	iat := time.Now().Unix() - 30
	exp := iat + 900
	payloadJSON := fmt.Sprintf(`{"sub":"%s","iat":%d,"exp":%d}`, projectID, iat, exp)

	headerB64 := base64.RawURLEncoding.EncodeToString([]byte(headerJSON))
	payloadB64 := base64.RawURLEncoding.EncodeToString([]byte(payloadJSON))

	signedData := headerB64 + "." + payloadB64

	signature, err := ed25519Key.Sign(nil, []byte(signedData), crypto.Hash(0))
	if err != nil {
		return "", fmt.Errorf("sign JWT: %v", err)
	}

	signatureB64 := base64.RawURLEncoding.EncodeToString(signature)

	return headerB64 + "." + payloadB64 + "." + signatureB64, nil
}

type QWeatherGeoResponse struct {
	Code     string `json:"code"`
	Location []struct {
		Name string `json:"name"`
		Id   string `json:"id"`
		Lat  string `json:"lat"`
		Lon  string `json:"lon"`
	} `json:"location"`
}

type QWeatherNowResponse struct {
	Code     string `json:"code"`
	Now      struct {
		Temp string `json:"temp"`
		Text string `json:"text"`
		Humidity string `json:"humidity"`
	} `json:"now"`
}

type QWeatherDailyResponse struct {
	Code  string `json:"code"`
	Daily []struct {
		FxDate string `json:"fxDate"`
		TempMin string `json:"tempMin"`
		TempMax string `json:"tempMax"`
		TextDay string `json:"textDay"`
	} `json:"daily"`
}

func qweatherGeoCode(city, privateKey, projectID, keyID string) (locationID, cityName string, err error) {
	token, err := generateQWeatherJWT(projectID, keyID, privateKey)
	if err != nil {
		return "", "", err
	}

	geoURL := fmt.Sprintf("https://geoapi.qweather.com/v2/city/lookup?location=%s", url.QueryEscape(city))
	req, err := http.NewRequest("GET", geoURL, nil)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)

	client, err := getSharedProxyClient()
	if err != nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", "", fmt.Errorf("geo API request failed: %v", err)
	}
	defer resp.Body.Close()

	var geoResp QWeatherGeoResponse
	if err := json.NewDecoder(resp.Body).Decode(&geoResp); err != nil {
		return "", "", fmt.Errorf("geo API decode failed: %v", err)
	}

	if geoResp.Code != "200" || len(geoResp.Location) == 0 {
		return "", "", fmt.Errorf("city not found in QWeather: %s", city)
	}

	loc := geoResp.Location[0]
	return loc.Id, loc.Name, nil
}

func fetchQWeather(city, privateKey, projectID, keyID string) (*WeatherData, error) {
	locationID, cityName, err := qweatherGeoCode(city, privateKey, projectID, keyID)
	if err != nil {
		return nil, err
	}

	token, err := generateQWeatherJWT(projectID, keyID, privateKey)
	if err != nil {
		return nil, err
	}

	client, err := getSharedProxyClient()
	if err != nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}

	nowURL := fmt.Sprintf("https://devapi.qweather.com/v7/weather/now?location=%s", locationID)
	nowReq, _ := http.NewRequest("GET", nowURL, nil)
	nowReq.Header.Set("Authorization", "Bearer "+token)
	nowResp, err := client.Do(nowReq)
	if err != nil {
		return nil, fmt.Errorf("now weather request failed: %v", err)
	}
	defer nowResp.Body.Close()

	var nowResp2 QWeatherNowResponse
	if err := json.NewDecoder(nowResp.Body).Decode(&nowResp2); err != nil {
		return nil, fmt.Errorf("now weather decode failed: %v", err)
	}

	if nowResp2.Code != "200" {
		return nil, fmt.Errorf("QWeather now API error: %s", nowResp2.Code)
	}

	data := &WeatherData{
		Temp:     nowResp2.Now.Temp,
		City:     cityName,
		Text:     nowResp2.Now.Text,
		Humidity: nowResp2.Now.Humidity + "%",
		Today:    WeatherRange{},
		Forecast: make([]WeatherDay, 0),
	}

	dailyURL := fmt.Sprintf("https://devapi.qweather.com/v7/weather/3d?location=%s", locationID)
	dailyReq, _ := http.NewRequest("GET", dailyURL, nil)
	dailyReq.Header.Set("Authorization", "Bearer "+token)
	dailyResp, err := client.Do(dailyReq)
	if err != nil {
		return data, nil
	}
	defer dailyResp.Body.Close()

	var dailyResp2 QWeatherDailyResponse
	if err := json.NewDecoder(dailyResp.Body).Decode(&dailyResp2); err != nil {
		return data, nil
	}

	if dailyResp2.Code == "200" && len(dailyResp2.Daily) > 0 {
		today := dailyResp2.Daily[0]
		data.Today = WeatherRange{
			Min: today.TempMin,
			Max: today.TempMax,
		}
		for _, d := range dailyResp2.Daily {
			data.Forecast = append(data.Forecast, WeatherDay{
				Date:     d.FxDate,
				MinTempC: d.TempMin,
				MaxTempC: d.TempMax,
			})
		}
	}

	return data, nil
}

func fetchWeatherFromSource(p WeatherPayload) (*WeatherData, error) {
	p = normalizeWeatherPayload(p)
	if p.Source == "amap" && p.Key != "" && p.Key != "wttr.in" {
		return fetchAmap(p.City, p.Key)
	}
	if p.Source == "qweather" && p.PrivateKey != "" && p.ProjectId != "" && p.KeyId != "" {
		return fetchQWeather(p.City, p.PrivateKey, p.ProjectId, p.KeyId)
	}
	return fetchOpenMeteo(p.City)
}

func refreshWeatherHTTP(p WeatherPayload) {
	tag := "weather:" + buildWeatherCacheKey(p)
	if !sharedWidgetCache.StartRefresh(tag) {
		return
	}
	defer sharedWidgetCache.EndRefresh(tag)
	data, err := fetchWeatherFromSource(p)
	if err != nil {
		_ = sharedWidgetCache.MarkStatus(widgetCacheKindWeather, buildWeatherCacheKey(p), "error")
		return
	}
	_ = sharedWidgetCache.Set(widgetCacheKindWeather, buildWeatherCacheKey(p), data, weatherTTL(p), "ok")
}

func refreshWeatherAsync(server *socketio.Server, p WeatherPayload) {
	tag := "weather:" + buildWeatherCacheKey(p)
	if !sharedWidgetCache.StartRefresh(tag) {
		return
	}
	defer sharedWidgetCache.EndRefresh(tag)
	data, err := fetchWeatherFromSource(p)
	if err != nil {
		_ = sharedWidgetCache.MarkStatus(widgetCacheKindWeather, buildWeatherCacheKey(p), "error")
		return
	}
	_ = sharedWidgetCache.Set(widgetCacheKindWeather, buildWeatherCacheKey(p), data, weatherTTL(p), "ok")
	server.BroadcastToNamespace("/", "weather:data", gin.H{"city": p.City, "data": data})
}

// fetchOpenMeteoWithGeoCache uses the persistent geocoding cache
func fetchOpenMeteoWithGeoCache(city string, geoCache *GeocodingCache) (*WeatherData, error) {
	// 1. Check geocoding cache first
	if coord, ok := geoCache.Get(city); ok {
		return fetchOpenMeteoWeatherData(coord.Lat, coord.Lon, coord.Name, city)
	}

	// 2. Cache miss: try geocoding API (zh first, then en fallback)
	coord, err := geocodeCity(city)
	if err != nil {
		return nil, err
	}

	// 3. Cache the result permanently
	geoCache.Set(city, coord)

	// 4. Fetch weather data
	return fetchOpenMeteoWeatherData(coord.Lat, coord.Lon, coord.Name, city)
}

// geocodeCity tries to get coordinates for a city name via Open-Meteo geocoding API
func geocodeCity(city string) (*GeoCoord, error) {
	client, err := getSharedProxyClient()
	if err != nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	candidates := buildGeocodingCandidates(city)
	if len(candidates) == 0 {
		return nil, fmt.Errorf("city is empty")
	}

	var lastErr error
	for _, candidate := range candidates {
		coord, err := geocodeWithLang(candidate, "zh", client)
		if err == nil {
			return coord, nil
		}
		log.Printf("[Weather] Geocoding zh failed for %s (candidate=%s), trying en: %v", city, candidate, err)

		coord, err = geocodeWithLang(candidate, "en", client)
		if err == nil {
			return coord, nil
		}
		lastErr = err
	}

	return nil, fmt.Errorf("geocoding failed for %s: %v", city, lastErr)
}

func geocodeWithLang(city, lang string, client *http.Client) (*GeoCoord, error) {
	geoURL := fmt.Sprintf("https://geocoding-api.open-meteo.com/v1/search?name=%s&count=10&language=%s&format=json", url.QueryEscape(city), lang)
	fmt.Printf("[Weather] Geocoding (%s): %s\n", lang, geoURL)

	respGeo, err := client.Get(geoURL)
	if err != nil {
		return nil, fmt.Errorf("geocoding request failed: %v", err)
	}
	defer respGeo.Body.Close()

	var geoResp OpenMeteoGeocodingResponse
	if err := json.NewDecoder(respGeo.Body).Decode(&geoResp); err != nil {
		return nil, fmt.Errorf("geocoding decode failed: %v", err)
	}

	if len(geoResp.Results) == 0 {
		return nil, fmt.Errorf("city not found: %s", city)
	}

	// Find best match with confidence check
	bestMatch := geoResp.Results[0]
	bestScore := -99999
	targetName := strings.ToLower(city)

	for _, res := range geoResp.Results {
		score := 0
		if res.CountryCode == "CN" {
			score += 1000
		}

		dist := levenshtein(strings.ToLower(res.Name), targetName)
		score -= dist * 10

		if strings.EqualFold(res.Name, city) {
			score += 500
		}

		if score > bestScore {
			bestScore = score
			bestMatch = res
		}
	}

	// Confidence check: reject country-level matches
	if strings.EqualFold(bestMatch.Name, bestMatch.Country) ||
		strings.EqualFold(bestMatch.Name, "China") ||
		strings.EqualFold(bestMatch.Name, "中国") {
		return nil, fmt.Errorf("geocoding resolved to country-level for '%s'", city)
	}

	// Levenshtein distance check: if too different, likely wrong city
	dist := levenshtein(strings.ToLower(bestMatch.Name), targetName)
	if dist > 5 {
		return nil, fmt.Errorf("geocoding confidence too low for '%s' -> '%s' (dist=%d)", city, bestMatch.Name, dist)
	}

	return &GeoCoord{
		Lat:  bestMatch.Latitude,
		Lon:  bestMatch.Longitude,
		Name: bestMatch.Name,
	}, nil
}

// fetchOpenMeteoWeatherData fetches weather data given coordinates
func fetchOpenMeteoWeatherData(lat, lon float64, apiName, displayName string) (*WeatherData, error) {
	client, err := getSharedProxyClient()
	if err != nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}

	weatherURL := fmt.Sprintf("https://api.open-meteo.com/v1/forecast?latitude=%f&longitude=%f&current=temperature_2m,relative_humidity_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto", lat, lon)
	fmt.Printf("[Weather] Fetching OpenMeteo: %s\n", weatherURL)

	respWeather, err := client.Get(weatherURL)
	if err != nil {
		return nil, fmt.Errorf("weather fetch failed: %v", err)
	}
	defer respWeather.Body.Close()

	var wResp OpenMeteoWeatherResponse
	if err := json.NewDecoder(respWeather.Body).Decode(&wResp); err != nil {
		return nil, fmt.Errorf("weather decode failed: %v", err)
	}

	data := &WeatherData{
		Temp:     fmt.Sprintf("%.1f", wResp.Current.Temperature2m),
		City:     displayName,
		Text:     getWeatherText(wResp.Current.WeatherCode),
		Humidity: fmt.Sprintf("%d%%", wResp.Current.RelativeHumidity2m),
		Forecast: make([]WeatherDay, 0),
	}

	if len(wResp.Daily.Time) > 0 {
		data.Today = WeatherRange{
			Min: fmt.Sprintf("%.1f", wResp.Daily.Temperature2mMin[0]),
			Max: fmt.Sprintf("%.1f", wResp.Daily.Temperature2mMax[0]),
		}

		for i, date := range wResp.Daily.Time {
			data.Forecast = append(data.Forecast, WeatherDay{
				Date:     date,
				MinTempC: fmt.Sprintf("%.1f", wResp.Daily.Temperature2mMin[i]),
				MaxTempC: fmt.Sprintf("%.1f", wResp.Daily.Temperature2mMax[i]),
			})
		}
	} else {
		data.Today = WeatherRange{
			Min: data.Temp,
			Max: data.Temp,
		}
	}

	return data, nil
}

// fetchOpenMeteo is kept for backward compatibility (uses geocoding cache internally)
func fetchOpenMeteo(city string) (*WeatherData, error) {
	return fetchOpenMeteoWithGeoCache(city, sharedGeoCache)
}

func levenshtein(s1, s2 string) int {
	r1, r2 := []rune(s1), []rune(s2)
	n, m := len(r1), len(r2)
	if n == 0 {
		return m
	}
	if m == 0 {
		return n
	}
	matrix := make([][]int, n+1)
	for i := range matrix {
		matrix[i] = make([]int, m+1)
	}
	for i := 0; i <= n; i++ {
		matrix[i][0] = i
	}
	for j := 0; j <= m; j++ {
		matrix[0][j] = j
	}
	for i := 1; i <= n; i++ {
		for j := 1; j <= m; j++ {
			cost := 0
			if r1[i-1] != r2[j-1] {
				cost = 1
			}
			min1 := matrix[i-1][j] + 1
			min2 := matrix[i][j-1] + 1
			min3 := matrix[i-1][j-1] + cost
			if min1 < min2 {
				if min1 < min3 {
					matrix[i][j] = min1
				} else {
					matrix[i][j] = min3
				}
			} else {
				if min2 < min3 {
					matrix[i][j] = min2
				} else {
					matrix[i][j] = min3
				}
			}
		}
	}
	return matrix[n][m]
}

func getWeatherText(code int) string {
	switch code {
	case 0:
		return "晴"
	case 1, 2, 3:
		return "多云"
	case 45, 48:
		return "雾"
	case 51, 53, 55:
		return "毛毛雨"
	case 56, 57:
		return "冻雨"
	case 61, 63, 65:
		return "雨"
	case 66, 67:
		return "冻雨"
	case 71, 73, 75:
		return "雪"
	case 77:
		return "雪粒"
	case 80, 81, 82:
		return "阵雨"
	case 85, 86:
		return "阵雪"
	case 95:
		return "雷雨"
	case 96, 99:
		return "雷暴伴有冰雹"
	default:
		return "未知"
	}
}

func fetchAmap(city, key string) (*WeatherData, error) {
	// Amap requires adcode for best results, but city name works too.
	// We need two calls: base (live) and all (forecast)

	// 1. Get Live Weather
	liveURL := fmt.Sprintf("https://restapi.amap.com/v3/weather/weatherInfo?city=%s&key=%s&extensions=base", url.QueryEscape(city), key)
	client, err := getSharedProxyClient()
	if err != nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}

	respLive, err := client.Get(liveURL)
	if err != nil {
		return nil, err
	}
	defer respLive.Body.Close()

	bodyLive, _ := io.ReadAll(respLive.Body)
	var amapLive AmapResponse
	json.Unmarshal(bodyLive, &amapLive)

	// 2. Get Forecast
	forecastURL := fmt.Sprintf("https://restapi.amap.com/v3/weather/weatherInfo?city=%s&key=%s&extensions=all", url.QueryEscape(city), key)
	respForecast, err := client.Get(forecastURL)
	if err != nil {
		return nil, err
	}
	defer respForecast.Body.Close()

	bodyForecast, _ := io.ReadAll(respForecast.Body)
	var amapForecast AmapResponse
	json.Unmarshal(bodyForecast, &amapForecast)

	// Combine data
	data := &WeatherData{
		City:     city,
		Forecast: make([]WeatherDay, 0),
	}

	if len(amapLive.Lives) > 0 {
		live := amapLive.Lives[0]
		data.Temp = live.Temperature
		data.Text = live.Weather
		data.Humidity = live.Humidity + "%"
		data.City = live.City
	}

	if len(amapForecast.Forecasts) > 0 && len(amapForecast.Forecasts[0].Casts) > 0 {
		casts := amapForecast.Forecasts[0].Casts
		today := casts[0]
		data.Today = WeatherRange{
			Min: today.NightTemp,
			Max: today.DayTemp,
		}

		for _, cast := range casts {
			data.Forecast = append(data.Forecast, WeatherDay{
				Date:     cast.Date,
				MinTempC: cast.NightTemp,
				MaxTempC: cast.DayTemp,
			})
		}
	} else {
		// If live data exists but forecast fails, we can still return partial data
		if data.Temp == "" {
			return nil, fmt.Errorf("failed to get amap weather")
		}
	}

	return data, nil
}
