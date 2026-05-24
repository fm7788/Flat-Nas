package middleware

import (
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/time/rate"
)

// ipRateLimiter 基于客户端 IP 的令牌桶限流器。
// 用于保护探测类接口（如 /api/ping）防止被滥用为内网扫描工具。
type ipRateLimiter struct {
	mu       sync.Mutex
	visitors map[string]*visitor
	r        rate.Limit
	b        int
	ttl      time.Duration
}

type visitor struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

func newIPRateLimiter(r rate.Limit, b int, ttl time.Duration) *ipRateLimiter {
	l := &ipRateLimiter{
		visitors: make(map[string]*visitor),
		r:        r,
		b:        b,
		ttl:      ttl,
	}
	go l.cleanup()
	return l
}

func (l *ipRateLimiter) cleanup() {
	for {
		time.Sleep(l.ttl)
		l.mu.Lock()
		now := time.Now()
		for ip, v := range l.visitors {
			if now.Sub(v.lastSeen) > l.ttl {
				delete(l.visitors, ip)
			}
		}
		l.mu.Unlock()
	}
}

func (l *ipRateLimiter) get(ip string) *rate.Limiter {
	l.mu.Lock()
	defer l.mu.Unlock()
	v, ok := l.visitors[ip]
	if !ok {
		lim := rate.NewLimiter(l.r, l.b)
		l.visitors[ip] = &visitor{limiter: lim, lastSeen: time.Now()}
		return lim
	}
	v.lastSeen = time.Now()
	return v.limiter
}

// pingLimiter 每 IP 限速：稳定速率 2 次/秒，突发上限 10 次。
// 对正常用户的延迟检测完全无感，但能有效阻断高频内网扫描。
var pingLimiter = newIPRateLimiter(rate.Limit(2), 10, 10*time.Minute)

// PingRateLimit 给探测类接口加速率限制。
func PingRateLimit() gin.HandlerFunc {
	return func(c *gin.Context) {
		ip := c.ClientIP()
		if !pingLimiter.get(ip).Allow() {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
				"success": false,
				"error":   "rate limited",
			})
			return
		}
		c.Next()
	}
}
