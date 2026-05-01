package handlers

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/net/proxy"
)

func shouldDropProxyResponseHeader(header string) bool {
	switch strings.ToLower(strings.TrimSpace(header)) {
	case "content-security-policy",
		"content-security-policy-report-only",
		"x-frame-options",
		"x-content-security-policy",
		"x-webkit-csp",
		"frame-options",
		"cross-origin-embedder-policy",
		"cross-origin-opener-policy",
		"cross-origin-resource-policy",
		"permissions-policy",
		"clear-site-data",
		"report-to",
		"nel":
		return true
	default:
		return false
	}
}

func isAllowedWallpaperHost(host string) bool {
	host = strings.TrimSpace(strings.ToLower(host))
	if host == "" {
		return false
	}
	raw := strings.TrimSpace(os.Getenv("WALLPAPER_WHITELIST"))
	presets := []string{"bing.biturl.top", "picsum.photos", "www.loliapi.com", "loliapi.com"}
	list := make([]string, 0, len(presets))
	list = append(list, presets...)
	if raw != "" {
		for _, part := range strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == '\n' || r == ';' }) {
			v := strings.TrimSpace(strings.ToLower(part))
			if v != "" {
				list = append(list, v)
			}
		}
	}
	for _, p := range list {
		if p == "" {
			continue
		}
		if host == p {
			return true
		}
		if strings.HasSuffix(host, "."+p) {
			return true
		}
		if strings.HasPrefix(host, p) {
			return true
		}
	}
	return false
}

func ProxyWallpaper(c *gin.Context) {
	targetURL := c.Query("url")
	requestUUID := c.Query("uuid")

	if targetURL == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "URL is required"})
		return
	}

	parsed, err := url.Parse(targetURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid URL"})
		return
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Unsupported protocol"})
		return
	}
	h := parsed.Hostname()
	if IsBlockedHost(h) && !isAllowedWallpaperHost(h) {
		c.JSON(http.StatusForbidden, gin.H{"error": "Target host is not allowed"})
		return
	}

	req, err := http.NewRequest("GET", parsed.String(), nil)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create request"})
		return
	}

	// Forward necessary headers? Or just simple GET.
	// User-Agent might be needed for some APIs
	req.Header.Set("User-Agent", "FlatNas/1.0")

	// Reuse shared client or use a dedicated global one if needed.
	// For now, let's use the shared proxy client to support environments behind proxy.
	client, err := getSharedProxyClient()
	if err != nil {
		// Fallback to direct client if proxy setup fails, though unlikely
		client = &http.Client{Timeout: 10 * time.Second}
	}

	resp, err := client.Do(req)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "Failed to fetch upstream URL"})
		return
	}
	defer resp.Body.Close()

	// Copy headers
	c.Header("Content-Type", resp.Header.Get("Content-Type"))
	if cc := resp.Header.Get("Cache-Control"); cc != "" {
		c.Header("Cache-Control", cc)
	}
	if etag := resp.Header.Get("ETag"); etag != "" {
		c.Header("ETag", etag)
	}

	// Set UUID if provided
	if requestUUID != "" {
		c.Header("X-Request-UUID", requestUUID)
	}

	c.Status(resp.StatusCode)
	_, err = io.Copy(c.Writer, resp.Body)
	if err != nil {
		fmt.Printf("Error streaming response: %v\n", err)
	}
}

func GetProxyStatus(c *gin.Context) {
	proxyURL, err := getProxyURL()
	if err != nil || proxyURL == nil {
		c.JSON(http.StatusOK, gin.H{"available": false})
		return
	}
	c.JSON(http.StatusOK, gin.H{"available": true})
}

