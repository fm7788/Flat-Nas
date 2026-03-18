package handlers

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	socketio "github.com/googollee/go-socket.io"
	"golang.org/x/net/html/charset"
)

// RssPayload defines the input structure
type RssPayload struct {
	Url string `json:"url"`
}

// Unified Item structure for frontend
type UnifiedRssItem struct {
	Title          string `json:"title"`
	Link           string `json:"link"`
	PubDate        string `json:"pubDate"`
	ContentSnippet string `json:"contentSnippet"`
}

var rssCacheTTL = 15 * time.Minute

// RSS 2.0 Structures
type Rss2Feed struct {
	Channel Rss2Channel `xml:"channel"`
}

type Rss2Channel struct {
	Items []Rss2Item `xml:"item"`
}

type Rss2Item struct {
	Title       string `xml:"title"`
	Link        string `xml:"link"`
	Description string `xml:"description"`
	Guid        string `xml:"guid"`
	Content     string `xml:"http://purl.org/rss/1.0/modules/content/ encoded"`
	PubDate     string `xml:"pubDate"`
}

// Atom Structures
type AtomFeed struct {
	Entries []AtomEntry `xml:"entry"`
}

type AtomEntry struct {
	Title   string     `xml:"title"`
	Links   []AtomLink `xml:"link"`
	Content string     `xml:"content"`
	Summary string     `xml:"summary"`
	Updated string     `xml:"updated"`
}

type AtomLink struct {
	Href string `xml:"href,attr"`
	Rel  string `xml:"rel,attr"`
	Type string `xml:"type,attr"`
}

type RdfFeed struct {
	Items []RdfItem `xml:"item"`
}

type RdfItem struct {
	Title       string `xml:"title"`
	Link        string `xml:"link"`
	Description string `xml:"description"`
	Date        string `xml:"http://purl.org/dc/elements/1.1/ date"`
}

func BindRssHandlers(server *socketio.Server) {
	server.OnEvent("/", "rss:fetch", func(s socketio.Conn, msg interface{}) {
		log.Println("Received rss:fetch event")
		var urlStr string
		if m, ok := msg.(map[string]interface{}); ok {
			if u, ok := m["url"].(string); ok {
				urlStr = u
			}
		}

		urlStr = strings.TrimSpace(urlStr)
		if urlStr == "" {
			s.Emit("rss:error", map[string]interface{}{"error": "url is required"})
			return
		}

		var cachedItems []UnifiedRssItem
		hasCache, isFresh, _, err := sharedWidgetCache.Get(widgetCacheKindRSS, urlStr, &cachedItems)
		if err == nil && hasCache && len(cachedItems) > 0 {
			s.Emit("rss:data", map[string]interface{}{
				"url": urlStr,
				"data": map[string]interface{}{
					"items": cachedItems,
				},
			})
		}
		if hasCache && isFresh {
			return
		}
		if hasCache {
			go refreshRssAsync(server, urlStr)
			return
		}

		items, err := fetchRssFeed(urlStr)
		if err != nil {
			log.Printf("RSS fetch failed: url=%s error=%v", urlStr, err)
			_ = sharedWidgetCache.MarkStatus(widgetCacheKindRSS, urlStr, "error")
			s.Emit("rss:error", map[string]interface{}{"url": urlStr, "error": err.Error()})
			return
		}
		if err := sharedWidgetCache.Set(widgetCacheKindRSS, urlStr, items, rssCacheTTL, "ok"); err != nil {
			s.Emit("rss:error", map[string]interface{}{"url": urlStr, "error": err.Error()})
			return
		}

		s.Emit("rss:data", map[string]interface{}{
			"url": urlStr,
			"data": map[string]interface{}{
				"items": items,
			},
		})
	})
}

func WarmRssCache(urls []string) {
	seen := make(map[string]struct{})
	for _, urlStr := range urls {
		urlStr = strings.TrimSpace(urlStr)
		if urlStr == "" {
			continue
		}
		if _, exists := seen[urlStr]; exists {
			continue
		}
		seen[urlStr] = struct{}{}
		items, err := fetchRssFeed(urlStr)
		if err != nil {
			_ = sharedWidgetCache.MarkStatus(widgetCacheKindRSS, urlStr, "error")
			log.Printf("RSS warmup failed: url=%s error=%v", urlStr, err)
			continue
		}
		if len(items) == 0 {
			continue
		}
		_ = sharedWidgetCache.Set(widgetCacheKindRSS, urlStr, items, rssCacheTTL, "ok")
	}
}

