package handlers

import (
	"flatnasgo-backend/config"
	"flatnasgo-backend/models"
	"flatnasgo-backend/utils"
	"net/http"
	"path/filepath"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

var visitorMutex sync.Mutex

func TrackVisitor(c *gin.Context) {
	visitorMutex.Lock()
	defer visitorMutex.Unlock()

	visitorFile := filepath.Join(config.DataDir, "visitors.json")
	var stats models.VisitorStats
	if err := utils.ReadJSON(visitorFile, &stats); err != nil {
		// Initialize if not exists
		stats = models.VisitorStats{
			TotalVisitors: 0,
			TodayVisitors: 0,
			LastVisitDate: time.Now().Format("2006-01-02"),
		}
	}

	today := time.Now().Format("2006-01-02")
	if stats.LastVisitDate != today {
		stats.TodayVisitors = 0
		stats.LastVisitDate = today
	}

	stats.TotalVisitors++
	stats.TodayVisitors++

	if err := utils.WriteJSON(visitorFile, stats); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save visitor stats"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"success":       true,
		"totalVisitors": stats.TotalVisitors,
		"todayVisitors": stats.TodayVisitors,
	})
}
