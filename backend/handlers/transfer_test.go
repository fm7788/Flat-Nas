package handlers

import "testing"

func TestIsValidUploadID(t *testing.T) {
	cases := []struct {
		value string
		ok    bool
	}{
		{"abcdef", true},
		{"ABCDEF0123", true},
		{"", false},
		{"xyz", false},
		{"123g", false},
	}

	for _, c := range cases {
		if isValidUploadID(c.value) != c.ok {
			t.Fatalf("value=%q expected %v", c.value, c.ok)
		}
	}
}