func refreshRssAsync(server *socketio.Server, urlStr string) {
	tag := "rss:" + urlStr
	if !sharedWidgetCache.StartRefresh(tag) {
		return
	}
	defer sharedWidgetCache.EndRefresh(tag)
	items, err := fetchRssFeed(urlStr)
	if err != nil {
		_ = sharedWidgetCache.MarkStatus(widgetCacheKindRSS, urlStr, "error")
		return
	}
	if len(items) == 0 {
		return
	}
	_ = sharedWidgetCache.Set(widgetCacheKindRSS, urlStr, items, rssCacheTTL, "ok")
	server.BroadcastToNamespace("/", "rss:data", map[string]interface{}{
		"url": urlStr,
		"data": map[string]interface{}{
			"items": items,
		},
	})
}

func refreshRssHTTP(urlStr string) {
	tag := "rss:" + urlStr
	if !sharedWidgetCache.StartRefresh(tag) {
		return
	}
	defer sharedWidgetCache.EndRefresh(tag)
	items, err := fetchRssFeed(urlStr)
	if err != nil {
		_ = sharedWidgetCache.MarkStatus(widgetCacheKindRSS, urlStr, "error")
		return
	}
	if len(items) == 0 {
		return
	}
	_ = sharedWidgetCache.Set(widgetCacheKindRSS, urlStr, items, rssCacheTTL, "ok")
}

