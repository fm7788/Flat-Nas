//go:build !arm

package handlers

import (
	"bytes"
	"fmt"
	"image"

	"github.com/deepteams/webp"
)

func normalizeRasterToWebP(content []byte, contentType string, ext string) ([]byte, string, string, bool, error) {
	switch ext {
	case ".png", ".jpg", ".jpeg":
		// Only normalize static raster formats; keep gif/svg/ico untouched.
	default:
		return content, contentType, ext, false, nil
	}

	img, _, err := image.Decode(bytes.NewReader(content))
	if err != nil {
		return content, contentType, ext, false, err
	}

	if webPQuality < 1 {
		webPQuality = 1
	}
	if webPQuality > 100 {
		webPQuality = 100
	}

	var out bytes.Buffer
	if err := webp.Encode(&out, img, &webp.Options{
		Quality: float32(webPQuality),
	}); err != nil {
		return content, contentType, ext, false, err
	}

	normalized := out.Bytes()
	if len(normalized) == 0 {
		return content, contentType, ext, false, fmt.Errorf("empty webp output")
	}
	return normalized, "image/webp", ".webp", true, nil
}