func ProxyRequest(c *gin.Context) {
	targetURL := c.Query("url")
	if targetURL == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "URL is required"})
		return
	}
	parsed, err := url.Parse(targetURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid URL"})
		return
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Unsupported protocol"})
		return
	}
	if IsBlockedHost(parsed.Hostname()) {
		c.JSON(http.StatusForbidden, gin.H{"error": "Target host is not allowed"})
		return
	}

	method := c.Request.Method
	if strings.EqualFold(method, "CONNECT") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Unsupported method"})
		return
	}

	req, err := http.NewRequestWithContext(c.Request.Context(), method, parsed.String(), c.Request.Body)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create request"})
		return
	}
	for k, v := range c.Request.Header {
		key := http.CanonicalHeaderKey(k)
		if key == "Host" || key == "Content-Length" {
			continue
		}
		for _, vv := range v {
			req.Header.Add(k, vv)
		}
	}
	if req.Header.Get("User-Agent") == "" {
		req.Header.Set("User-Agent", "FlatNas/1.0")
	}

	client, err := buildProxyClient()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Proxy unavailable"})
		return
	}
	resp, err := client.Do(req)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "Failed to fetch upstream URL"})
		return
	}
	defer resp.Body.Close()

	for k, v := range resp.Header {
		if shouldDropProxyResponseHeader(k) {
			continue
		}
		for _, vv := range v {
			c.Header(k, vv)
		}
	}
	c.Header("X-Frame-Options", "")
	c.Header("Content-Security-Policy", "")
	c.Header("Content-Security-Policy-Report-Only", "")
	c.Header("Cross-Origin-Opener-Policy", "unsafe-none")
	c.Header("Cross-Origin-Embedder-Policy", "unsafe-none")
	c.Header("Cross-Origin-Resource-Policy", "cross-origin")
	c.Status(resp.StatusCode)
	_, err = io.Copy(c.Writer, resp.Body)
	if err != nil {
		fmt.Printf("Error streaming response: %v\n", err)
	}
}

func getProxyURL() (*url.URL, error) {
	keys := []string{"PROXY_URL", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"}
	var lastErr error
	for _, key := range keys {
		value := strings.TrimSpace(os.Getenv(key))
		if value == "" {
			continue
		}
		parsed, err := parseProxyURL(value)
		if err != nil {
			lastErr = err
			continue
		}
		return parsed, nil
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, nil
}

func parseProxyURL(value string) (*url.URL, error) {
	normalized := strings.TrimSpace(value)
	if normalized == "" {
		return nil, fmt.Errorf("empty proxy url")
	}
	if !strings.Contains(normalized, "://") {
		normalized = "http://" + normalized
	}
	parsed, err := url.Parse(normalized)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("invalid proxy url")
	}
	switch parsed.Scheme {
	case "http", "https", "socks5", "socks5h":
		return parsed, nil
	default:
		return nil, fmt.Errorf("unsupported proxy protocol")
	}
}

var (
	globalProxyClient *http.Client
	globalProxyURLStr string
	proxyClientMu     sync.RWMutex
)

func getSharedProxyClient() (*http.Client, error) {
	proxyURL, err := getProxyURL()
	if err != nil {
		return nil, err
	}

	currentURLStr := ""
	if proxyURL != nil {
		currentURLStr = proxyURL.String()
	}

	proxyClientMu.RLock()
	client := globalProxyClient
	cachedURLStr := globalProxyURLStr
	proxyClientMu.RUnlock()

	if client != nil && cachedURLStr == currentURLStr {
		return client, nil
	}

	proxyClientMu.Lock()
	defer proxyClientMu.Unlock()

	// Double check
	if globalProxyClient != nil && globalProxyURLStr == currentURLStr {
		return globalProxyClient, nil
	}

	// Rebuild client
	transport := &http.Transport{
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 10,
		IdleConnTimeout:     90 * time.Second,
	}

	if proxyURL == nil {
		newClient := &http.Client{Timeout: 20 * time.Second, Transport: transport}
		globalProxyClient = newClient
		globalProxyURLStr = ""
		return newClient, nil
	}

	switch proxyURL.Scheme {
	case "http", "https":
		transport.Proxy = http.ProxyURL(proxyURL)
	case "socks5", "socks5h":
		dialer, err := proxy.FromURL(proxyURL, proxy.Direct)
		if err != nil {
			return nil, err
		}
		transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
			return dialer.Dial(network, addr)
		}
	default:
		return nil, fmt.Errorf("unsupported proxy protocol")
	}

	newClient := &http.Client{Timeout: 20 * time.Second, Transport: transport}
	globalProxyClient = newClient
	globalProxyURLStr = currentURLStr
	return newClient, nil
}

func buildProxyClient() (*http.Client, error) {
	return getSharedProxyClient()
}

func IsBlockedHost(host string) bool {
	if host == "" {
		return true
	}
	host = strings.TrimSpace(strings.ToLower(host))
	if host == "localhost" || host == "localhost." {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return isBlockedIP(ip)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil || len(ips) == 0 {
		return true
	}
	for _, item := range ips {
		if item.IP != nil && isBlockedIP(item.IP) {
			return true
		}
	}
	return false
}

func isBlockedIP(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast()
}