func GetRss(c *gin.Context) {
	urlStr := strings.TrimSpace(c.Query("url"))
	force := strings.EqualFold(c.Query("force"), "true") || c.Query("force") == "1"
	if urlStr == "" {
		c.JSON(http.StatusBadRequest, map[string]interface{}{"success": false, "error": "url is required"})
		return
	}

	var cachedItems []UnifiedRssItem
	hasCache, isFresh, _, err := sharedWidgetCache.Get(widgetCacheKindRSS, urlStr, &cachedItems)
	if err == nil && hasCache && len(cachedItems) > 0 && !force {
		c.JSON(http.StatusOK, map[string]interface{}{
			"success": true,
			"data": map[string]interface{}{
				"items": cachedItems,
			},
			"cached": true,
		})
		if !isFresh {
			go refreshRssHTTP(urlStr)
		}
		return
	}

	items, fetchErr := fetchRssFeed(urlStr)
	if fetchErr != nil {
		if err == nil && hasCache && len(cachedItems) > 0 {
			c.JSON(http.StatusOK, map[string]interface{}{
				"success": true,
				"data": map[string]interface{}{
					"items": cachedItems,
				},
				"cached": true,
				"stale":  true,
			})
			return
		}
		c.JSON(http.StatusInternalServerError, map[string]interface{}{"success": false, "error": fetchErr.Error()})
		return
	}
	if err := sharedWidgetCache.Set(widgetCacheKindRSS, urlStr, items, rssCacheTTL, "ok"); err != nil {
		c.JSON(http.StatusInternalServerError, map[string]interface{}{"success": false, "error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, map[string]interface{}{
		"success": true,
		"data": map[string]interface{}{
			"items": items,
		},
	})
}

func fetchRssFeed(feedUrl string) ([]UnifiedRssItem, error) {
	feedUrl = strings.TrimSpace(feedUrl)
	if feedUrl == "" {
		return nil, fmt.Errorf("url is required")
	}
	candidates := []string{feedUrl}
	if !strings.Contains(feedUrl, "://") {
		candidates = []string{"https://" + feedUrl, "http://" + feedUrl}
	}
	var lastErr error
	for _, candidate := range candidates {
		items, err := fetchRssFeedOnce(candidate)
		if err == nil && len(items) > 0 {
			return items, nil
		}
		if err != nil {
			lastErr = err
		}
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, fmt.Errorf("failed to parse feed")
}

func fetchRssFeedOnce(feedUrl string) ([]UnifiedRssItem, error) {
	attempts := buildRssAttempts(feedUrl)
	var lastErr error
	for _, attempt := range attempts {
		body, err := fetchRssBody(attempt.client, feedUrl, attempt.headers)
		if err != nil {
			lastErr = err
			continue
		}
		items, err := parseRssItems(body)
		if err == nil && len(items) > 0 {
			return items, nil
		}
		if err != nil {
			lastErr = err
		}
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, fmt.Errorf("failed to parse feed")
}

type rssAttempt struct {
	client  *http.Client
	headers map[string]string
}

func buildRssAttempts(feedUrl string) []rssAttempt {
	referer := buildRssReferer(feedUrl)
	headersA := buildRssHeaders(referer, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	headersB := buildRssHeaders(referer, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15")
	attempts := []rssAttempt{
		{client: &http.Client{Timeout: 10 * time.Second}, headers: headersA},
		{client: &http.Client{Timeout: 10 * time.Second}, headers: headersB},
	}
	proxyURL, err := getProxyURL()
	if err == nil && proxyURL != nil {
		if proxyClient, err := buildProxyClient(); err == nil {
			attempts = append(attempts, rssAttempt{client: proxyClient, headers: headersB})
		}
	}
	return attempts
}

func buildRssHeaders(referer, userAgent string) map[string]string {
	headers := map[string]string{
		"User-Agent":      userAgent,
		"Accept":          "application/rss+xml, application/xml, text/xml, */*",
		"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
		"Cache-Control":   "no-cache",
	}
	if referer != "" {
		headers["Referer"] = referer
	}
	return headers
}

func buildRssReferer(feedUrl string) string {
	parsed, err := url.Parse(feedUrl)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	return parsed.Scheme + "://" + parsed.Host + "/"
}

func fetchRssBody(client *http.Client, feedUrl string, headers map[string]string) ([]byte, error) {
	req, err := http.NewRequest("GET", feedUrl, nil)
	if err != nil {
		return nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP status %d", resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

func parseRssItems(body []byte) ([]UnifiedRssItem, error) {
	var rss2 Rss2Feed
	decoder := xml.NewDecoder(bytes.NewReader(body))
	decoder.CharsetReader = charset.NewReaderLabel
	if err := decoder.Decode(&rss2); err == nil && len(rss2.Channel.Items) > 0 {
		items := make([]UnifiedRssItem, 0, len(rss2.Channel.Items))
		for _, item := range rss2.Channel.Items {
			desc := cleanDescription(item.Description)
			if desc == "" {
				desc = cleanDescription(item.Content)
			}
			link := strings.TrimSpace(item.Link)
			if link == "" {
				link = strings.TrimSpace(item.Guid)
			}
			items = append(items, UnifiedRssItem{
				Title:          item.Title,
				Link:           link,
				PubDate:        item.PubDate,
				ContentSnippet: desc,
			})
		}
		return items, nil
	}

	// Try Atom
	var atom AtomFeed
	decoder = xml.NewDecoder(bytes.NewReader(body))
	decoder.CharsetReader = charset.NewReaderLabel
	if err := decoder.Decode(&atom); err == nil && len(atom.Entries) > 0 {
		items := make([]UnifiedRssItem, 0, len(atom.Entries))
		for _, entry := range atom.Entries {
			desc := cleanDescription(entry.Summary)
			if desc == "" {
				desc = cleanDescription(entry.Content)
			}
			link := pickAtomLink(entry.Links)
			items = append(items, UnifiedRssItem{
				Title:          entry.Title,
				Link:           link,
				PubDate:        entry.Updated,
				ContentSnippet: desc,
			})
		}
		return items, nil
	}

	var rdf RdfFeed
	decoder = xml.NewDecoder(bytes.NewReader(body))
	decoder.CharsetReader = charset.NewReaderLabel
	if err := decoder.Decode(&rdf); err == nil && len(rdf.Items) > 0 {
		items := make([]UnifiedRssItem, 0, len(rdf.Items))
		for _, item := range rdf.Items {
			desc := cleanDescription(item.Description)
			items = append(items, UnifiedRssItem{
				Title:          item.Title,
				Link:           item.Link,
				PubDate:        item.Date,
				ContentSnippet: desc,
			})
		}
		return items, nil
	}

	return nil, fmt.Errorf("failed to parse feed")
}

func pickAtomLink(links []AtomLink) string {
	if len(links) == 0 {
		return ""
	}
	for _, link := range links {
		if link.Href == "" {
			continue
		}
		if link.Rel == "" || link.Rel == "alternate" {
			if link.Type == "" || strings.HasPrefix(link.Type, "text/html") {
				return link.Href
			}
		}
	}
	for _, link := range links {
		if link.Href != "" {
			return link.Href
		}
	}
	return ""
}

func cleanDescription(html string) string {
	// Simple strip tags
	// In a real app we might want a proper HTML sanitizer, but here we just strip generic tags
	// Or just return truncated text

	// Remove <![CDATA[ ... ]]> wrapper
	if strings.HasPrefix(html, "<![CDATA[") && strings.HasSuffix(html, "]]>") {
		html = html[9 : len(html)-3]
	}

	// Very basic tag stripping (naive)
	// Replace <br> with space
	html = strings.ReplaceAll(html, "<br>", " ")
	html = strings.ReplaceAll(html, "<br/>", " ")

	// Remove other tags (naive regex)
	// Note: regex in Go for HTML is not perfect but sufficient for snippets
	// Ideally use a library like bluemonday, but we avoid new deps

	// Truncate to 100 chars
	runes := []rune(html)
	if len(runes) > 100 {
		return string(runes[:100]) + "..."
	}
	return html
}
