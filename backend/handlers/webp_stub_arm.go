//go:build arm

package handlers

func normalizeRasterToWebP(content []byte, contentType string, ext string) ([]byte, string, string, bool, error) {
	// ARM 32-bit fallback: skip WebP conversion.
	return content, contentType, ext, false, nil
}
