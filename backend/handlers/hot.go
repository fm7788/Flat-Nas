package handlers

import (
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	socketio "github.com/googollee/go-socket.io"
)

type HotItem struct {
	Title string `json:"title"`
	Url   string `json:"url"`
	Hot   string `json:"hot,omitempty"`
}

var hotTTLs = map[string]time.Duration{
	"weibo":    3 * time.Minute,
	"news":     8 * time.Minute,
	"zhihu":    5 * time.Minute,
	"bilibili": 4 * time.Minute,
}

func BindHotHandlers(server *socketio.Server) {
	server.OnEvent("/", "hot:fetch", func(s socketio.Conn, msg interface{}) {
		var payload map[string]interface{}
		if m, ok := msg.(map[string]interface{}); ok {
			payload = m
		} else {
			return
		}

		t, _ := payload["type"].(string)
		force, _ := payload["force"].(bool)
		switch t {
		case "weibo", "news", "zhihu", "bilibili":
			cacheKey := buildHotCacheKey(t)
			var cached []HotItem
			hasCache, isFresh, _, err := sharedWidgetCache.Get(widgetCacheKindHot, cacheKey, &cached)
			if err == nil && hasCache && len(cached) > 0 {
				s.Emit("hot:data", map[string]interface{}{
					"type": t,
					"data": cached,
				})
			}
			if hasCache && isFresh && !force {
				return
			}
			if hasCache {
				go refreshHotAsync(server, t)
				return
			}
			items, fetchErr := refreshHotData(t)
			if fetchErr != nil || len(items) == 0 {
				s.Emit("hot:error", map[string]interface{}{
					"type":  t,
					"error": fmt.Sprintf("fetch failed: %v", fetchErr),
				})
				return
			}
			s.Emit("hot:data", map[string]interface{}{
				"type": t,
				"data": items,
			})
		default:
			s.Emit("hot:error", map[string]interface{}{
				"type":  t,
				"error": "unsupported type",
			})
		}
	})
}

func refreshHotData(t string) ([]HotItem, error) {
	var items []HotItem
	var err error
	switch t {
	case "bilibili":
		items, err = fetchBilibili()
	case "zhihu":
		items, err = fetchZhihu()
	case "weibo":
		items, err = fetchWeibo()
	case "news":
		items, err = fetchChinaNews()
	}

	if err == nil && len(items) > 0 {
		ttl := hotTTLs[t]
		if ttl <= 0 {
			ttl = 5 * time.Minute
		}
		_ = sharedWidgetCache.Set(widgetCacheKindHot, buildHotCacheKey(t), items, ttl, "ok")
		return items, nil
	}
	_ = sharedWidgetCache.MarkStatus(widgetCacheKindHot, buildHotCacheKey(t), "error")
	return nil, err
}

func refreshHotAsync(server *socketio.Server, t string) {
	tag := "hot:" + t
	if !sharedWidgetCache.StartRefresh(tag) {
		return
	}
	defer sharedWidgetCache.EndRefresh(tag)
	items, err := refreshHotData(t)
	if err != nil || len(items) == 0 {
		return
	}
	server.BroadcastToNamespace("/", "hot:data", map[string]interface{}{
		"type": t,
		"data": items,
	})
}

func refreshHotHTTP(t string) {
	tag := "hot:" + t
	if !sharedWidgetCache.StartRefresh(tag) {
		return
	}
	defer sharedWidgetCache.EndRefresh(tag)
	_, _ = refreshHotData(t)
}

func GetHot(c *gin.Context) {
	t := strings.TrimSpace(c.Query("type"))
	force := strings.EqualFold(c.Query("force"), "true") || c.Query("force") == "1"
	if _, ok := hotTTLs[t]; !ok {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "unsupported type"})
		return
	}

	cacheKey := buildHotCacheKey(t)
	var cached []HotItem
	hasCache, isFresh, _, err := sharedWidgetCache.Get(widgetCacheKindHot, cacheKey, &cached)
	if err == nil && hasCache && len(cached) > 0 && !force {
		c.JSON(http.StatusOK, gin.H{"success": true, "data": cached, "cached": true})
		if !isFresh {
			go refreshHotHTTP(t)
		}
		return
	}

	items, fetchErr := refreshHotData(t)
	if fetchErr != nil || len(items) == 0 {
		if err == nil && hasCache && len(cached) > 0 {
			c.JSON(http.StatusOK, gin.H{
				"success": true,
				"data":    cached,
				"cached":  true,
				"stale":   true,
			})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{
			"success": false,
			"error":   fmt.Sprintf("fetch failed: %v", fetchErr),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "data": items})
}

