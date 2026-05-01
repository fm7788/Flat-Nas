package middleware

import (
	"compress/gzip"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// GzipDecompressMiddleware handles Gzip compressed request bodies
func GzipDecompressMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.Body == nil {
			c.Next()
			return
		}

		encoding := c.GetHeader("Content-Encoding")
		if strings.Contains(encoding, "gzip") {
			gzipReader, err := gzip.NewReader(c.Request.Body)
			if err != nil {
				c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "Invalid gzip body"})
				return
			}
			defer gzipReader.Close()

			c.Request.Body = http.MaxBytesReader(c.Writer, gzipReader, 100<<20) // 100MB max uncompressed
			// Remove the header so downstream handlers don't try to decompress again
			c.Request.Header.Del("Content-Encoding")
			// Update Content-Length if possible, but usually it's unknown after decompression
			c.Request.Header.Del("Content-Length")
		}

		c.Next()
	}
}