func buildHotCacheKey(t string) string {
	return strings.TrimSpace(t)
}

func WarmHotCache(types []string) {
	seen := make(map[string]struct{})
	for _, t := range types {
		normalized := strings.TrimSpace(t)
		if normalized == "" {
			continue
		}
		if _, ok := hotTTLs[normalized]; !ok {
			continue
		}
		if _, exists := seen[normalized]; exists {
			continue
		}
		seen[normalized] = struct{}{}
		if _, err := refreshHotData(normalized); err != nil {
			continue
		}
	}
}

func fetchWithHeaders(url string, headers map[string]string) ([]byte, int, error) {
	client, err := getSharedProxyClient()
	if err != nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, 0, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return body, resp.StatusCode, fmt.Errorf("status %d", resp.StatusCode)
	}
	return body, resp.StatusCode, nil
}

func fetchBilibili() ([]HotItem, error) {
	body, _, err := fetchWithHeaders(
		"https://api.bilibili.com/x/web-interface/popular?ps=30",
		map[string]string{
			"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
			"Referer":    "https://www.bilibili.com/",
			"Accept":     "application/json, text/plain, */*",
		},
	)
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Data struct {
			List []struct {
				Bvid  string `json:"bvid"`
				Title string `json:"title"`
				Stat  struct {
					View int `json:"view"`
					Danm int `json:"danmaku"`
					Like int `json:"like"`
				} `json:"stat"`
			} `json:"list"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}
	items := make([]HotItem, 0, len(parsed.Data.List))
	for _, it := range parsed.Data.List {
		link := "https://www.bilibili.com/video/" + strings.TrimSpace(it.Bvid)
		hot := fmt.Sprintf("播放 %d · 赞 %d", it.Stat.View, it.Stat.Like)
		items = append(items, HotItem{Title: it.Title, Url: link, Hot: hot})
	}
	return items, nil
}

func fetchZhihu() ([]HotItem, error) {
	body, _, err := fetchWithHeaders(
		"https://www.zhihu.com/hot",
		map[string]string{
			"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0 Mobile Safari/604.1",
			"Accept":     "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		},
	)
	if err != nil {
		return nil, err
	}
	re := regexp.MustCompile(`<script id="js-initialData" type="application/json">([\s\S]*?)</script>`)
	m := re.FindStringSubmatch(string(body))
	if len(m) < 2 {
		return nil, fmt.Errorf("initial data not found")
	}
	var initState struct {
		InitialState struct {
			Topstory struct {
				HotList []struct {
					Target struct {
						TitleArea struct {
							Text string `json:"text"`
						} `json:"titleArea"`
						MetricsArea struct {
							Text string `json:"text"`
						} `json:"metricsArea"`
						Link struct {
							Url string `json:"url"`
						} `json:"link"`
					} `json:"target"`
				} `json:"hotList"`
			} `json:"topstory"`
		} `json:"initialState"`
	}
	if err := json.Unmarshal([]byte(m[1]), &initState); err != nil {
		return nil, err
	}
	items := make([]HotItem, 0, len(initState.InitialState.Topstory.HotList))
	for _, v := range initState.InitialState.Topstory.HotList {
		title := v.Target.TitleArea.Text
		hot := v.Target.MetricsArea.Text
		link := v.Target.Link.Url
		if link == "" {
			continue
		}
		items = append(items, HotItem{Title: title, Url: link, Hot: hot})
	}
	return items, nil
}

func buildWeiboLink(wordScheme, word, link string) string {
	if strings.HasPrefix(link, "http://") || strings.HasPrefix(link, "https://") {
		return link
	}
	scheme := strings.TrimSpace(wordScheme)
	if scheme != "" {
		if strings.HasPrefix(scheme, "http://") || strings.HasPrefix(scheme, "https://") {
			return scheme
		}
		scheme = strings.TrimPrefix(scheme, "?")
		if strings.Contains(scheme, "q=") || strings.Contains(scheme, "%23") || strings.Contains(scheme, "&") {
			return "https://s.weibo.com/weibo?" + scheme
		}
		return "https://s.weibo.com/weibo?q=" + url.QueryEscape(scheme)
	}
	kw := strings.TrimSpace(word)
	if kw != "" {
		return "https://s.weibo.com/weibo?q=" + url.QueryEscape(kw)
	}
	return "https://s.weibo.com"
}

func fetchWeiboFallback() ([]HotItem, error) {
	body, _, err := fetchWithHeaders(
		"https://weibo.com/ajax/side/hotSearch?type=base&pos=0",
		map[string]string{
			"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
			"Referer":    "https://weibo.com/",
			"Accept":     "application/json, text/plain, */*",
		},
	)
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Data struct {
			Realtime []struct {
				Word       string  `json:"word"`
				Note       string  `json:"note"`
				Num        float64 `json:"num"`
				RawHot     float64 `json:"raw_hot"`
				WordScheme string  `json:"word_scheme"`
				Link       string  `json:"link"`
			} `json:"realtime"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}
	items := make([]HotItem, 0, len(parsed.Data.Realtime))
	for _, v := range parsed.Data.Realtime {
		title := strings.TrimSpace(v.Word)
		if title == "" {
			title = strings.TrimSpace(v.Note)
		}
		if title == "" {
			continue
		}
		hot := ""
		if v.RawHot > 0 {
			hot = fmt.Sprintf("%.0f", v.RawHot)
		} else if v.Num > 0 {
			hot = fmt.Sprintf("%.0f万", v.Num)
		}
		link := buildWeiboLink(v.WordScheme, title, v.Link)
		items = append(items, HotItem{Title: title, Url: link, Hot: hot})
	}
	return items, nil
}

func fetchWeibo() ([]HotItem, error) {
	body, _, err := fetchWithHeaders(
		"https://weibo.com/ajax/statuses/hot_band",
		map[string]string{
			"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
			"Referer":    "https://weibo.com/",
			"Accept":     "application/json, text/plain, */*",
		},
	)
	if err != nil {
		return fetchWeiboFallback()
	}
	var parsed struct {
		Data struct {
			BandList []struct {
				Note       string  `json:"note"`
				Num        float64 `json:"num"`
				WordScheme string  `json:"word_scheme"`
			} `json:"band_list"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}
	items := make([]HotItem, 0, len(parsed.Data.BandList))
	for _, v := range parsed.Data.BandList {
		title := v.Note
		hot := ""
		if v.Num > 0 {
			hot = fmt.Sprintf("%.0f万", v.Num)
		}
		link := buildWeiboLink(v.WordScheme, title, "")
		items = append(items, HotItem{Title: title, Url: link, Hot: hot})
	}
	if len(items) == 0 {
		return fetchWeiboFallback()
	}
	return items, nil
}

func fetchChinaNews() ([]HotItem, error) {
	type rssItem struct {
		Title string `xml:"title"`
		Link  string `xml:"link"`
	}
	type rss struct {
		Items []rssItem `xml:"channel>item"`
	}
	body, _, err := fetchWithHeaders(
		"https://www.chinanews.com/rss/scroll-news.xml",
		map[string]string{
			"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
			"Accept":     "application/xml, text/xml, */*;q=0.8",
		},
	)
	if err != nil {
		return nil, err
	}
	var r rss
	if err := xml.Unmarshal(body, &r); err != nil {
		return nil, err
	}
	items := make([]HotItem, 0, len(r.Items))
	for _, it := range r.Items {
		items = append(items, HotItem{Title: it.Title, Url: it.Link})
	}
	return items, nil
}
